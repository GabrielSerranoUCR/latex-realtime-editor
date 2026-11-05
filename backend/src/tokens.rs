//! Personal access tokens: how a program (an AI assistant over MCP, a script) acts as its owner.
//! A token may be read-only (read and compile) or may also change scrolls. It has the owner's own access to
//! scrolls, no more, and can be revoked at any time. Making and revoking tokens needs a signed-in browser.

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
    auth::{SessionUser, new_token},
    error::AppError,
};

const MAX_ACTIVE_TOKENS: i64 = 20;
const TOKEN_PREFIX: &str = "qq_";

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TokenInfo {
    pub id: Uuid,
    pub name: String,
    pub write: bool,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewToken {
    #[serde(flatten)]
    pub info: TokenInfo,
    /// The token itself: shown this once, only its hash is kept.
    pub token: String,
}

/// `GET /api/me/tokens`: the tokens that still work.
pub async fn list(State(state): State<AppState>, SessionUser(user): SessionUser) -> Result<Json<Vec<TokenInfo>>, AppError> {
    let rows = sqlx::query_as::<_, TokenInfo>(
        "SELECT id, name, write, created_at, last_used_at, expires_at FROM api_tokens
          WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    pub name: String,
    #[serde(default)]
    pub write: bool,
    /// Days until it stops working; omitted means never.
    pub days: Option<i32>,
}

/// `POST /api/me/tokens`.
pub async fn create(State(state): State<AppState>, SessionUser(user): SessionUser, Json(body): Json<CreateBody>) -> Result<(StatusCode, Json<NewToken>), AppError> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(AppError::BadRequest("Give the token a name of up to 60 characters, such as “Claude on my laptop”.".into()));
    }
    if matches!(body.days, Some(d) if !(1..=3650).contains(&d)) {
        return Err(AppError::BadRequest("A token can last from 1 day to 10 years.".into()));
    }
    let active: i64 = sqlx::query_scalar("SELECT count(*) FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())").bind(user.id).fetch_one(&state.db).await?;
    if active >= MAX_ACTIVE_TOKENS {
        return Err(AppError::Conflict(format!("You already have {MAX_ACTIVE_TOKENS} tokens. Revoke one you no longer use first.")));
    }
    let token = format!("{TOKEN_PREFIX}{}", new_token());
    let info = sqlx::query_as::<_, TokenInfo>(
        "INSERT INTO api_tokens (id, user_id, name, token_hash, write, expires_at)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END)
         RETURNING id, name, write, created_at, last_used_at, expires_at",
    )
    .bind(Uuid::new_v4())
    .bind(user.id)
    .bind(&name)
    .bind(crate::auth::hash_token(&token))
    .bind(body.write)
    .bind(body.days)
    .fetch_one(&state.db)
    .await?;
    Ok((StatusCode::CREATED, Json(NewToken { info, token })))
}

/// `DELETE /api/me/tokens/{id}`: it stops working at once.
pub async fn revoke(State(state): State<AppState>, SessionUser(user): SessionUser, Path(id): Path<Uuid>) -> Result<StatusCode, AppError> {
    let done = sqlx::query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL").bind(id).bind(user.id).execute(&state.db).await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}
