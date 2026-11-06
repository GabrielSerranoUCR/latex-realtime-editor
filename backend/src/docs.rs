//! The documents of a scroll over plain HTTP, for programs: list the files, read one (or some lines of it),
//! write one, change a piece of one, delete one. This is what the MCP server uses to let an AI assistant
//! work on a scroll. Changes go into the live shared document, so everyone who has the scroll open sees them
//! at once, like any other scribe's typing.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;
use yrs::{Doc, GetString, Map, Out, Text, Transact};

use crate::{AppState, auth::{AuthUser, ViaToken}, error::AppError, proposals, scrolls::require_role, versions::set_file};

/// The same limit as uploading a text file in the browser.
const MAX_FILE_BYTES: usize = 1024 * 1024;
const TEXT_EXTENSIONS: [&str; 7] = ["tex", "bib", "sty", "cls", "def", "md", "txt"];

/// A path a text file may have: relative, inside the scroll, made of plain names, with a text extension.
pub fn clean_text_path(raw: &str) -> Result<String, AppError> {
    let path = raw.trim_matches('/');
    let bad = |why: &str| AppError::BadRequest(format!("“{raw}” is not a usable file name: {why}."));
    if path.is_empty() || path.len() > 200 {
        return Err(bad("it must be 1 to 200 characters"));
    }
    for seg in path.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || !seg.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '-' | ' ')) {
            return Err(bad("use letters, digits, spaces and _ . - in names, and / between folders"));
        }
    }
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    if !TEXT_EXTENSIONS.contains(&ext.as_str()) {
        return Err(bad(&format!("text files end in {}", TEXT_EXTENSIONS.map(|e| format!(".{e}")).join(", "))));
    }
    Ok(path.to_string())
}

fn lines_of(text: &str) -> usize {
    if text.is_empty() { 0 } else { text.matches('\n').count() + usize::from(!text.ends_with('\n')) }
}

fn read_all(doc: &Doc) -> Vec<(String, String)> {
    let files = doc.get_or_insert_map("files");
    let txn = doc.transact();
    let mut out: Vec<(String, String)> = files
        .iter(&txn)
        .filter_map(|(name, value)| match value {
            Out::YText(t) => Some((name.to_string(), t.get_string(&txn))),
            _ => None,
        })
        .collect();
    out.sort();
    out
}

