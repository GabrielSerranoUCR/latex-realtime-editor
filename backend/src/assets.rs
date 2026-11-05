//! Binary project files (images, PDFs): uploaded over HTTP, listed live through the Yjs `assets`
//! map, and copied next to the sources when compiling.

use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use uuid::Uuid;
use yrs::{Any, Map, Out, Transact};

use crate::{AppState, auth::AuthUser, error::AppError, scrolls::require_role};

/// Extensions we accept, with their content types. Anything else is refused.
const ALLOWED: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
    ("pdf", "application/pdf"),
    ("eps", "application/postscript"),
];

/// Validate a project-relative asset path; returns it normalised plus its content type.
pub fn clean_path(raw: &str) -> Result<(String, &'static str), AppError> {
    let bad = |m: &str| AppError::BadRequest(m.to_string());
    let path = raw.trim_matches('/');
    if path.is_empty() || path.len() > 200 {
        return Err(bad("Give the file a name of up to 200 characters."));
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() > 6 || segments.iter().any(|s| s.is_empty() || *s == "." || *s == ".." || !s.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '-' | ' '))) {
        return Err(bad("File names may only use letters, numbers, spaces, `_`, `-` and `.`, in at most 6 folders."));
    }
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    let mime = ALLOWED.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m).ok_or_else(|| bad("That file type is not supported (png, jpg, gif, webp, svg, pdf, eps)."))?;
    Ok((path.to_string(), mime))
}

/// Cheap content check so a renamed executable cannot pose as an image.
fn looks_like(mime: &str, b: &[u8]) -> bool {
    match mime {
        "image/png" => b.starts_with(&[0x89, b'P', b'N', b'G']),
        "image/jpeg" => b.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/gif" => b.starts_with(b"GIF8"),
        "image/webp" => b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP",
        "application/pdf" => b.windows(5).take(1024).any(|w| w == b"%PDF-"),
        "application/postscript" => b.starts_with(b"%!PS") || b.starts_with(&[0xC5, 0xD0, 0xD3, 0xC6]),
        "image/svg+xml" => std::str::from_utf8(b).map(|t| t.trim_start().starts_with('<')).unwrap_or(false),
        _ => false,
    }
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub path: String,
    pub size: i64,
    pub mime: String,
    pub sha256: String,
}

fn publish(info: &AssetInfo) -> Any {
    Any::from_json(&serde_json::json!({ "size": info.size, "mime": info.mime, "sha256": info.sha256 }).to_string()).expect("valid json")
}

pub async fn list(State(state): State<AppState>, user: AuthUser, Path(id): Path<Uuid>) -> Result<Json<Vec<AssetInfo>>, AppError> {
    require_role(&state.db, id, user.id).await?;
    Ok(Json(sqlx::query_as::<_, AssetInfo>("SELECT path, size, mime, sha256 FROM scroll_assets WHERE scroll_id = $1 ORDER BY path").bind(id).fetch_all(&state.db).await?))
}

