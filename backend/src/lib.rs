//! Quill server: real-time collaboration (Yjs/y-sync over WebSockets) and LaTeX compilation.

pub mod api;
pub mod assistants;
pub mod auth;
pub mod compile;
pub mod config;
pub mod db;
pub mod docs;
pub mod error;
pub mod invites;
pub mod links;
pub mod mail;
pub mod notes;
pub mod proposals;
pub mod ratelimit;
pub mod requests;
pub mod rooms;
pub mod scrolls;
pub mod store;
pub mod synctex;
pub mod tokens;
pub mod versions;
pub mod assets;
pub mod ws;

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{HeaderValue, Method, header},
    middleware,
    routing::{delete, get, post, put},
};
use sqlx::PgPool;
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::{compile::Compiler, config::Config, mail::Mailer, ratelimit::RateLimiter, rooms::RoomManager, store::FsStore};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub rooms: Arc<RoomManager>,
    pub store: Arc<FsStore>,
    pub compiler: Arc<Compiler>,
    pub db: PgPool,
    pub mailer: Arc<Mailer>,
    pub limiter: Arc<RateLimiter>,
    pub assistants: Arc<assistants::Assistants>,
    conn_counter: Arc<AtomicU64>,
    identities: Arc<Mutex<HashMap<uuid::Uuid, (Instant, String, String)>>>,
}

impl AppState {
    /// A scribe's name and cursor colour *now* (they may have edited their profile since they connected).
    /// Cached for a few seconds so a busy cursor does not turn into a busy database.
    pub async fn current_identity(&self, user: &auth::AuthUser) -> (String, String) {
        const TTL: Duration = Duration::from_secs(5);
        if let Some((at, name, color)) = self.identities.lock().unwrap().get(&user.id) {
            if at.elapsed() < TTL {
                return (name.clone(), color.clone());
            }
        }
        let fresh: Option<(String, String)> = sqlx::query_as("SELECT display_name, color FROM users WHERE id = $1").bind(user.id).fetch_optional(&self.db).await.ok().flatten();
        let (name, color) = fresh.unwrap_or_else(|| (user.display_name.clone(), user.color.clone()));
        self.identities.lock().unwrap().insert(user.id, (Instant::now(), name.clone(), color.clone()));
        (name, color)
    }

    /// Forget a cached identity (their profile just changed).
    pub fn forget_identity(&self, user_id: uuid::Uuid) {
        self.identities.lock().unwrap().remove(&user_id);
    }