fn main_file(doc: &Doc) -> String {
    let meta = doc.get_or_insert_map("meta");
    let txn = doc.transact();
    match meta.get(&txn, "main") {
        Some(Out::Any(yrs::Any::String(s))) => s.to_string(),
        _ => "main.tex".to_string(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSummary {
    pub path: String,
    pub bytes: usize,
    pub lines: usize,
}

#[derive(Debug, Serialize, FromRow)]
pub struct AssetSummary {
    pub path: String,
    pub size: i64,
    pub mime: String,
}

#[derive(Debug, Serialize)]
pub struct FileList {
    pub main: String,
    pub files: Vec<FileSummary>,
    /// Pictures and PDFs (not readable as text, but they can be used with \includegraphics).
    pub assets: Vec<AssetSummary>,
}

/// `GET /api/scrolls/{id}/files`
pub async fn list(State(state): State<AppState>, user: AuthUser, Path(id): Path<Uuid>) -> Result<Json<FileList>, AppError> {
    require_role(&state.db, id, user.id).await?;
    let doc = state.rooms.doc(&id.to_string()).await?;
    let files = read_all(&doc).into_iter().map(|(path, text)| FileSummary { bytes: text.len(), lines: lines_of(&text), path }).collect();
    let assets = sqlx::query_as::<_, AssetSummary>("SELECT path, size, mime FROM scroll_assets WHERE scroll_id = $1 ORDER BY path").bind(id).fetch_all(&state.db).await?;
    Ok(Json(FileList { main: main_file(&doc), files, assets }))
}

#[derive(Debug, Deserialize)]
pub struct RangeQuery {
    /// First line to return (1-based).
    pub start: Option<usize>,
    /// Last line to return, inclusive.
    pub end: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub bytes: usize,
    pub total_lines: usize,
    pub start_line: usize,
    pub end_line: usize,
}

/// `GET /api/scrolls/{id}/files/{*path}?start=&end=`
pub async fn read(State(state): State<AppState>, user: AuthUser, Path((id, raw)): Path<(Uuid, String)>, Query(q): Query<RangeQuery>) -> Result<Json<FileContent>, AppError> {
    require_role(&state.db, id, user.id).await?;
    let path = raw.trim_matches('/').to_string();
    let doc = state.rooms.doc(&id.to_string()).await?;
    let text = read_all(&doc).into_iter().find(|(p, _)| *p == path).map(|(_, t)| t).ok_or(AppError::NotFound)?;
    let total = lines_of(&text);
    let (start, end) = (q.start.unwrap_or(1).max(1), q.end.unwrap_or(usize::MAX));
    if q.start.is_none() && q.end.is_none() {
        return Ok(Json(FileContent { path, bytes: text.len(), content: text, total_lines: total, start_line: 1.min(total), end_line: total }));
    }
    if end < start {
        return Err(AppError::BadRequest("`end` must not be before `start`.".into()));
    }
    let slice: Vec<&str> = text.split_inclusive('\n').skip(start - 1).take(end.saturating_sub(start) + 1).collect();
    let content = slice.concat();
    let end_line = (start - 1 + slice.len()).min(total);
    Ok(Json(FileContent { path, bytes: text.len(), content, total_lines: total, start_line: if slice.is_empty() { 0 } else { start }, end_line: if slice.is_empty() { 0 } else { end_line } }))
}

/// One change to a scroll's files. It is applied at once, or (for an assistant's token on a scroll that wants to
/// review) kept as a proposal until a person accepts it.
#[derive(Debug, Clone)]
pub enum Change {
    Write { path: String, content: String },
    Edit { path: String, old: String, new: String, all: bool },
    Delete { path: String },
}

impl Change {
    pub fn path(&self) -> &str {
        match self {
            Change::Write { path, .. } | Change::Edit { path, .. } | Change::Delete { path } => path,
        }
    }
}

/// Where `old` occurs in `current`, or why the edit cannot be made.
fn plan_edit(current: &str, old: &str, new: &str, all: bool) -> Result<Vec<usize>, AppError> {
    let at: Vec<usize> = current.match_indices(old).map(|(i, _)| i).collect();
    if at.is_empty() {
        return Err(AppError::Conflict("`oldText` was not found in the file. Read the file again: it may have changed, and the text must match exactly, spaces and line breaks included.".into()));
    }
    if at.len() > 1 && !all {
        return Err(AppError::Conflict(format!("`oldText` appears {} times. Include more of the surrounding text so it is unique, or set `replaceAll`.", at.len())));
    }
    if current.len() + at.len() * new.len() - at.len() * old.len() > MAX_FILE_BYTES {
        return Err(AppError::BadRequest("That would make the file larger than 1 MB.".into()));
    }
    Ok(at)
}

fn current_text(doc: &Doc, path: &str) -> Option<String> {
    read_all(doc).into_iter().find(|(p, _)| p == path).map(|(_, t)| t)
}

/// Can this change be made right now? The same checks as applying it, without doing it (so an assistant hears
/// about a mistake straight away instead of leaving a doomed proposal).
pub async fn check(state: &AppState, scroll: Uuid, change: &Change) -> Result<(), AppError> {
    let doc = state.rooms.doc(&scroll.to_string()).await?;
    match change {
        Change::Write { path, content } => {
            if content.len() > MAX_FILE_BYTES {
                return Err(AppError::BadRequest("A text file can be at most 1 MB.".into()));
            }
            let clash: Option<i32> = sqlx::query_scalar("SELECT 1 FROM scroll_assets WHERE scroll_id = $1 AND path = $2").bind(scroll).bind(path).fetch_optional(&state.db).await?;
            if clash.is_some() {
                return Err(AppError::Conflict(format!("“{path}” is already a picture or PDF in this scroll.")));
            }
        }
        Change::Edit { path, old, new, all } => {
            let text = current_text(&doc, path).ok_or(AppError::NotFound)?;
            plan_edit(&text, old, new, *all)?;
        }
        Change::Delete { path } => {
            current_text(&doc, path).ok_or(AppError::NotFound)?;
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub path: String,
    pub bytes: usize,
    pub created: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edited {
    pub path: String,
    pub replacements: usize,
    pub bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Applied {
    Written(Written),
    Edited(Edited),
    Deleted { path: String, deleted: bool },
}

/// Make the change in the live shared document.
pub async fn apply(state: &AppState, scroll: Uuid, change: &Change) -> Result<Applied, AppError> {
    check(state, scroll, change).await?;
    let room = scroll.to_string();
    match change {
        Change::Write { path, content } => {
            let created = state
                .rooms
                .mutate(&room, |doc| {
                    let files = doc.get_or_insert_map("files");
                    let existed = {
                        let txn = doc.transact();
                        files.get(&txn, path).is_some()
                    };
                    let mut txn = doc.transact_mut();
                    set_file(&files, &mut txn, path, content);
                    !existed
                })
                .await?;
            Ok(Applied::Written(Written { bytes: content.len(), path: path.clone(), created }))
        }
        Change::Edit { path, old, new, all } => {
            let outcome = state
                .rooms
                .mutate(&room, |doc| -> Result<(usize, usize), AppError> {
                    let files = doc.get_or_insert_map("files");
                    let mut txn = doc.transact_mut();
                    let Some(Out::YText(text)) = files.get(&txn, path) else { return Err(AppError::NotFound) };
                    let current = text.get_string(&txn);
                    let at = plan_edit(&current, old, new, *all)?;
                    for &pos in at.iter().rev() {
                        text.remove_range(&mut txn, pos as u32, old.len() as u32);
                        if !new.is_empty() {
                            text.insert(&mut txn, pos as u32, new);
                        }
                    }
                    Ok((at.len(), current.len() + at.len() * new.len() - at.len() * old.len()))
                })
                .await?;
            let (replacements, bytes) = outcome?;
            Ok(Applied::Edited(Edited { path: path.clone(), replacements, bytes }))
        }
        Change::Delete { path } => {
            let done = state
                .rooms
                .mutate(&room, |doc| {
                    let was_main = main_file(doc) == *path;
                    let files = doc.get_or_insert_map("files");
                    let mut txn = doc.transact_mut();
                    let removed = files.remove(&mut txn, path).is_some();
                    if removed && was_main {
                        // the entry file is gone: hand the role to another source (a .tex if there is one) so compiling still has a target
                        let mut rest: Vec<String> = files.keys(&txn).map(String::from).collect();
                        rest.sort();
                        let meta = doc.get_or_insert_map("meta");
                        match rest.iter().find(|p| p.ends_with(".tex")).or(rest.first()) {
                            Some(next) => {
                                meta.insert(&mut txn, "main", next.as_str());
                            }
                            None => {
                                meta.remove(&mut txn, "main");
                            }
                        }
                    }
                    removed
                })
                .await?;
            if !done {
                return Err(AppError::NotFound);
            }
            Ok(Applied::Deleted { path: path.clone(), deleted: true })
        }
    }
}

/// Apply it now, or (an assistant's token, on a scroll set to review) leave it for a person to accept.
async fn route(state: &AppState, user: &AuthUser, via: &ViaToken, scroll: Uuid, change: Change, note: &str) -> Result<Response, AppError> {
    if let Some(token) = &via.0 {
        let mode: String = sqlx::query_scalar("SELECT ai_edit_mode FROM scrolls WHERE id = $1").bind(scroll).fetch_one(&state.db).await?;
        if mode == "review" {
            check(state, scroll, &change).await?;
            let id = proposals::create(state, scroll, user.id, token, &change, note).await?;
            let body = serde_json::json!({
                "queued": true,
                "proposalId": id,
                "message": "This scroll holds edits from assistants for review. A person must accept this one in the app; it is not in the document yet.",
            });
            return Ok((StatusCode::ACCEPTED, Json(body)).into_response());
        }
    }
    Ok(Json(apply(state, scroll, &change).await?).into_response())
}

#[derive(Debug, Deserialize)]
pub struct WriteBody {
    pub content: String,
    /// Why (shown to the person who reviews it).
    #[serde(default)]
    pub note: String,
}

/// `PUT /api/scrolls/{id}/files/{*path}`: create the file, or give an existing one this whole text.
pub async fn write(State(state): State<AppState>, user: AuthUser, via: ViaToken, Path((id, raw)): Path<(Uuid, String)>, Json(body): Json<WriteBody>) -> Result<Response, AppError> {
    if !require_role(&state.db, id, user.id).await?.can_write() {
        return Err(AppError::Forbidden);
    }
    let path = clean_text_path(&raw)?;
    route(&state, &user, &via, id, Change::Write { path, content: body.content }, &body.note).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditBody {
    /// The exact text to find (including whitespace and line breaks).
    pub old_text: String,
    pub new_text: String,
    /// Change every occurrence (otherwise it must occur exactly once).
    #[serde(default)]
    pub replace_all: bool,
    #[serde(default)]
    pub note: String,
}

/// `PATCH /api/scrolls/{id}/files/{*path}`: replace `oldText` with `newText`. Only that part of the file changes,
/// so what others are typing elsewhere in it is untouched.
pub async fn edit(State(state): State<AppState>, user: AuthUser, via: ViaToken, Path((id, raw)): Path<(Uuid, String)>, Json(body): Json<EditBody>) -> Result<Response, AppError> {
    if !require_role(&state.db, id, user.id).await?.can_write() {
        return Err(AppError::Forbidden);
    }
    if body.old_text.is_empty() {
        return Err(AppError::BadRequest("`oldText` must not be empty (to write a whole file use PUT).".into()));
    }
    if body.old_text == body.new_text {
        return Err(AppError::BadRequest("`oldText` and `newText` are the same: nothing to change.".into()));
    }
    let change = Change::Edit { path: raw.trim_matches('/').to_string(), old: body.old_text, new: body.new_text, all: body.replace_all };
    route(&state, &user, &via, id, change, &body.note).await
}

/// `DELETE /api/scrolls/{id}/files/{*path}`. Deleting the main file is allowed: another source becomes the main file.
pub async fn remove(State(state): State<AppState>, user: AuthUser, via: ViaToken, Path((id, raw)): Path<(Uuid, String)>) -> Result<Response, AppError> {
    if !require_role(&state.db, id, user.id).await?.can_write() {
        return Err(AppError::Forbidden);
    }
    route(&state, &user, &via, id, Change::Delete { path: raw.trim_matches('/').to_string() }, "").await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_checked() {
        assert_eq!(clean_text_path("chapters/intro.tex").unwrap(), "chapters/intro.tex");
        assert_eq!(clean_text_path("/main.tex/").unwrap(), "main.tex");
        for bad in ["", "../x.tex", "a/../b.tex", "a//b.tex", "x.exe", "noext", "a\\b.tex", "na\u{0}me.tex"] {
            assert!(clean_text_path(bad).is_err(), "{bad:?}");
        }
        assert!(clean_text_path(&format!("{}.tex", "a".repeat(200))).is_err());
    }

    #[test]
    fn counts_lines_like_an_editor() {
        assert_eq!(lines_of(""), 0);
        assert_eq!(lines_of("a"), 1);
        assert_eq!(lines_of("a\n"), 1);
        assert_eq!(lines_of("a\nb"), 2);
        assert_eq!(lines_of("a\n\nb\n"), 3);
    }
}
