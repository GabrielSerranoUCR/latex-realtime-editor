//! Edits from an assistant's access token, held for a person to accept (the scroll's "review" mode), and the
//! owner's switch between reviewing each edit and letting them apply at once ("auto").
//! Only a signed-in browser can accept, reject or change the mode: an assistant can never approve itself.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;
use yrs::{Map, Transact};

use crate::{
    AppState,
    auth::{AuthUser, SessionUser},
    docs::{Change, apply},
    error::AppError,
    scrolls::require_role,
};

const MAX_NOTE_CHARS: usize = 300;
/// How much of a whole-file proposal is sent in lists (the full text is applied when it is accepted).
const PREVIEW_CHARS: usize = 20_000;

/// Keep a proposal for later. Returns its id.
pub async fn create(state: &AppState, scroll: Uuid, user: Uuid, token_name: &str, change: &Change, note: &str) -> Result<Uuid, AppError> {
    let note: String = note.trim().chars().take(MAX_NOTE_CHARS).collect();
    let id = Uuid::new_v4();
    let (kind, path, old, new, all, content) = match change {
        Change::Write { path, content } => ("write", path, None, None, false, Some(content.as_str())),
        Change::Edit { path, old, new, all } => ("edit", path, Some(old.as_str()), Some(new.as_str()), *all, None),
        Change::Delete { path } => ("delete", path, None, None, false, None),
    };
    sqlx::query("INSERT INTO edit_proposals (id, scroll_id, user_id, token_name, kind, path, old_text, new_text, replace_all, content, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)")
        .bind(id)
        .bind(scroll)
        .bind(user)
        .bind(token_name)
        .bind(kind)
        .bind(path)
        .bind(old)
        .bind(new)
        .bind(all)
        .bind(content)
        .bind(&note)
        .execute(&state.db)
        .await?;
    sync_pending(state, scroll).await?;
    Ok(id)
}

/// Tell everyone who has the scroll open how many edits are waiting (it rides on the shared document's `meta`).
async fn sync_pending(state: &AppState, scroll: Uuid) -> Result<(), AppError> {
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM edit_proposals WHERE scroll_id = $1 AND status = 'pending'").bind(scroll).fetch_one(&state.db).await?;
    state
        .rooms
        .mutate(&scroll.to_string(), |doc| {
            let meta = doc.get_or_insert_map("meta");
            let mut txn = doc.transact_mut();
            meta.insert(&mut txn, "pendingEdits", n as f64);
        })
        .await?;
    Ok(())
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: Uuid,
    pub kind: String,
    pub path: String,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub replace_all: bool,
    /// The new text of a whole-file write (cut short in lists).
    pub content: Option<String>,
    pub note: String,
    pub token_name: String,
    pub by: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub decided_at: Option<DateTime<Utc>>,
}

const SELECT: &str = "SELECT p.id, p.kind, p.path, p.old_text, p.new_text, p.replace_all, p.content, p.note, p.token_name, u.display_name AS by, p.status, p.created_at, p.decided_at
                        FROM edit_proposals p JOIN users u ON u.id = p.user_id";

fn shorten(mut p: Proposal) -> Proposal {
    if let Some(c) = &p.content {
        if c.chars().count() > PREVIEW_CHARS {
            p.content = Some(c.chars().take(PREVIEW_CHARS).collect::<String>() + "\n…");
        }
    }
    p
}

/// `GET /api/scrolls/{id}/proposals`: the edits waiting for a decision, oldest first.
pub async fn list(State(state): State<AppState>, user: AuthUser, Path(scroll): Path<Uuid>) -> Result<Json<Vec<Proposal>>, AppError> {
    require_role(&state.db, scroll, user.id).await?;
    let rows = sqlx::query_as::<_, Proposal>(sqlx::AssertSqlSafe(format!("{SELECT} WHERE p.scroll_id = $1 AND p.status = 'pending' ORDER BY p.created_at"))).bind(scroll).fetch_all(&state.db).await?;
    Ok(Json(rows.into_iter().map(shorten).collect()))
}

