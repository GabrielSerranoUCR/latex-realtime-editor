//! Version history: automatic and named snapshots of a scroll, reading them back, and restoring.

use std::{collections::BTreeMap, time::Duration};

use anyhow::{Context, Result};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
use yrs::{Doc, GetString, Map, Out, Text, TextPrelim, Transact, Update, updates::decoder::Decode};

use crate::{AppState, auth::AuthUser, error::AppError, scrolls::require_role};

/// Automatic versions kept per scroll; named ones are never pruned.
const KEEP_AUTO: i64 = 100;

/// Insert a version row; returns its id.
pub async fn insert(db: &PgPool, scroll: Uuid, by: Option<Uuid>, label: Option<&str>, auto: bool, bytes: &[u8]) -> Result<Uuid> {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO scroll_versions (id, scroll_id, created_by, label, auto, sha256, snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(id)
        .bind(scroll)
        .bind(by)
        .bind(label)
        .bind(auto)
        .bind(Sha256::digest(bytes).to_vec())
        .bind(bytes)
        .execute(db)
        .await
        .context("saving version")?;
    Ok(id)
}

/// Called whenever a document is saved: take an automatic version if the content changed and
/// the last one is old enough.
pub async fn maybe_auto_snapshot(db: &PgPool, scroll: Uuid, bytes: &[u8], interval: Duration) -> Result<()> {
    let last: Option<(Vec<u8>, DateTime<Utc>)> = sqlx::query_as("SELECT sha256, created_at FROM scroll_versions WHERE scroll_id = $1 ORDER BY created_at DESC LIMIT 1").bind(scroll).fetch_optional(db).await?;
    let hash = Sha256::digest(bytes).to_vec();
    let due = match &last {
        None => true,
        Some((h, at)) => *h != hash && (Utc::now() - *at).to_std().map(|age| age >= interval).unwrap_or(false),
    };
    if !due {
        return Ok(());
    }
    insert(db, scroll, None, None, true, bytes).await?;
    sqlx::query("DELETE FROM scroll_versions WHERE scroll_id = $1 AND auto AND id NOT IN (SELECT id FROM scroll_versions WHERE scroll_id = $1 AND auto ORDER BY created_at DESC LIMIT $2)")
        .bind(scroll)
        .bind(KEEP_AUTO)
        .execute(db)
        .await?;
    Ok(())
}

/// The text files stored in a snapshot.
pub fn read_files(bytes: &[u8]) -> Result<BTreeMap<String, String>> {
    let doc = Doc::new();
    doc.transact_mut().apply_update(Update::decode_v1(bytes).context("decoding version")?).context("applying version")?;
    let files = doc.get_or_insert_map("files");
    let txn = doc.transact();
    let mut out = BTreeMap::new();
    for (name, value) in files.iter(&txn) {
        if let Out::YText(t) = value {
            out.insert(name.to_string(), t.get_string(&txn));
        }
    }
    Ok(out)
}

fn common_prefix(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(x, y)| x == y).map(|(x, _)| x.len_utf8()).sum()
}
fn common_suffix(a: &str, b: &str) -> usize {
    a.chars().rev().zip(b.chars().rev()).take_while(|(x, y)| x == y).map(|(x, _)| x.len_utf8()).sum()
}

/// Make the live document's text files equal `target`, changing only what differs (so other
/// scribes' cursors outside the changed region survive).
pub fn replace_files(doc: &Doc, target: &BTreeMap<String, String>) {
    let files = doc.get_or_insert_map("files");
    let mut txn = doc.transact_mut();
    let existing: Vec<String> = files.keys(&txn).map(String::from).collect();
    for name in existing {
        if !target.contains_key(&name) {
            files.remove(&mut txn, &name);
        }
    }
    for (name, wanted) in target {
        set_file(&files, &mut txn, name, wanted);
    }
}

