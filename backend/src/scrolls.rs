//! Scrolls (documents), their members, and the role checks every other endpoint relies on.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::{AppState, auth::{AuthUser, ViaToken}, error::AppError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Scribe,
    Reader,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "owner" => Some(Role::Owner),
            "scribe" => Some(Role::Scribe),
            "reader" => Some(Role::Reader),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Scribe => "scribe",
            Role::Reader => "reader",
        }
    }
    /// May change the document.
    pub fn can_write(self) -> bool {
        matches!(self, Role::Owner | Role::Scribe)
    }
    /// May run the compiler (it costs server time).
    pub fn can_compile(self) -> bool {
        self.can_write()
    }
    pub fn can_manage(self) -> bool {
        self == Role::Owner
    }
}

/// The caller's role on a scroll, or `None` if they are not a member (or it is in the cellar).
pub async fn role_of(db: &PgPool, scroll_id: Uuid, user_id: Uuid) -> Result<Option<Role>, AppError> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT m.role FROM scroll_members m JOIN scrolls s ON s.id = m.scroll_id
          WHERE m.scroll_id = $1 AND m.user_id = $2 AND s.deleted_at IS NULL",
    )
    .bind(scroll_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(role.as_deref().and_then(Role::parse))
}

/// Non-members get `NotFound` (not `Forbidden`) so scroll ids cannot be probed.
pub async fn require_role(db: &PgPool, scroll_id: Uuid, user_id: Uuid) -> Result<Role, AppError> {
    role_of(db, scroll_id, user_id).await?.ok_or(AppError::NotFound)
}

