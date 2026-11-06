//! Accounts and sessions: signup, login, logout, and the `AuthUser` extractor.

use std::{net::SocketAddr, sync::OnceLock, time::Duration};

use anyhow::anyhow;
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use axum::{
    Json,
    extract::{ConnectInfo, FromRequestParts, Path, State},
    http::{HeaderMap, Method, StatusCode, header, request::Parts},
    middleware::Next,
    response::Response,
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{AppState, config::Config, error::AppError};

pub const SESSION_COOKIE: &str = "quill_session";

/// Cursor colours handed out to new accounts (Tavern Theme: brass, ember, ale, candle, wine).
const COLORS: [&str; 5] = ["#C9A04A", "#D9772B", "#6F8F4E", "#F6C85F", "#9B3030"];

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub color: String,
    pub email_verified: bool,
    /// Free text about who this scribe writes for ("University of Costa Rica"); may be empty.
    pub affiliation: String,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    /// A personal access token (`Authorization: Bearer qq_…`) or, for the browser, the session cookie.
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        if let Some(token) = bearer_token(&parts.headers) {
            return user_from_api_token(parts, state, &token).await;
        }
        user_from_cookie(parts, state).await
    }
}

/// Like `AuthUser`, but only a signed-in browser counts: used where a program must never be able to act (making
/// new access tokens), so a leaked token cannot mint more of them.
pub struct SessionUser(pub AuthUser);

impl FromRequestParts<AppState> for SessionUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        if bearer_token(&parts.headers).is_some() {
            return Err(AppError::Forbidden);
        }
        Ok(SessionUser(user_from_cookie(parts, state).await?))
    }
}

/// Set when the request came with an access token (not a browser session): the token's name. Edits that
/// arrive this way are an assistant's, and a scroll may hold them for review.
pub struct ViaToken(pub Option<String>);

impl FromRequestParts<AppState> for ViaToken {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let Some(token) = bearer_token(&parts.headers) else { return Ok(ViaToken(None)) };
        let name: Option<String> = sqlx::query_scalar("SELECT name FROM api_tokens WHERE token_hash = $1").bind(hash_token(&token)).fetch_optional(&state.db).await?;
        Ok(ViaToken(Some(name.unwrap_or_default())))
    }
}

pub fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer "))?.trim();
    (!token.is_empty()).then(|| token.to_string())
}

async fn user_from_cookie(parts: &Parts, state: &AppState) -> Result<AuthUser, AppError> {
    let jar = CookieJar::from_headers(&parts.headers);
    let token = jar.get(SESSION_COOKIE).ok_or(AppError::Unauthorized)?.value().to_string();
    let user = sqlx::query_as::<_, AuthUser>(
        "SELECT u.id, u.email, u.display_name, u.color, (u.email_verified_at IS NOT NULL) AS email_verified, u.affiliation
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > now()",
    )
    .bind(hash_token(&token))
    .fetch_optional(&state.db)
    .await?;
    user.ok_or(AppError::Unauthorized)
}

/// What a read-only token may still do besides reading: ask for a compile (it changes no document).
fn read_only_may(method: &Method, path: &str) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) || (*method == Method::POST && path.ends_with("/compile"))
}

async fn user_from_api_token(parts: &Parts, state: &AppState, token: &str) -> Result<AuthUser, AppError> {
    let row: Option<(Uuid, bool, Uuid)> = sqlx::query_as("SELECT id, write, user_id FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())")
        .bind(hash_token(token))
        .fetch_optional(&state.db)
        .await?;
    let (token_id, write, user_id) = row.ok_or(AppError::Unauthorized)?;
    if !write && !read_only_may(&parts.method, parts.uri.path()) {
        return Err(AppError::Forbidden);
    }
    // note when it was last used, but not on every request
    sqlx::query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')").bind(token_id).execute(&state.db).await?;
    let user = sqlx::query_as::<_, AuthUser>("SELECT id, email, display_name, color, (email_verified_at IS NOT NULL) AS email_verified, affiliation FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
    user.ok_or(AppError::Unauthorized)
}

/// The browser's own description of itself, kept (bounded, as plain text) with the session it starts.
pub struct UserAgent(pub String);

impl FromRequestParts<AppState> for UserAgent {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &AppState) -> Result<Self, AppError> {
        let raw = parts.headers.get("user-agent").and_then(|v| v.to_str().ok()).unwrap_or("");
        Ok(UserAgent(raw.chars().filter(|c| !c.is_control()).take(200).collect()))
    }
}