/// `PUT /api/scrolls/{id}/assets/{*path}` — raw bytes in the body (scribes and the owner).
pub async fn put(State(state): State<AppState>, user: AuthUser, Path((id, raw)): Path<(Uuid, String)>, body: Bytes) -> Result<Json<AssetInfo>, AppError> {
    if !require_role(&state.db, id, user.id).await?.can_write() {
        return Err(AppError::Forbidden);
    }
    let (path, mime) = clean_path(&raw)?;
    if body.is_empty() {
        return Err(AppError::BadRequest("That file is empty.".into()));
    }
    if body.len() > state.config.max_asset_bytes {
        return Err(AppError::TooLarge(format!("Files are limited to {} MB.", state.config.max_asset_bytes / 1024 / 1024)));
    }
    if !looks_like(mime, &body) {
        return Err(AppError::BadRequest("The contents do not match the file type.".into()));
    }
    let used: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(size), 0)::BIGINT FROM scroll_assets WHERE scroll_id = $1 AND path <> $2").bind(id).bind(&path).fetch_one(&state.db).await?;
    if used + body.len() as i64 > state.config.asset_quota_bytes {
        return Err(AppError::TooLarge("This scroll has used up its space for images and PDFs.".into()));
    }
    let room = id.to_string();
    // a text file and an asset cannot share a name
    let doc = state.rooms.doc(&room).await?;
    let clash = {
        let files = doc.get_or_insert_map("files");
        let txn = doc.transact();
        matches!(files.get(&txn, &path), Some(Out::YText(_)))
    };
    if clash {
        return Err(AppError::Conflict("A text file already uses that name.".into()));
    }

    let info = AssetInfo { path: path.clone(), size: body.len() as i64, mime: mime.into(), sha256: hex::encode(Sha256::digest(&body)) };
    state.store.save_asset(&room, &path, &body).await.map_err(anyhow::Error::from)?;
    sqlx::query("INSERT INTO scroll_assets (scroll_id, path, size, mime, sha256) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (scroll_id, path) DO UPDATE SET size = EXCLUDED.size, mime = EXCLUDED.mime, sha256 = EXCLUDED.sha256, created_at = now()")
        .bind(id)
        .bind(&path)
        .bind(info.size)
        .bind(&info.mime)
        .bind(&info.sha256)
        .execute(&state.db)
        .await?;
    let any = publish(&info);
    state
        .rooms
        .mutate(&room, |doc| {
            let assets = doc.get_or_insert_map("assets");
            let mut txn = doc.transact_mut();
            assets.insert(&mut txn, path.as_str(), any);
        })
        .await?;
    Ok(Json(info))
}

/// Served with a locked-down policy: an uploaded SVG must never run script if opened directly.
pub async fn get(State(state): State<AppState>, user: AuthUser, Path((id, raw)): Path<(Uuid, String)>) -> Result<Response, AppError> {
    require_role(&state.db, id, user.id).await?;
    let (path, _) = clean_path(&raw)?;
    let info = sqlx::query_as::<_, AssetInfo>("SELECT path, size, mime, sha256 FROM scroll_assets WHERE scroll_id = $1 AND path = $2").bind(id).bind(&path).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    let bytes = state.store.load_asset(&id.to_string(), &path).await.map_err(anyhow::Error::from)?.ok_or(AppError::NotFound)?;
    let h = |v: &'static str| HeaderValue::from_static(v);
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_str(&info.mime).unwrap_or_else(|_| h("application/octet-stream"))),
            (header::X_CONTENT_TYPE_OPTIONS, h("nosniff")),
            (header::CONTENT_SECURITY_POLICY, h("default-src 'none'; style-src 'unsafe-inline'; sandbox")),
            (header::CACHE_CONTROL, h("private, no-cache")),
            (header::ETAG, HeaderValue::from_str(&format!("\"{}\"", info.sha256)).unwrap_or_else(|_| h("\"\""))),
        ],
        bytes,
    )
        .into_response())
}

#[derive(Debug, Deserialize)]
pub struct RelocateRequest {
    from: String,
    to: String,
    /// Keep the original (a copy) instead of moving it.
    #[serde(default)]
    copy: bool,
}