/// `GET /api/scrolls/{id}/proposals/{pid}`: how one stands (an assistant can ask whether its edit was accepted).
pub async fn get(State(state): State<AppState>, user: AuthUser, Path((scroll, pid)): Path<(Uuid, Uuid)>) -> Result<Json<Proposal>, AppError> {
    require_role(&state.db, scroll, user.id).await?;
    let row = sqlx::query_as::<_, Proposal>(sqlx::AssertSqlSafe(format!("{SELECT} WHERE p.scroll_id = $1 AND p.id = $2"))).bind(scroll).bind(pid).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    Ok(Json(shorten(row)))
}

#[derive(FromRow)]
struct Stored {
    kind: String,
    path: String,
    old_text: Option<String>,
    new_text: Option<String>,
    replace_all: bool,
    content: Option<String>,
}

impl Stored {
    fn into_change(self) -> Change {
        match self.kind.as_str() {
            "write" => Change::Write { path: self.path, content: self.content.unwrap_or_default() },
            "edit" => Change::Edit { path: self.path, old: self.old_text.unwrap_or_default(), new: self.new_text.unwrap_or_default(), all: self.replace_all },
            _ => Change::Delete { path: self.path },
        }
    }
}

async fn load_pending(state: &AppState, scroll: Uuid, pid: Uuid) -> Result<Stored, AppError> {
    sqlx::query_as::<_, Stored>("SELECT kind, path, old_text, new_text, replace_all, content FROM edit_proposals WHERE scroll_id = $1 AND id = $2 AND status = 'pending'")
        .bind(scroll)
        .bind(pid)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)
}

async fn decide(state: &AppState, scroll: Uuid, pid: Uuid, by: Uuid, status: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE edit_proposals SET status = $3, decided_at = now(), decided_by = $4 WHERE scroll_id = $1 AND id = $2 AND status = 'pending'").bind(scroll).bind(pid).bind(status).bind(by).execute(&state.db).await?;
    sync_pending(state, scroll).await
}

/// `POST /api/scrolls/{id}/proposals/{pid}/accept`: make the edit now. If the text has changed since and the edit
/// no longer fits, nothing is changed and the reason is returned (the proposal stays, to be rejected).
pub async fn accept(State(state): State<AppState>, SessionUser(user): SessionUser, Path((scroll, pid)): Path<(Uuid, Uuid)>) -> Result<StatusCode, AppError> {
    if !require_role(&state.db, scroll, user.id).await?.can_write() {
        return Err(AppError::Forbidden);
    }
    let change = load_pending(&state, scroll, pid).await?.into_change();
    apply(&state, scroll, &change).await.map_err(|e| match e {
        AppError::Conflict(m) | AppError::BadRequest(m) => AppError::Conflict(format!("This edit no longer fits the scroll: {m}")),
        other => other,
    })?;
    decide(&state, scroll, pid, user.id, "accepted").await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/scrolls/{id}/proposals/{pid}/reject`
pub async fn reject(State(state): State<AppState>, SessionUser(user): SessionUser, Path((scroll, pid)): Path<(Uuid, Uuid)>) -> Result<StatusCode, AppError> {
    if !require_role(&state.db, scroll, user.id).await?.can_write() {
        return Err(AppError::Forbidden);
    }
    load_pending(&state, scroll, pid).await?;
    decide(&state, scroll, pid, user.id, "rejected").await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct ModeBody {
    pub mode: String,
}

/// `PUT /api/scrolls/{id}/ai-mode`: only the scroll's owner may let assistants' edits apply without review.
pub async fn set_mode(State(state): State<AppState>, SessionUser(user): SessionUser, Path(scroll): Path<Uuid>, Json(body): Json<ModeBody>) -> Result<StatusCode, AppError> {
    if !require_role(&state.db, scroll, user.id).await?.can_manage() {
        return Err(AppError::Forbidden);
    }
    if body.mode != "review" && body.mode != "auto" {
        return Err(AppError::BadRequest("The mode is `review` or `auto`.".into()));
    }
    sqlx::query("UPDATE scrolls SET ai_edit_mode = $2 WHERE id = $1").bind(scroll).bind(&body.mode).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}