/// The caller's IP, for rate limiting (`X-Forwarded-For` only when `QUILL_TRUST_PROXY=true`).
pub struct ClientIp(pub String);

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        if state.config.trust_proxy {
            if let Some(ip) = parts.headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()) {
                return Ok(ClientIp(ip.trim().to_string()));
            }
        }
        Ok(ClientIp(parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip().to_string()).unwrap_or_else(|| "unknown".into())))
    }
}

fn throttle(state: &AppState, key: &str, max: u32, window: Duration) -> Result<(), AppError> {
    state.limiter.hit(key, max, window).map_err(AppError::TooManyRequests)
}

fn throttle_ip(state: &AppState, ip: &ClientIp) -> Result<(), AppError> {
    throttle(state, &format!("ip:{}", ip.0), state.config.ip_auth_max, state.config.login_window)
}

pub(crate) fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub fn new_token() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

// ---- CSRF / cross-site WebSocket hijacking ------------------------------------------------

/// Browsers always send `Origin` on cross-site writes and WebSocket upgrades. Cookies are
/// `SameSite=Lax`, and this check closes the remaining gaps. Requests without `Origin`
/// (curl, tests, server-to-server) carry no ambient browser credentials to abuse.
pub fn check_origin(headers: &HeaderMap, config: &Config) -> Result<(), AppError> {
    match headers.get(header::ORIGIN).map(|v| v.to_str().unwrap_or("")) {
        Some(origin) if origin != config.allowed_origin => Err(AppError::Forbidden),
        _ => Ok(()),
    }
}

/// Middleware: state-changing requests must come from our own origin.
pub async fn origin_guard(State(state): State<AppState>, req: axum::extract::Request, next: Next) -> Result<Response, AppError> {
    if !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        check_origin(req.headers(), &state.config)?;
    }
    Ok(next.run(req).await)
}

// ---- handlers -----------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignupBody {
    pub email: String,
    pub display_name: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginBody {
    pub email: String,
    pub password: String,
}

pub fn valid_email(e: &str) -> bool {
    let Some((local, domain)) = e.split_once('@') else { return false };
    e.len() <= 254 && !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.') && !e.contains(char::is_whitespace)
}

pub async fn signup(State(state): State<AppState>, ip: ClientIp, ua: UserAgent, jar: CookieJar, Json(body): Json<SignupBody>) -> Result<(CookieJar, (StatusCode, Json<AuthUser>)), AppError> {
    throttle_ip(&state, &ip)?;
    let email = body.email.trim().to_string();
    let name = body.display_name.trim().to_string();
    if !valid_email(&email) {
        return Err(AppError::BadRequest("That does not look like an email address.".into()));
    }
    if name.is_empty() || name.chars().count() > 60 {
        return Err(AppError::BadRequest("Your name must be between 1 and 60 characters.".into()));
    }
    let pw_len = body.password.chars().count();
    if !(10..=128).contains(&pw_len) {
        return Err(AppError::BadRequest("Your password must be between 10 and 128 characters.".into()));
    }

    let hash = hash_password(body.password).await?;
    let id = Uuid::new_v4();
    let color = COLORS[(id.as_bytes()[0] as usize) % COLORS.len()];
    let inserted = sqlx::query("INSERT INTO users (id, email, display_name, password_hash, color) VALUES ($1, $2, $3, $4, $5)")
        .bind(id)
        .bind(&email)
        .bind(&name)
        .bind(&hash)
        .bind(color)
        .execute(&state.db)
        .await;
    match inserted {
        Ok(_) => {}
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(AppError::Conflict("A tavern account already uses that email.".into()));
        }
        Err(e) => return Err(e.into()),
    }
    let user = AuthUser { id, email, display_name: name, color: color.into(), email_verified: false, affiliation: String::new() };
    send_verification(&state, &user).await;
    let jar = start_session(&state, jar, id, &ua.0).await?;
    Ok((jar, (StatusCode::CREATED, Json(user))))
}