/// `POST /api/scrolls/{id}/asset-moves` — rename, move to another table (folder) or duplicate an asset
/// without its bytes ever leaving the server. The new path is reserved first (the database refuses a
/// name that is taken), then the file moves, then the old name is retired and the live `assets` map updated.
pub async fn relocate(State(state): State<AppState>, user: AuthUser, Path(id): Path<Uuid>, Json(req): Json<RelocateRequest>) -> Result<Json<AssetInfo>, AppError> {
    if !require_role(&state.db, id, user.id).await?.can_write() {
        return Err(AppError::Forbidden);
    }
    let (from, from_mime) = clean_path(&req.from)?;
    let (to, to_mime) = clean_path(&req.to)?;
    if from_mime != to_mime || from.rsplit('.').next().map(str::to_lowercase) != to.rsplit('.').next().map(str::to_lowercase) {
        return Err(AppError::BadRequest("Keep the file's ending: an image cannot change its type by moving.".into()));
    }
    let source = sqlx::query_as::<_, AssetInfo>("SELECT path, size, mime, sha256 FROM scroll_assets WHERE scroll_id = $1 AND path = $2").bind(id).bind(&from).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    if from == to {
        return Ok(Json(source));
    }
    let room = id.to_string();
    if req.copy {
        let used: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(size), 0)::BIGINT FROM scroll_assets WHERE scroll_id = $1").bind(id).fetch_one(&state.db).await?;
        if used + source.size > state.config.asset_quota_bytes {
            return Err(AppError::TooLarge("This scroll has used up its space for images and PDFs.".into()));
        }
    }
    // a text file and an asset cannot share a name
    let doc = state.rooms.doc(&room).await?;
    let clash = {
        let files = doc.get_or_insert_map("files");
        let txn = doc.transact();
        matches!(files.get(&txn, &to), Some(Out::YText(_)))
    };
    if clash {
        return Err(AppError::Conflict("A text file already uses that name.".into()));
    }
    // reserve the new name; the primary key refuses it if somebody else holds it
    let reserved = sqlx::query("INSERT INTO scroll_assets (scroll_id, path, size, mime, sha256) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (scroll_id, path) DO NOTHING")
        .bind(id)
        .bind(&to)
        .bind(source.size)
        .bind(&source.mime)
        .bind(&source.sha256)
        .execute(&state.db)
        .await?;
    if reserved.rows_affected() == 0 {
        return Err(AppError::Conflict("A file with that name is already here.".into()));
    }
    if let Err(e) = state.store.move_asset(&room, &from, &to, req.copy).await {
        let _ = sqlx::query("DELETE FROM scroll_assets WHERE scroll_id = $1 AND path = $2").bind(id).bind(&to).execute(&state.db).await;
        return Err(anyhow::Error::from(e).into());
    }
    if !req.copy {
        sqlx::query("DELETE FROM scroll_assets WHERE scroll_id = $1 AND path = $2").bind(id).bind(&from).execute(&state.db).await?;
    }
    let moved = AssetInfo { path: to.clone(), size: source.size, mime: source.mime.clone(), sha256: source.sha256.clone() };
    let any = publish(&moved);
    let (add, drop_old) = (to.clone(), (!req.copy).then(|| from.clone()));
    state
        .rooms
        .mutate(&room, |doc| {
            let assets = doc.get_or_insert_map("assets");
            let mut txn = doc.transact_mut();
            assets.insert(&mut txn, add.as_str(), any);
            if let Some(old) = drop_old {
                assets.remove(&mut txn, &old);
            }
        })
        .await?;
    Ok(Json(moved))
}

pub async fn remove(State(state): State<AppState>, user: AuthUser, Path((id, raw)): Path<(Uuid, String)>) -> Result<axum::http::StatusCode, AppError> {
    if !require_role(&state.db, id, user.id).await?.can_write() {
        return Err(AppError::Forbidden);
    }
    let (path, _) = clean_path(&raw)?;
    let gone = sqlx::query("DELETE FROM scroll_assets WHERE scroll_id = $1 AND path = $2").bind(id).bind(&path).execute(&state.db).await?;
    if gone.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    let room = id.to_string();
    state.store.remove_asset(&room, &path).await;
    state
        .rooms
        .mutate(&room, |doc| {
            let assets = doc.get_or_insert_map("assets");
            let mut txn = doc.transact_mut();
            assets.remove(&mut txn, &path);
        })
        .await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_validated() {
        assert_eq!(clean_path("figures/Orbit 1.PNG").unwrap(), ("figures/Orbit 1.PNG".to_string(), "image/png"));
        assert_eq!(clean_path("/a.pdf/").unwrap().1, "application/pdf");
        for bad in ["", "../x.png", "a/../b.png", "a//b.png", "x.exe", "noext", "a/b/c/d/e/f/g.png", "we\\ird.png", "a\u{0}.png", ".png.sh"] {
            assert!(clean_path(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn content_must_match_type() {
        assert!(looks_like("image/png", &[0x89, b'P', b'N', b'G', 0, 0]));
        assert!(!looks_like("image/png", b"MZ\x90\x00 definitely an exe"));
        assert!(looks_like("image/svg+xml", b"  <svg xmlns='x'/>"));
        assert!(!looks_like("image/svg+xml", b"#!/bin/sh"));
        assert!(looks_like("application/pdf", b"%PDF-1.7\n..."));
    }
}
