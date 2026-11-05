//! Share links: a link for editing and a link for viewing. Whoever is signed in and opens one
//! takes a seat at that level (never a lower one than they already have). The owner can reset a
//! link (the old address stops working) or turn it off.

use std::time::Duration;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::Serialize;
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthUser, new_token},
    error::AppError,
    scrolls::{Role, require_role},
};

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ShareLink {
    pub role: String,
    pub token: String,
}

fn link_role(role: &str) -> Result<Role, AppError> {
    match Role::parse(role) {
        Some(r @ (Role::Scribe | Role::Reader)) => Ok(r),
        _ => Err(AppError::BadRequest("A share link is for scribes or for readers.".into())),
    }
}

/// `GET /api/scrolls/{id}/links` (owner only): the links that are switched on.
pub async fn list(State(state): State<AppState>, user: AuthUser, Path(scroll): Path<Uuid>) -> Result<Json<Vec<ShareLink>>, AppError> {
    if !require_role(&state.db, scroll, user.id).await?.can_manage() {
        return Err(AppError::Forbidden);
    }
    let rows = sqlx::query_as::<_, ShareLink>("SELECT role, token FROM share_links WHERE scroll_id = $1 ORDER BY role DESC").bind(scroll).fetch_all(&state.db).await?;
    Ok(Json(rows))
}

/// `PUT /api/scrolls/{id}/links/{role}` (owner only): switch the link on, or give it a new address.
pub async fn put(State(state): State<AppState>, user: AuthUser, Path((scroll, role)): Path<(Uuid, String)>) -> Result<Json<ShareLink>, AppError> {
    if !require_role(&state.db, scroll, user.id).await?.can_manage() {
        return Err(AppError::Forbidden);
    }
    let role = link_role(&role)?;
    let row = sqlx::query_as::<_, ShareLink>(
        "INSERT INTO share_links (scroll_id, role, token) VALUES ($1, $2, $3)
         ON CONFLICT (scroll_id, role) DO UPDATE SET token = EXCLUDED.token, created_at = now()
         RETURNING role, token",
    )
    .bind(scroll)
    .bind(role.as_str())
    .bind(new_token())
    .fetch_one(&state.db)
    .await?;
    Ok(Json(row))
}

/// `DELETE /api/scrolls/{id}/links/{role}` (owner only): turn the link off.
pub async fn remove(State(state): State<AppState>, user: AuthUser, Path((scroll, role)): Path<(Uuid, String)>) -> Result<StatusCode, AppError> {
    if !require_role(&state.db, scroll, user.id).await?.can_manage() {
        return Err(AppError::Forbidden);
    }
    let role = link_role(&role)?;
    sqlx::query("DELETE FROM share_links WHERE scroll_id = $1 AND role = $2").bind(scroll).bind(role.as_str()).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    pub scroll_id: Uuid,
    pub scroll_title: String,
    pub owner_name: String,
    pub role: String,
}

const PREVIEW_SQL: &str = "SELECT l.scroll_id, s.title AS scroll_title, u.display_name AS owner_name, l.role
       FROM share_links l
       JOIN scrolls s ON s.id = l.scroll_id AND s.deleted_at IS NULL
       JOIN users u ON u.id = s.owner_id
      WHERE l.token = $1";

/// `GET /api/links/{token}`: what the link opens (for the "Join this scroll?" page).
pub async fn preview(State(state): State<AppState>, _user: AuthUser, Path(token): Path<String>) -> Result<Json<LinkPreview>, AppError> {
    let row = sqlx::query_as::<_, LinkPreview>(PREVIEW_SQL).bind(&token).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    Ok(Json(row))
}

/// `POST /api/links/{token}/join`: take a seat. Someone who already has an equal or higher seat keeps it.
pub async fn join(State(state): State<AppState>, user: AuthUser, Path(token): Path<String>) -> Result<Json<serde_json::Value>, AppError> {
    state.limiter.hit(&format!("join:{}", user.id), 60, Duration::from_secs(3600)).map_err(AppError::TooManyRequests)?;
    let link = sqlx::query_as::<_, LinkPreview>(PREVIEW_SQL).bind(&token).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    // a new seat, or an upgrade from reader to scribe; never a demotion and never touching the owner
    sqlx::query(
        "INSERT INTO scroll_members (scroll_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (scroll_id, user_id) DO UPDATE SET role = EXCLUDED.role
         WHERE scroll_members.role = 'reader' AND EXCLUDED.role = 'scribe'",
    )
    .bind(link.scroll_id)
    .bind(user.id)
    .bind(&link.role)
    .execute(&state.db)
    .await?;
    let role = require_role(&state.db, link.scroll_id, user.id).await?;
    Ok(Json(serde_json::json!({ "scrollId": link.scroll_id, "role": role.as_str() })))
}
