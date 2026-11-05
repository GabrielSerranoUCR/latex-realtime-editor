//! Invitations: the owner invites by *email*; the recipient accepts after signing in with that
//! (verified) address. The same response is given whether or not the address has an account.

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
    auth::{AuthUser, valid_email},
    error::AppError,
    scrolls::{Role, require_role},
};

const INVITE_TTL_DAYS: i32 = 14;

#[derive(Debug, Deserialize)]
pub struct InviteBody {
    pub email: String,
    pub role: Role,
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PendingInvite {
    pub id: Uuid,
    pub email: String,
    pub role: String,
    pub expires_at: DateTime<Utc>,
}

/// `POST /api/scrolls/{id}/invitations` (owner only).
pub async fn create(State(state): State<AppState>, user: AuthUser, Path(scroll): Path<Uuid>, Json(body): Json<InviteBody>) -> Result<(StatusCode, Json<PendingInvite>), AppError> {
    if !require_role(&state.db, scroll, user.id).await?.can_manage() {
        return Err(AppError::Forbidden);
    }
    state.limiter.hit(&format!("invite:{}", user.id), 30, Duration::from_secs(3600)).map_err(AppError::TooManyRequests)?;
    let email = body.email.trim().to_string();
    if !valid_email(&email) {
        return Err(AppError::BadRequest("That does not look like an email address.".into()));
    }
    if body.role == Role::Owner {
        return Err(AppError::BadRequest("A scroll has exactly one owner.".into()));
    }
    let already: Option<i32> = sqlx::query_scalar("SELECT 1 FROM scroll_members m JOIN users u ON u.id = m.user_id WHERE m.scroll_id = $1 AND lower(u.email) = lower($2)")
        .bind(scroll)
        .bind(&email)
        .fetch_optional(&state.db)
        .await?;
    if already.is_some() {
        return Err(AppError::Conflict("They already have a seat at this table.".into()));
    }
    let invite = sqlx::query_as::<_, PendingInvite>(
        "INSERT INTO invitations (id, scroll_id, email, role, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
         ON CONFLICT (scroll_id, lower(email))
         DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, expires_at = EXCLUDED.expires_at
         RETURNING id, email, role, expires_at",
    )
    .bind(Uuid::new_v4())
    .bind(scroll)
    .bind(&email)
    .bind(body.role.as_str())
    .bind(user.id)
    .bind(INVITE_TTL_DAYS)
    .fetch_one(&state.db)
    .await?;

    let title: String = sqlx::query_scalar("SELECT title FROM scrolls WHERE id = $1").bind(scroll).fetch_one(&state.db).await?;
    let link = format!("{}/invitations/{}", state.config.public_url, invite.id);
    let sent = state
        .mailer
        .send(
            &email,
            &format!("{} invited you to “{}”", user.display_name, title),
            &format!("{} invited you to “{}” as a {}.\n\nOpen the invitation:\n\n{link}\n\nSign in (or sign up) with this email address, confirm it, and accept. It expires in {INVITE_TTL_DAYS} days. If you were not expecting this, ignore this email.", user.display_name, title, invite.role),
        )
        .await;
    if let Err(e) = sent {
        tracing::error!(error = ?e, "could not send invitation email");
    }
    Ok((StatusCode::CREATED, Json(invite)))
}

/// Pending invitations of a scroll (owner only).
pub async fn list_for_scroll(State(state): State<AppState>, user: AuthUser, Path(scroll): Path<Uuid>) -> Result<Json<Vec<PendingInvite>>, AppError> {
    if !require_role(&state.db, scroll, user.id).await?.can_manage() {
        return Err(AppError::Forbidden);
    }
    let rows = sqlx::query_as::<_, PendingInvite>("SELECT id, email, role, expires_at FROM invitations WHERE scroll_id = $1 AND expires_at > now() ORDER BY created_at")
        .bind(scroll)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(rows))
}

/// The owner withdraws an invitation.
pub async fn revoke(State(state): State<AppState>, user: AuthUser, Path((scroll, id)): Path<(Uuid, Uuid)>) -> Result<StatusCode, AppError> {
    if !require_role(&state.db, scroll, user.id).await?.can_manage() {
        return Err(AppError::Forbidden);
    }
    sqlx::query("DELETE FROM invitations WHERE id = $1 AND scroll_id = $2").bind(id).bind(scroll).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MyInvite {
    pub id: Uuid,
    pub scroll_id: Uuid,
    pub scroll_title: String,
    pub inviter_name: String,
    pub role: String,
    pub expires_at: DateTime<Utc>,
}

/// Only people whose email is **verified** can see or accept invitations addressed to it.
fn require_verified(user: &AuthUser) -> Result<(), AppError> {
    if user.email_verified { Ok(()) } else { Err(AppError::Forbidden) }
}

const MINE_SQL: &str = "SELECT i.id, i.scroll_id, s.title AS scroll_title, u.display_name AS inviter_name, i.role, i.expires_at
       FROM invitations i
       JOIN scrolls s ON s.id = i.scroll_id AND s.deleted_at IS NULL
       JOIN users u ON u.id = i.invited_by
      WHERE lower(i.email) = lower($1) AND i.expires_at > now()";

/// `GET /api/invitations` — invitations addressed to me.
pub async fn mine(State(state): State<AppState>, user: AuthUser) -> Result<Json<Vec<MyInvite>>, AppError> {
    require_verified(&user)?;
    let rows = sqlx::query_as::<_, MyInvite>(sqlx::AssertSqlSafe(format!("{MINE_SQL} ORDER BY i.created_at DESC"))).bind(&user.email).fetch_all(&state.db).await?;
    Ok(Json(rows))
}

pub async fn get_mine(State(state): State<AppState>, user: AuthUser, Path(id): Path<Uuid>) -> Result<Json<MyInvite>, AppError> {
    require_verified(&user)?;
    let row = sqlx::query_as::<_, MyInvite>(sqlx::AssertSqlSafe(format!("{MINE_SQL} AND i.id = $2"))).bind(&user.email).bind(id).fetch_optional(&state.db).await?.ok_or(AppError::NotFound)?;
    Ok(Json(row))
}

/// Accept: become a member with the invited role. Returns the scroll id.
pub async fn accept(State(state): State<AppState>, user: AuthUser, Path(id): Path<Uuid>) -> Result<Json<serde_json::Value>, AppError> {
    require_verified(&user)?;
    let mut tx = state.db.begin().await?;
    let invite: Option<(Uuid, String)> = sqlx::query_as(
        "DELETE FROM invitations i USING scrolls s
          WHERE i.id = $1 AND lower(i.email) = lower($2) AND i.expires_at > now() AND s.id = i.scroll_id AND s.deleted_at IS NULL
          RETURNING i.scroll_id, i.role",
    )
    .bind(id)
    .bind(&user.email)
    .fetch_optional(&mut *tx)
    .await?;
    let (scroll_id, role) = invite.ok_or(AppError::NotFound)?;
    sqlx::query("INSERT INTO scroll_members (scroll_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (scroll_id, user_id) DO NOTHING")
        .bind(scroll_id)
        .bind(user.id)
        .bind(&role)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({ "scrollId": scroll_id, "role": role })))
}

/// Decline an invitation addressed to me.
pub async fn decline(State(state): State<AppState>, user: AuthUser, Path(id): Path<Uuid>) -> Result<StatusCode, AppError> {
    require_verified(&user)?;
    sqlx::query("DELETE FROM invitations WHERE id = $1 AND lower(email) = lower($2)").bind(id).bind(&user.email).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}