/// Make one file read `wanted`: created if it is new, otherwise changed by the smallest edit that does it (so
/// the cursors of people editing it stay where they were).
pub fn set_file(files: &yrs::MapRef, txn: &mut yrs::TransactionMut, name: &str, wanted: &str) {
    match files.get(txn, name) {
        Some(Out::YText(text)) => {
            let current = text.get_string(txn);
            if current == wanted {
                return;
            }
            let prefix = common_prefix(&current, wanted);
            let suffix = common_suffix(&current[prefix..], &wanted[prefix..]);
            let remove = current.len() - prefix - suffix;
            if remove > 0 {
                text.remove_range(txn, prefix as u32, remove as u32);
            }
            let insert = &wanted[prefix..wanted.len() - suffix];
            if !insert.is_empty() {
                text.insert(txn, prefix as u32, insert);
            }
        }
        _ => {
            files.insert(txn, name, TextPrelim::new(wanted));
        }
    }
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub id: Uuid,
    pub label: Option<String>,
    pub auto: bool,
    pub created_at: DateTime<Utc>,
    pub author_id: Option<Uuid>,
    pub author_name: Option<String>,
}

const INFO_SQL: &str = "SELECT v.id, v.label, v.auto, v.created_at, v.created_by AS author_id, u.display_name AS author_name FROM scroll_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.scroll_id = $1";

pub async fn list(State(state): State<AppState>, user: AuthUser, Path(id): Path<Uuid>) -> Result<Json<Vec<VersionInfo>>, AppError> {
    require_role(&state.db, id, user.id).await?;
    // make sure the newest edits are in the history before it is shown
    Ok(Json(sqlx::query_as::<_, VersionInfo>(sqlx::AssertSqlSafe(format!("{INFO_SQL} ORDER BY v.created_at DESC LIMIT 200"))).bind(id).fetch_all(&state.db).await?))
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    pub label: Option<String>,
}

/// Name the current state ("Draft v1 for review"); scribes and the owner.
pub async fn create(State(state): State<AppState>, user: AuthUser, Path(id): Path<Uuid>, Json(body): Json<CreateBody>) -> Result<(StatusCode, Json<VersionInfo>), AppError> {
    if !require_role(&state.db, id, user.id).await?.can_write() {
        return Err(AppError::Forbidden);
    }
    let label = body.label.as_deref().map(str::trim).filter(|l| !l.is_empty());
    if label.is_some_and(|l| l.chars().count() > 80) {
        return Err(AppError::BadRequest("Version names are limited to 80 characters.".into()));
    }
    let bytes = state.rooms.snapshot_of(&id.to_string()).await?;
    let version = insert(&state.db, id, Some(user.id), Some(label.unwrap_or("Saved version")), false, &bytes).await?;
    let info = sqlx::query_as::<_, VersionInfo>(sqlx::AssertSqlSafe(format!("{INFO_SQL} AND v.id = $2"))).bind(id).bind(version).fetch_one(&state.db).await?;
    Ok((StatusCode::CREATED, Json(info)))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionDetail {
    #[serde(flatten)]
    pub info: VersionInfo,
    pub files: BTreeMap<String, String>,
}

async fn load_snapshot(state: &AppState, scroll: Uuid, version: Uuid) -> Result<Vec<u8>, AppError> {
    sqlx::query_scalar("SELECT snapshot FROM scroll_versions WHERE id = $1 AND scroll_id = $2").bind(version).bind(scroll).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)
}

/// A version's text files, so the client can diff them against the present.
pub async fn get(State(state): State<AppState>, user: AuthUser, Path((id, vid)): Path<(Uuid, Uuid)>) -> Result<Json<VersionDetail>, AppError> {
    require_role(&state.db, id, user.id).await?;
    let info = sqlx::query_as::<_, VersionInfo>(sqlx::AssertSqlSafe(format!("{INFO_SQL} AND v.id = $2"))).bind(id).bind(vid).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    let files = read_files(&load_snapshot(&state, id, vid).await?)?;
    Ok(Json(VersionDetail { info, files }))
}