/// An assistant's access token on a scroll set to "review" may only add things: anything that overwrites, moves or
/// removes work (pictures, the whole scroll) has no proposal to wait in, so it is refused with a way forward.
pub async fn refuse_if_held(db: &PgPool, via: &ViaToken, scroll_id: Uuid, what: &str) -> Result<(), AppError> {
    if via.0.is_none() {
        return Ok(());
    }
    let mode: String = sqlx::query_scalar("SELECT ai_edit_mode FROM scrolls WHERE id = $1").bind(scroll_id).fetch_one(db).await?;
    if mode == "review" {
        return Err(AppError::Conflict(format!("This scroll holds assistants' changes for review, and {what} cannot wait in the queue. A person can do it in the app, or the owner can set the scroll to apply assistant edits automatically.")));
    }
    Ok(())
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ScrollSummary {
    pub id: Uuid,
    pub title: String,
    pub role: String,
    pub owner_name: String,
    pub member_count: i64,
    pub updated_at: DateTime<Utc>,
    /// How an AI assistant's edits arrive: `review` (a person accepts each) or `auto` (owner's choice).
    pub ai_edit_mode: String,
}

/// Shared SELECT for scroll summaries, extended at compile time (keeps every query a literal).
macro_rules! summary_sql {
    ($tail:literal) => {
        concat!(
            "SELECT s.id, s.title, m.role, o.display_name AS owner_name, s.updated_at, s.ai_edit_mode,
                    (SELECT count(*) FROM scroll_members x WHERE x.scroll_id = s.id) AS member_count
               FROM scroll_members m
               JOIN scrolls s ON s.id = m.scroll_id
               JOIN users o ON o.id = s.owner_id
              WHERE m.user_id = $1 AND s.deleted_at IS NULL",
            $tail
        )
    };
}

pub async fn list(State(state): State<AppState>, user: AuthUser) -> Result<Json<Vec<ScrollSummary>>, AppError> {
    let rows = sqlx::query_as::<_, ScrollSummary>(summary_sql!(" ORDER BY s.updated_at DESC"))
        .bind(user.id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(rows))
}

pub async fn get(State(state): State<AppState>, user: AuthUser, Path(id): Path<Uuid>) -> Result<Json<ScrollSummary>, AppError> {
    let row = sqlx::query_as::<_, ScrollSummary>(summary_sql!(" AND s.id = $2"))
        .bind(user.id)
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
pub struct TitleBody {
    pub title: String,
}

fn clean_title(raw: &str) -> Result<String, AppError> {
    let t = raw.trim();
    if t.is_empty() || t.chars().count() > 120 {
        return Err(AppError::BadRequest("A scroll title must be between 1 and 120 characters.".into()));
    }
    Ok(t.to_string())
}

pub async fn create(State(state): State<AppState>, user: AuthUser, Json(body): Json<TitleBody>) -> Result<(StatusCode, Json<ScrollSummary>), AppError> {
    let title = clean_title(&body.title)?;
    let id = Uuid::new_v4();
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO scrolls (id, title, owner_id) VALUES ($1, $2, $3)").bind(id).bind(&title).bind(user.id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO scroll_members (scroll_id, user_id, role) VALUES ($1, $2, 'owner')").bind(id).bind(user.id).execute(&mut *tx).await?;
    tx.commit().await?;
    let row = sqlx::query_as::<_, ScrollSummary>(summary_sql!(" AND s.id = $2")).bind(user.id).bind(id).fetch_one(&state.db).await?;
    Ok((StatusCode::CREATED, Json(row)))
}

pub async fn rename(State(state): State<AppState>, user: AuthUser, Path(id): Path<Uuid>, Json(body): Json<TitleBody>) -> Result<StatusCode, AppError> {
    let role = require_role(&state.db, id, user.id).await?;
    if !role.can_manage() {
        return Err(AppError::Forbidden);
    }
    sqlx::query("UPDATE scrolls SET title = $2, updated_at = now() WHERE id = $1").bind(id).bind(clean_title(&body.title)?).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Moves a scroll to the cellar (soft delete). Only the owner may.
pub async fn delete(State(state): State<AppState>, user: AuthUser, via: ViaToken, Path(id): Path<Uuid>) -> Result<StatusCode, AppError> {
    let role = require_role(&state.db, id, user.id).await?;
    if !role.can_manage() {
        return Err(AppError::Forbidden);
    }
    refuse_if_held(&state.db, &via, id, "deleting the scroll").await?;
    sqlx::query("UPDATE scrolls SET deleted_at = now() WHERE id = $1").bind(id).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- members ------------------------------------------------------------------------------

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub user_id: Uuid,
    pub display_name: String,
    pub email: String,
    pub color: String,
    pub role: String,
}

pub async fn members(State(state): State<AppState>, user: AuthUser, Path(id): Path<Uuid>) -> Result<Json<Vec<Member>>, AppError> {
    require_role(&state.db, id, user.id).await?;
    let rows = sqlx::query_as::<_, Member>(
        "SELECT u.id AS user_id, u.display_name, u.email, u.color, m.role
           FROM scroll_members m JOIN users u ON u.id = m.user_id
          WHERE m.scroll_id = $1
          ORDER BY (m.role = 'owner') DESC, u.display_name",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct RoleBody {
    pub role: Role,
}

fn assignable(role: Role) -> Result<Role, AppError> {
    if role == Role::Owner { Err(AppError::BadRequest("A scroll has exactly one owner.".into())) } else { Ok(role) }
}

pub async fn set_role(State(state): State<AppState>, user: AuthUser, Path((id, target)): Path<(Uuid, Uuid)>, Json(body): Json<RoleBody>) -> Result<StatusCode, AppError> {
    if !require_role(&state.db, id, user.id).await?.can_manage() {
        return Err(AppError::Forbidden);
    }
    let role = assignable(body.role)?;
    // the owner row is immutable here
    let updated = sqlx::query("UPDATE scroll_members SET role = $3 WHERE scroll_id = $1 AND user_id = $2 AND role <> 'owner'").bind(id).bind(target).bind(role.as_str()).execute(&state.db).await?;
    if updated.rows_affected() == 0 { Err(AppError::NotFound) } else { Ok(StatusCode::NO_CONTENT) }
}

/// The owner can remove anyone else; any other member can remove themselves (leave).
pub async fn remove_member(State(state): State<AppState>, user: AuthUser, Path((id, target)): Path<(Uuid, Uuid)>) -> Result<StatusCode, AppError> {
    let role = require_role(&state.db, id, user.id).await?;
    if !role.can_manage() && target != user.id {
        return Err(AppError::Forbidden);
    }
    let removed = sqlx::query("DELETE FROM scroll_members WHERE scroll_id = $1 AND user_id = $2 AND role <> 'owner'").bind(id).bind(target).execute(&state.db).await?;
    if removed.rows_affected() == 0 {
        return Err(AppError::BadRequest("The owner cannot leave their own scroll; delete it instead.".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}
