//! "You need a seat": someone signed in who has no access to a scroll asks its owner to let them in.
//! The owner sees the requests in Share and gives a seat (as a scribe or a reader) or declines.

use std::time::Duration;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    error::AppError,
    scrolls::{Role, require_role, role_of},
};

const MAX_MESSAGE_CHARS: usize = 500;

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Door {
    pub title: String,
    pub owner_name: String,
    /// Already has a seat (the page should simply open the scroll).
    pub member: bool,
    /// Has already asked and is waiting.
    pub requested: bool,
}

/// `GET /api/scrolls/{id}/door`: what the "You need a seat" page shows. Only the title and the owner's name
/// are given away, and only to someone who is signed in and already has the scroll's (unguessable) address.
pub async fn door(State(state): State<AppState>, user: AuthUser, Path(scroll): Path<Uuid>) -> Result<Json<Door>, AppError> {
    let row = sqlx::query_as::<_, Door>(
        "SELECT s.title, o.display_name AS owner_name,
                EXISTS (SELECT 1 FROM scroll_members m WHERE m.scroll_id = s.id AND m.user_id = $2) AS member,
                EXISTS (SELECT 1 FROM access_requests r WHERE r.scroll_id = s.id AND r.user_id = $2) AS requested
           FROM scrolls s JOIN users o ON o.id = s.owner_id
          WHERE s.id = $1 AND s.deleted_at IS NULL",
    )
    .bind(scroll)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
pub struct RequestBody {
    #[serde(default)]
    pub message: String,
}

/// `POST /api/scrolls/{id}/requests`: ask for a seat.
pub async fn ask(State(state): State<AppState>, user: AuthUser, Path(scroll): Path<Uuid>, Json(body): Json<RequestBody>) -> Result<StatusCode, AppError> {
    state.limiter.hit(&format!("ask:{}", user.id), 10, Duration::from_secs(3600)).map_err(AppError::TooManyRequests)?;
    let message = body.message.trim().to_string();
    if message.chars().count() > MAX_MESSAGE_CHARS {
        return Err(AppError::BadRequest(format!("Keep the message under {MAX_MESSAGE_CHARS} characters.")));
    }
    #[derive(FromRow)]
    struct Info {
        title: String,
        owner_email: String,
        owner_name: String,
    }
    let info = sqlx::query_as::<_, Info>("SELECT s.title, o.email AS owner_email, o.display_name AS owner_name FROM scrolls s JOIN users o ON o.id = s.owner_id WHERE s.id = $1 AND s.deleted_at IS NULL")
        .bind(scroll)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    if role_of(&state.db, scroll, user.id).await?.is_some() {
        return Err(AppError::Conflict("You already have a seat at this table.".into()));
    }
    sqlx::query("INSERT INTO access_requests (scroll_id, user_id, message) VALUES ($1, $2, $3) ON CONFLICT (scroll_id, user_id) DO UPDATE SET message = EXCLUDED.message")
        .bind(scroll)
        .bind(user.id)
        .bind(&message)
        .execute(&state.db)
        .await?;
    let link = format!("{}/scroll/{scroll}", state.config.public_url);
    let mut text = format!("{} ({}) asks for a seat at “{}”.", user.display_name, user.email, info.title);
    if !message.is_empty() {
        text.push_str(&format!("\n\nThey wrote:\n{message}"));
    }
    text.push_str(&format!("\n\nOpen the scroll and press Share to give them a seat or decline:\n\n{link}\n"));
    if let Err(e) = state.mailer.send(&info.owner_email, &format!("{} asks for a seat at “{}”", user.display_name, info.title), &text).await {
        tracing::error!(error = ?e, owner = %info.owner_name, "could not send the access request email");
    }
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    pub user_id: Uuid,
    pub display_name: String,
    pub email: String,
    pub message: String,
    pub created_at: DateTime<Utc>,
}

/// `GET /api/scrolls/{id}/requests` (owner only).
pub async fn list(State(state): State<AppState>, user: AuthUser, Path(scroll): Path<Uuid>) -> Result<Json<Vec<PendingRequest>>, AppError> {
    if !require_role(&state.db, scroll, user.id).await?.can_manage() {
        return Err(AppError::Forbidden);
    }
    let rows = sqlx::query_as::<_, PendingRequest>(
        "SELECT r.user_id, u.display_name, u.email, r.message, r.created_at
           FROM access_requests r JOIN users u ON u.id = r.user_id
          WHERE r.scroll_id = $1 AND NOT EXISTS (SELECT 1 FROM scroll_members m WHERE m.scroll_id = r.scroll_id AND m.user_id = r.user_id)
          ORDER BY r.created_at",
    )
    .bind(scroll)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct ApproveBody {
    pub role: Role,
}

/// `POST /api/scrolls/{id}/requests/{user}/approve` (owner only): give them a seat.
pub async fn approve(State(state): State<AppState>, owner: AuthUser, Path((scroll, who)): Path<(Uuid, Uuid)>, Json(body): Json<ApproveBody>) -> Result<StatusCode, AppError> {
    if !require_role(&state.db, scroll, owner.id).await?.can_manage() {
        return Err(AppError::Forbidden);
    }
    if body.role == Role::Owner {
        return Err(AppError::BadRequest("A scroll has exactly one owner.".into()));
    }
    let mut tx = state.db.begin().await?;
    let removed = sqlx::query("DELETE FROM access_requests WHERE scroll_id = $1 AND user_id = $2").bind(scroll).bind(who).execute(&mut *tx).await?;
    if removed.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    sqlx::query("INSERT INTO scroll_members (scroll_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (scroll_id, user_id) DO NOTHING").bind(scroll).bind(who).bind(body.role.as_str()).execute(&mut *tx).await?;
    tx.commit().await?;
    let who_row: Option<(String, String)> = sqlx::query_as("SELECT email, (SELECT title FROM scrolls WHERE id = $2) FROM users WHERE id = $1").bind(who).bind(scroll).fetch_optional(&state.db).await?;
    if let Some((email, title)) = who_row {
        let link = format!("{}/scroll/{scroll}", state.config.public_url);
        let text = format!("{} gave you a seat at “{}” as a {}.\n\nOpen it here:\n\n{link}\n", owner.display_name, title, body.role.as_str());
        if let Err(e) = state.mailer.send(&email, &format!("You have a seat at “{title}”"), &text).await {
            tracing::error!(error = ?e, "could not send the seat-granted email");
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/scrolls/{id}/requests/{user}` (owner only): decline. The person is not told.
pub async fn decline(State(state): State<AppState>, owner: AuthUser, Path((scroll, who)): Path<(Uuid, Uuid)>) -> Result<StatusCode, AppError> {
    if !require_role(&state.db, scroll, owner.id).await?.can_manage() {
        return Err(AppError::Forbidden);
    }
    sqlx::query("DELETE FROM access_requests WHERE scroll_id = $1 AND user_id = $2").bind(scroll).bind(who).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}