/// Restore: first keep the present as its own version (so restoring is undoable), then rewrite
/// the live document to match the chosen one.
pub async fn restore(State(state): State<AppState>, user: AuthUser, Path((id, vid)): Path<(Uuid, Uuid)>) -> Result<StatusCode, AppError> {
    if !require_role(&state.db, id, user.id).await?.can_write() {
        return Err(AppError::Forbidden);
    }
    let target = read_files(&load_snapshot(&state, id, vid).await?)?;
    let room = id.to_string();
    let before = state.rooms.snapshot_of(&room).await?;
    insert(&state.db, id, Some(user.id), Some("Before restoring an earlier version"), false, &before).await?;
    state.rooms.mutate(&room, |doc| replace_files(doc, &target)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Give an existing snapshot a name. That also keeps it: only unnamed automatic snapshots are pruned.
pub async fn rename(State(state): State<AppState>, user: AuthUser, Path((id, vid)): Path<(Uuid, Uuid)>, Json(body): Json<CreateBody>) -> Result<Json<VersionInfo>, AppError> {
    if !require_role(&state.db, id, user.id).await?.can_write() {
        return Err(AppError::Forbidden);
    }
    let label = body.label.as_deref().map(str::trim).filter(|l| !l.is_empty()).ok_or_else(|| AppError::BadRequest("Give the version a name.".into()))?;
    if label.chars().count() > 80 {
        return Err(AppError::BadRequest("Version names are limited to 80 characters.".into()));
    }
    let done = sqlx::query("UPDATE scroll_versions SET label = $3, auto = FALSE WHERE id = $2 AND scroll_id = $1").bind(id).bind(vid).bind(label).execute(&state.db).await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(sqlx::query_as::<_, VersionInfo>(sqlx::AssertSqlSafe(format!("{INFO_SQL} AND v.id = $2"))).bind(id).bind(vid).fetch_one(&state.db).await?))
}

pub async fn delete(State(state): State<AppState>, user: AuthUser, Path((id, vid)): Path<(Uuid, Uuid)>) -> Result<StatusCode, AppError> {
    if !require_role(&state.db, id, user.id).await?.can_manage() {
        return Err(AppError::Forbidden);
    }
    sqlx::query("DELETE FROM scroll_versions WHERE id = $1 AND scroll_id = $2").bind(vid).bind(id).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::ReadTxn;

    fn doc_with(files: &[(&str, &str)]) -> Doc {
        let doc = Doc::new();
        let map = doc.get_or_insert_map("files");
        let mut txn = doc.transact_mut();
        for (n, t) in files {
            map.insert(&mut txn, *n, TextPrelim::new(*t));
        }
        drop(txn);
        doc
    }
    fn snapshot(doc: &Doc) -> Vec<u8> {
        doc.transact().encode_state_as_update_v1(&yrs::StateVector::default())
    }

    #[test]
    fn snapshots_round_trip_to_files() {
        let files = read_files(&snapshot(&doc_with(&[("main.tex", "hello"), ("a/b.tex", "über")]))).unwrap();
        assert_eq!(files.get("main.tex").map(String::as_str), Some("hello"));
        assert_eq!(files.get("a/b.tex").map(String::as_str), Some("über"));
    }

    #[test]
    fn replace_edits_in_place_and_handles_unicode() {
        let doc = doc_with(&[("main.tex", "The quick brown fox — über"), ("gone.tex", "x")]);
        let target: BTreeMap<String, String> = [("main.tex".to_string(), "The slow brown fox — über!".to_string()), ("new.tex".to_string(), "fresh".to_string())].into();
        replace_files(&doc, &target);
        assert_eq!(read_files(&snapshot(&doc)).unwrap(), target);
    }

    #[test]
    fn prefix_suffix_are_char_aligned() {
        assert_eq!(common_prefix("añb", "añc"), "añ".len());
        assert_eq!(common_suffix("xéy", "zéy"), "éy".len());
        assert_eq!(common_prefix("", "abc"), 0);
    }
}
