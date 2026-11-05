use axum::{Json, http::StatusCode, response::{IntoResponse, Response}};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("invalid room id")]
    InvalidRoom,
    #[error("please sign in")]
    Unauthorized,
    #[error("you do not have a seat at this table for that")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    #[error("too many attempts; try again in {0} seconds")]
    TooManyRequests(u64),
    #[error("{0}")]
    TooLarge(String),
    #[error("database error")]
    Db(#[from] sqlx::Error),
    #[error("room has no compilable files")]
    NothingToCompile,
    #[error("no pdf has been compiled for this room yet")]
    PdfNotFound,
    #[error("internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            AppError::InvalidRoom => StatusCode::BAD_REQUEST,
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::Forbidden => StatusCode::FORBIDDEN,
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
            AppError::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            AppError::Db(e) => {
                tracing::error!(error = ?e, "database error");
                StatusCode::INTERNAL_SERVER_ERROR
            }
            AppError::NothingToCompile => StatusCode::UNPROCESSABLE_ENTITY,
            AppError::PdfNotFound => StatusCode::NOT_FOUND,
            AppError::Internal(e) => {
                tracing::error!(error = ?e, "internal error");
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        // never leak internals to the client
        let message = match &self {
            AppError::Internal(_) | AppError::Db(_) => "something went wrong on our side".to_string(),
            other => other.to_string(),
        };
        let mut response = (status, Json(json!({ "error": message }))).into_response();
        if let AppError::TooManyRequests(secs) = self {
            if let Ok(v) = secs.to_string().parse() {
                response.headers_mut().insert(axum::http::header::RETRY_AFTER, v);
            }
        }
        response
    }
}

/// Room ids become directory names, so keep them strict.
pub fn validate_room_id(id: &str) -> Result<(), AppError> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok { Ok(()) } else { Err(AppError::InvalidRoom) }
}

/// Room ids are scroll ids, which are UUIDs.
pub fn parse_room_id(id: &str) -> Result<uuid::Uuid, AppError> {
    validate_room_id(id)?;
    uuid::Uuid::parse_str(id).map_err(|_| AppError::InvalidRoom)
}
