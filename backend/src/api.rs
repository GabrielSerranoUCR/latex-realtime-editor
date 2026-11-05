use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use yrs::{GetString, Map, Out, Transact};

use crate::{
    AppState,
    auth::AuthUser,
    compile::Diagnostic,
    error::{AppError, parse_room_id},
    scrolls::require_role,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResponse {
    pub ok: bool,
    pub pdf_url: Option<String>,
    pub log: String,
    pub diagnostics: Vec<Diagnostic>,
    pub duration_ms: u128,
    pub built_at: u64,
}

pub async fn healthz() -> &'static str {
    "ok"
}

/// Optional body of the compile request: the source to compile instead of the scroll's main file.
#[derive(Debug, Default, serde::Deserialize)]
pub struct CompileRequest {
    pub main: Option<String>,
}

/// `POST /api/rooms/{room}/compile` — compile the room's current files with Tectonic.
///
/// The document model is: `files` (Y.Map path -> Y.Text) and `meta` (Y.Map; `main` = entry file).
pub async fn compile(State(state): State<AppState>, user: AuthUser, Path(room_id): Path<String>, body: Option<Json<CompileRequest>>) -> Result<Json<CompileResponse>, AppError> {
    let scroll_id = parse_room_id(&room_id)?;
    if !require_role(&state.db, scroll_id, user.id).await?.can_compile() {
        return Err(AppError::Forbidden);
    }
    let room_id = scroll_id.to_string();
    let doc = state.rooms.doc(&room_id).await?;

    let (files, main) = {
        // Root types must be resolved *before* opening a read transaction: creating one needs
        // the document's write lock and would deadlock against our own read lock.
        let files_map = doc.get_or_insert_map("files");
        let meta = doc.get_or_insert_map("meta");
        let txn = doc.transact();
        let mut files = Vec::new();
        for (name, value) in files_map.iter(&txn) {
            if let Out::YText(text) = value {
                files.push((name.to_string(), text.get_string(&txn)));
            }
        }
        let main = match meta.get(&txn, "main") {
            Some(Out::Any(yrs::Any::String(s))) => s.to_string(),
            _ => "main.tex".to_string(),
        };
        (files, main)
    };
    if files.is_empty() {
        return Err(AppError::NothingToCompile);
    }
    // the file the scribe has selected is the one that compiles (when it is a .tex source in this scroll)
    let main = match body.and_then(|b| b.0.main) {
        Some(m) if m.ends_with(".tex") && files.iter().any(|(name, _)| *name == m) => m,
        _ => main,
    };

    let asset_paths: Vec<String> = sqlx::query_scalar("SELECT path FROM scroll_assets WHERE scroll_id = $1").bind(scroll_id).fetch_all(&state.db).await?;
    let assets: Vec<(String, std::path::PathBuf)> = asset_paths.into_iter().map(|p| { let src = state.store.asset_path(&room_id, &p); (p, src) }).collect();
    let result = state.compiler.compile(&files, &assets, &main).await?;
    let built_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let pdf_url = if let Some(pdf) = &result.pdf {
        state.store.save_pdf(&room_id, pdf).await.context("saving pdf")?;
        Some(format!("/api/rooms/{room_id}/pdf?v={built_at}"))
    } else {
        None
    };
    Ok(Json(CompileResponse {
        ok: result.success,
        pdf_url,
        log: result.log,
        diagnostics: result.diagnostics,
        duration_ms: result.duration.as_millis(),
        built_at,
    }))
}

/// `GET /api/rooms/{room}/pdf` — the most recent successful build.
pub async fn latest_pdf(State(state): State<AppState>, user: AuthUser, Path(room_id): Path<String>) -> Result<Response, AppError> {
    let scroll_id = parse_room_id(&room_id)?;
    require_role(&state.db, scroll_id, user.id).await?; // any member may read the PDF
    let room_id = scroll_id.to_string();
    let bytes = state.store.load_pdf(&room_id).await.context("reading pdf")?.ok_or(AppError::PdfNotFound)?;
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("application/pdf")),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        bytes,
    )
        .into_response())
}