pub async fn login(State(state): State<AppState>, ip: ClientIp, ua: UserAgent, jar: CookieJar, Json(body): Json<LoginBody>) -> Result<(CookieJar, Json<AuthUser>), AppError> {
    #[derive(FromRow)]
    struct Row {
        id: Uuid,
        email: String,
        display_name: String,
        color: String,
        password_hash: String,
        email_verified: bool,
        affiliation: String,
    }
    throttle_ip(&state, &ip)?;
    // Lock an account's sign-in after repeated failures, whoever is trying (and whether or not it exists).
    let lock_key = format!("login:{}", body.email.trim().to_lowercase());
    state.limiter.check(&lock_key, state.config.login_failures_max, state.config.login_window).map_err(AppError::TooManyRequests)?;
    let row = sqlx::query_as::<_, Row>("SELECT id, email, display_name, color, password_hash, (email_verified_at IS NOT NULL) AS email_verified, affiliation FROM users WHERE lower(email) = lower($1)")
        .bind(body.email.trim())
        .fetch_optional(&state.db)
        .await?;

    // Verify against a dummy hash when the account does not exist, so response time does not
    // reveal which emails are registered.
    let (hash, known) = match &row {
        Some(r) => (r.password_hash.clone(), true),
        None => (dummy_hash().to_string(), false),
    };
    let ok = verify_password(body.password, hash).await?;
    match (row, ok && known) {
        (Some(r), true) => {
            state.limiter.clear(&lock_key);
            let jar = start_session(&state, jar, r.id, &ua.0).await?;
            Ok((jar, Json(AuthUser { id: r.id, email: r.email, display_name: r.display_name, color: r.color, email_verified: r.email_verified, affiliation: r.affiliation })))
        }
        _ => {
            let _ = state.limiter.hit(&lock_key, state.config.login_failures_max, state.config.login_window);
            Err(AppError::BadRequest("That email and password do not match.".into()))
        }
    }
}

pub async fn logout(State(state): State<AppState>, jar: CookieJar) -> Result<(CookieJar, StatusCode), AppError> {
    if let Some(c) = jar.get(SESSION_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1").bind(hash_token(c.value())).execute(&state.db).await?;
    }
    Ok((jar.remove(Cookie::build(SESSION_COOKIE).path("/")), StatusCode::NO_CONTENT))
}

pub async fn me(user: AuthUser) -> Json<AuthUser> {
    Json(user)
}

// ---- helpers ------------------------------------------------------------------------------

async fn start_session(state: &AppState, jar: CookieJar, user_id: Uuid, user_agent: &str) -> Result<CookieJar, AppError> {
    let token = new_token();
    let ttl = state.config.session_ttl;
    sqlx::query("INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, now() + make_interval(secs => $3), $4)")
        .bind(hash_token(&token))
        .bind(user_id)
        .bind(ttl.as_secs() as f64)
        .bind(user_agent)
        .execute(&state.db)
        .await?;
    let cookie = Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.config.cookie_secure)
        .max_age(time::Duration::seconds(ttl.as_secs() as i64))
        .build();
    Ok(jar.add(cookie))
}

/// Argon2id with library defaults, on a blocking thread (it is deliberately expensive).
async fn hash_password(password: String) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || {
        Argon2::default().hash_password(password.as_bytes()).map(|h| h.to_string()).map_err(|e| anyhow!("hashing password: {e}"))
    })
    .await
    .map_err(|e| anyhow!(e))?
    .map_err(AppError::from)
}

async fn verify_password(password: String, hash: String) -> Result<bool, AppError> {
    tokio::task::spawn_blocking(move || Argon2::default().verify_password(password.as_bytes(), hash.as_str()).is_ok())
        .await
        .map_err(|e| AppError::from(anyhow!(e)))
}

fn dummy_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| Argon2::default().hash_password(b"not-a-real-password").expect("hash").to_string())
}

// ---- email verification & password reset --------------------------------------------------

const VERIFY_TTL_HOURS: i64 = 48;
const RESET_TTL_HOURS: i64 = 1;

/// Mint a one-time token of `kind`, store its hash, and return the plaintext for the email link.
async fn create_email_token(state: &AppState, user_id: Uuid, kind: &str, ttl_hours: i64) -> Result<String, AppError> {
    create_email_token_for(state, user_id, kind, ttl_hours * 60).await
}

/// The same, with the lifetime in minutes (a magic link lives for a quarter of an hour).
async fn create_email_token_for(state: &AppState, user_id: Uuid, kind: &str, ttl_minutes: i64) -> Result<String, AppError> {
    let token = new_token();
    sqlx::query("INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))")
        .bind(hash_token(&token))
        .bind(user_id)
        .bind(kind)
        .bind(ttl_minutes as i32)
        .execute(&state.db)
        .await?;
    Ok(token)
}