    pub fn new(config: Config, db: PgPool) -> Self {
        let store = Arc::new(FsStore::new(&config.data_dir));
        let rooms = RoomManager::new(store.clone(), config.persist_debounce, Some(db.clone()), config.version_interval);
        let mailer = Arc::new(match &config.smtp_url {
            Some(url) => Mailer::smtp(url, &config.mail_from).expect("valid QUILL_SMTP_URL / QUILL_MAIL_FROM"),
            None => Mailer::outbox(config.data_dir.join("outbox")),
        });
        let compiler = Arc::new(Compiler::new(config.tectonic_bin.clone(), config.compile_workers, config.compile_timeout));
        Self { config: Arc::new(config), rooms, store, compiler, db, mailer, limiter: Arc::new(RateLimiter::new()), assistants: Arc::new(assistants::Assistants::default()), conn_counter: Arc::new(AtomicU64::new(1)), identities: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub fn next_conn_id(&self) -> u64 {
        self.conn_counter.fetch_add(1, Ordering::Relaxed)
    }
}

pub fn router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(state.config.allowed_origin.parse::<HeaderValue>().expect("valid QUILL_ALLOWED_ORIGIN"))
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::PUT, Method::DELETE])
        .allow_headers([header::CONTENT_TYPE])
        .allow_credentials(true);

    Router::new()
        .route("/healthz", get(api::healthz))
        .route("/ws/{room}", get(ws::ws_handler))
        .route("/api/auth/signup", post(auth::signup))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/verify", post(auth::verify_email))
        .route("/api/auth/resend-verification", post(auth::resend_verification))
        .route("/api/auth/forgot", post(auth::forgot_password))
        .route("/api/auth/reset", post(auth::reset_password))
        .route("/api/auth/magic", post(auth::request_magic_link))
        .route("/api/auth/magic/consume", post(auth::use_magic_link))
        .route("/api/me", get(auth::me).patch(auth::update_profile).delete(auth::delete_account))
        .route("/api/me/password", post(auth::change_password))
        .route("/api/me/tokens", get(tokens::list).post(tokens::create))
        .route("/api/me/tokens/{id}", delete(tokens::revoke))
        .route("/api/me/sessions", get(auth::list_sessions))
        .route("/api/me/sessions/{id}", delete(auth::revoke_session))
        .route("/api/invitations", get(invites::mine))
        .route("/api/invitations/{id}", get(invites::get_mine).delete(invites::decline))
        .route("/api/invitations/{id}/accept", post(invites::accept))
        .route("/api/scrolls/{id}/door", get(requests::door))
        .route("/api/scrolls/{id}/requests", get(requests::list).post(requests::ask))
        .route("/api/scrolls/{id}/requests/{user}/approve", post(requests::approve))
        .route("/api/scrolls/{id}/requests/{user}", delete(requests::decline))
        .route("/api/links/{token}", get(links::preview))
        .route("/api/links/{token}/join", post(links::join))
        .route("/api/scrolls/{id}/links", get(links::list))
        .route("/api/scrolls/{id}/links/{role}", put(links::put).delete(links::remove))
        .route("/api/scrolls", get(scrolls::list).post(scrolls::create))
        .route("/api/scrolls/{id}", get(scrolls::get).patch(scrolls::rename).delete(scrolls::delete))
        .route("/api/scrolls/{id}/members", get(scrolls::members))
        .route("/api/scrolls/{id}/invitations", get(invites::list_for_scroll).post(invites::create))
        .route("/api/scrolls/{id}/invitations/{inv}", delete(invites::revoke))
        .route("/api/scrolls/{id}/members/{user}", put(scrolls::set_role).delete(scrolls::remove_member))
        .route("/api/scrolls/{id}/proposals", get(proposals::list))
        .route("/api/scrolls/{id}/proposals/{pid}", get(proposals::get))
        .route("/api/scrolls/{id}/proposals/{pid}/accept", post(proposals::accept))
        .route("/api/scrolls/{id}/proposals/{pid}/reject", post(proposals::reject))
        .route("/api/scrolls/{id}/ai-mode", put(proposals::set_mode))
        .route("/api/scrolls/{id}/notes", get(notes::list).post(notes::create))
        .route("/api/scrolls/{id}/notes/{tid}/replies", post(notes::reply))
        .route("/api/scrolls/{id}/notes/{tid}/resolved", put(notes::resolve))
        .route("/api/scrolls/{id}/files", get(docs::list))
        .route("/api/scrolls/{id}/files/{*path}", get(docs::read).put(docs::write).patch(docs::edit).delete(docs::remove))
        .route("/api/scrolls/{id}/assets", get(assets::list))
        .route("/api/scrolls/{id}/assets/{*path}", put(assets::put).get(assets::get).delete(assets::remove).layer(DefaultBodyLimit::max(state.config.max_asset_bytes + 1024)))
        .route("/api/scrolls/{id}/asset-moves", post(assets::relocate))
        .route("/api/scrolls/{id}/versions", get(versions::list).post(versions::create))
        .route("/api/scrolls/{id}/versions/{vid}", get(versions::get).patch(versions::rename).delete(versions::delete))
        .route("/api/scrolls/{id}/versions/{vid}/restore", post(versions::restore))
        .route("/api/rooms/{room}/compile", post(api::compile))
        .route("/api/rooms/{room}/pdf", get(api::latest_pdf))
        .route("/api/rooms/{room}/synctex", get(api::synctex_lookup))
        .layer(middleware::from_fn_with_state(state.clone(), assistants::track))
        .layer(middleware::from_fn_with_state(state.clone(), auth::origin_guard))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