/// Single use: marks the token used and returns its owner, or `None` if unknown/used/expired.
async fn consume_email_token(state: &AppState, token: &str, kind: &str) -> Result<Option<Uuid>, AppError> {
    Ok(sqlx::query_scalar("UPDATE email_tokens SET used_at = now() WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id")
        .bind(hash_token(token))
        .bind(kind)
        .fetch_optional(&state.db)
        .await?)
}

async fn send_verification(state: &AppState, user: &AuthUser) {
    let result: Result<(), AppError> = async {
        let token = create_email_token(state, user.id, "verify", VERIFY_TTL_HOURS).await?;
        let link = format!("{}/verify-email?token={token}", state.config.public_url);
        state
            .mailer
            .send(&user.email, "Confirm your email for The Gilded Quill", &format!("Welcome, {}!\n\nConfirm your email address to accept invitations and recover your account:\n\n{link}\n\nThe link works once and expires in {VERIFY_TTL_HOURS} hours.", user.display_name))
            .await?;
        Ok(())
    }
    .await;
    if let Err(e) = result {
        tracing::error!(error = ?e, "could not send verification email");
    }
}

#[derive(Debug, Deserialize)]
pub struct TokenBody {
    pub token: String,
}

pub async fn verify_email(State(state): State<AppState>, ip: ClientIp, Json(body): Json<TokenBody>) -> Result<StatusCode, AppError> {
    throttle_ip(&state, &ip)?;
    let user_id = consume_email_token(&state, &body.token, "verify").await?.ok_or_else(|| AppError::BadRequest("That confirmation link has expired or was already used.".into()))?;
    sqlx::query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1").bind(user_id).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn resend_verification(State(state): State<AppState>, user: AuthUser) -> Result<StatusCode, AppError> {
    if user.email_verified {
        return Ok(StatusCode::NO_CONTENT);
    }
    throttle(&state, &format!("resend:{}", user.id), 3, Duration::from_secs(3600))?;
    send_verification(&state, &user).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct ForgotBody {
    pub email: String,
}

/// Always answers 204, so it cannot be used to discover which emails have accounts.
pub async fn forgot_password(State(state): State<AppState>, ip: ClientIp, Json(body): Json<ForgotBody>) -> Result<StatusCode, AppError> {
    throttle_ip(&state, &ip)?;
    let email = body.email.trim().to_lowercase();
    throttle(&state, &format!("forgot:{email}"), 3, Duration::from_secs(3600))?;
    #[derive(FromRow)]
    struct Row {
        id: Uuid,
        display_name: String,
    }
    if let Some(u) = sqlx::query_as::<_, Row>("SELECT id, display_name FROM users WHERE lower(email) = $1").bind(&email).fetch_optional(&state.db).await? {
        sqlx::query("UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND kind = 'reset' AND used_at IS NULL").bind(u.id).execute(&state.db).await?; // only the newest link works
        let token = create_email_token(&state, u.id, "reset", RESET_TTL_HOURS).await?;
        let link = format!("{}/reset-password?token={token}", state.config.public_url);
        let sent = state
            .mailer
            .send(&email, "Reset your Gilded Quill password", &format!("Hello {},\n\nChoose a new password here:\n\n{link}\n\nThe link works once and expires in {RESET_TTL_HOURS} hour. If you did not ask for this, you can ignore this email.", u.display_name))
            .await;
        if let Err(e) = sent {
            tracing::error!(error = ?e, "could not send reset email");
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct ResetBody {
    pub token: String,
    pub password: String,
}

fn check_password(pw: &str) -> Result<(), AppError> {
    if (10..=128).contains(&pw.chars().count()) { Ok(()) } else { Err(AppError::BadRequest("Your password must be between 10 and 128 characters.".into())) }
}

pub async fn reset_password(State(state): State<AppState>, ip: ClientIp, Json(body): Json<ResetBody>) -> Result<StatusCode, AppError> {
    throttle_ip(&state, &ip)?;
    check_password(&body.password)?;
    let user_id = consume_email_token(&state, &body.token, "reset").await?.ok_or_else(|| AppError::BadRequest("That reset link has expired or was already used.".into()))?;
    let hash = hash_password(body.password).await?;
    let mut tx = state.db.begin().await?;
    // proving control of the inbox also verifies the address; every old session dies
    sqlx::query("UPDATE users SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1").bind(user_id).bind(&hash).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(user_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- profile, password, sessions, account deletion -----------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileBody {
    pub display_name: Option<String>,
    pub color: Option<String>,
    pub affiliation: Option<String>,
}

pub async fn update_profile(State(state): State<AppState>, user: AuthUser, Json(body): Json<ProfileBody>) -> Result<Json<AuthUser>, AppError> {
    let name = match body.display_name {
        Some(n) => {
            let n = n.trim().to_string();
            if n.is_empty() || n.chars().count() > 60 {
                return Err(AppError::BadRequest("Your name must be between 1 and 60 characters.".into()));
            }
            n
        }
        None => user.display_name.clone(),
    };
    let color = match body.color {
        Some(c) if COLORS.contains(&c.as_str()) => c,
        Some(_) => return Err(AppError::BadRequest("Pick one of the offered cursor colours.".into())),
        None => user.color.clone(),
    };
    let affiliation = match body.affiliation {
        Some(a) => {
            let a = a.trim().to_string();
            if a.chars().count() > 80 || a.chars().any(char::is_control) {
                return Err(AppError::BadRequest("Keep your guild or affiliation to one line of up to 80 characters.".into()));
            }
            a
        }
        None => user.affiliation.clone(),
    };
    sqlx::query("UPDATE users SET display_name = $2, color = $3, affiliation = $4 WHERE id = $1").bind(user.id).bind(&name).bind(&color).bind(&affiliation).execute(&state.db).await?;
    state.forget_identity(user.id);
    Ok(Json(AuthUser { display_name: name, color, affiliation, ..user }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordBody {
    pub current_password: String,
    pub new_password: String,
}

async fn password_hash_of(state: &AppState, user_id: Uuid) -> Result<String, AppError> {
    Ok(sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1").bind(user_id).fetch_one(&state.db).await?)
}

pub async fn change_password(State(state): State<AppState>, user: AuthUser, jar: CookieJar, Json(body): Json<PasswordBody>) -> Result<StatusCode, AppError> {
    throttle(&state, &format!("pw:{}", user.id), 10, Duration::from_secs(900))?;
    check_password(&body.new_password)?;
    if !verify_password(body.current_password, password_hash_of(&state, user.id).await?).await? {
        return Err(AppError::BadRequest("Your current password is not right.".into()));
    }
    let hash = hash_password(body.new_password).await?;
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1").bind(user.id).bind(hash).execute(&state.db).await?;
    // sign every *other* device out
    let current = jar.get(SESSION_COOKIE).map(|c| hash_token(c.value())).unwrap_or_default();
    sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2").bind(user.id).bind(current).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    /// The browser that started this session, as it described itself (may be empty for old sessions).
    pub user_agent: String,
    #[sqlx(skip)]
    pub current: bool,
}

pub async fn list_sessions(State(state): State<AppState>, user: AuthUser, jar: CookieJar) -> Result<Json<Vec<SessionInfo>>, AppError> {
    let mut rows = sqlx::query_as::<_, SessionInfo>("SELECT encode(token_hash, 'hex') AS id, created_at, expires_at, user_agent FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY created_at DESC")
        .bind(user.id)
        .fetch_all(&state.db)
        .await?;
    let current = jar.get(SESSION_COOKIE).map(|c| hex::encode(hash_token(c.value())));
    for r in &mut rows {
        r.current = current.as_deref() == Some(r.id.as_str());
    }
    Ok(Json(rows))
}

pub async fn revoke_session(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> Result<StatusCode, AppError> {
    sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND encode(token_hash, 'hex') = $2").bind(user.id).bind(id).execute(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct DeleteAccountBody {
    pub password: String,
}

/// Permanently deletes the account. Scrolls with other members are handed to the next scribe in
/// line; scrolls with nobody else are removed.
pub async fn delete_account(State(state): State<AppState>, user: AuthUser, jar: CookieJar, Json(body): Json<DeleteAccountBody>) -> Result<(CookieJar, StatusCode), AppError> {
    throttle(&state, &format!("pw:{}", user.id), 10, Duration::from_secs(900))?;
    if !verify_password(body.password, password_hash_of(&state, user.id).await?).await? {
        return Err(AppError::BadRequest("Your password is not right.".into()));
    }
    let mut tx = state.db.begin().await?;
    let owned: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM scrolls WHERE owner_id = $1").bind(user.id).fetch_all(&mut *tx).await?;
    let mut removed = Vec::new();
    for scroll in owned {
        let heir: Option<Uuid> = sqlx::query_scalar("SELECT user_id FROM scroll_members WHERE scroll_id = $1 AND user_id <> $2 ORDER BY (role = 'scribe') DESC, created_at LIMIT 1")
            .bind(scroll)
            .bind(user.id)
            .fetch_optional(&mut *tx)
            .await?;
        let deleted: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar("SELECT deleted_at FROM scrolls WHERE id = $1").bind(scroll).fetch_one(&mut *tx).await?;
        match (heir, deleted) {
            (Some(heir), None) => {
                sqlx::query("DELETE FROM scroll_members WHERE scroll_id = $1 AND user_id = $2").bind(scroll).bind(user.id).execute(&mut *tx).await?;
                sqlx::query("UPDATE scroll_members SET role = 'owner' WHERE scroll_id = $1 AND user_id = $2").bind(scroll).bind(heir).execute(&mut *tx).await?;
                sqlx::query("UPDATE scrolls SET owner_id = $2 WHERE id = $1").bind(scroll).bind(heir).execute(&mut *tx).await?;
            }
            _ => {
                sqlx::query("DELETE FROM scrolls WHERE id = $1").bind(scroll).execute(&mut *tx).await?;
                removed.push(scroll);
            }
        }
    }
    sqlx::query("DELETE FROM users WHERE id = $1").bind(user.id).execute(&mut *tx).await?;
    tx.commit().await?;
    for scroll in removed {
        state.store.remove_room(&scroll.to_string()).await;
    }
    Ok((jar.remove(Cookie::build(SESSION_COOKIE).path("/")), StatusCode::NO_CONTENT))
}


// ---- magic links ---------------------------------------------------------------------------

const MAGIC_TTL_MINUTES: i64 = 15;

/// `POST /api/auth/magic`: email a one-time sign-in link. The answer is the same whether or not the address
/// has an account, so nobody can find out who is registered.
pub async fn request_magic_link(State(state): State<AppState>, ip: ClientIp, Json(body): Json<ForgotBody>) -> Result<StatusCode, AppError> {
    throttle_ip(&state, &ip)?;
    let email = body.email.trim().to_lowercase();
    throttle(&state, &format!("magic:{email}"), 5, Duration::from_secs(3600))?;
    #[derive(FromRow)]
    struct Row {
        id: Uuid,
        display_name: String,
    }
    if let Some(u) = sqlx::query_as::<_, Row>("SELECT id, display_name FROM users WHERE lower(email) = $1").bind(&email).fetch_optional(&state.db).await? {
        sqlx::query("UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND kind = 'magic' AND used_at IS NULL").bind(u.id).execute(&state.db).await?; // only the newest link works
        let token = create_email_token_for(&state, u.id, "magic", MAGIC_TTL_MINUTES).await?;
        let link = format!("{}/magic?token={token}", state.config.public_url);
        let sent = state
            .mailer
            .send(&email, "Your Gilded Quill sign-in link", &format!("Hello {},\n\nOpen this link to step into the tavern, no password needed:\n\n{link}\n\nIt works once and expires in {MAGIC_TTL_MINUTES} minutes. If you did not ask for it, ignore this email.", u.display_name))
            .await;
        if let Err(e) = sent {
            tracing::error!(error = ?e, "could not send magic link email");
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/auth/magic/consume`: trade the link's token for a session. Opening the link also proves the address is theirs.
pub async fn use_magic_link(State(state): State<AppState>, ip: ClientIp, ua: UserAgent, jar: CookieJar, Json(body): Json<TokenBody>) -> Result<(CookieJar, Json<AuthUser>), AppError> {
    throttle_ip(&state, &ip)?;
    let user_id = consume_email_token(&state, &body.token, "magic").await?.ok_or_else(|| AppError::BadRequest("That sign-in link has expired or was already used.".into()))?;
    sqlx::query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1").bind(user_id).execute(&state.db).await?;
    let user = sqlx::query_as::<_, AuthUser>("SELECT id, email, display_name, color, (email_verified_at IS NOT NULL) AS email_verified, affiliation FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;
    let jar = start_session(&state, jar, user_id, &ua.0).await?;
    Ok((jar, Json(user)))
}
