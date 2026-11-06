//! Margin notes over plain HTTP, for programs (the MCP server): list them, start a note on some lines, reply to
//! one, mark one resolved or open again. The notes live in the scroll's shared document, in the same shape the
//! browser writes them, so everyone with the scroll open sees them at once.
//!
//! Notes do not change the text of any file, so they are not held for review like an assistant's edits.

use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use yrs::{Any, ArrayPrelim, Assoc, Doc, GetString, IndexedSequence, Map, MapPrelim, Out, ReadTxn, StickyIndex, Transact, TransactionMut, Array, In};

use crate::{AppState, auth::{AuthUser, ViaToken}, error::AppError, scrolls::require_role};

const ROOT: &str = "comments";
const MAX_NOTE_CHARS: usize = 2000;
const MAX_QUOTE_CHARS: usize = 60;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteMessage {
    pub id: String,
    pub author: String,
    pub text: String,
    /// Epoch milliseconds.
    pub at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteThread {
    pub id: String,
    pub file: String,
    /// First line the note is about, now (1-based); none when that text is gone.
    pub line: Option<usize>,
    pub quote: String,
    pub resolved: bool,
    pub resolved_by: Option<String>,
    pub created_at: i64,
    pub messages: Vec<NoteMessage>,
}

fn json_of(out: Out, txn: &impl ReadTxn) -> serde_json::Value {
    let mut buf = String::new();
    yrs::types::ToJson::to_json(&out, txn).to_json(&mut buf);
    serde_json::from_str(&buf).unwrap_or(serde_json::Value::Null)
}

fn text_of(v: &serde_json::Value, key: &str, max: usize) -> String {
    v.get(key).and_then(|s| s.as_str()).map(|s| s.chars().take(max).collect()).unwrap_or_default()
}

fn line_of(text: &str, index: usize) -> usize {
    1 + text.as_bytes()[..index.min(text.len())].iter().filter(|b| **b == b'\n').count()
}

/// Every thread, in the order they were written.
fn read_threads(doc: &Doc) -> Vec<NoteThread> {
    let comments = doc.get_or_insert_map(ROOT);
    let files = doc.get_or_insert_map("files");
    let txn = doc.transact();
    let mut out = Vec::new();
    for (key, value) in comments.iter(&txn) {
        let Out::YMap(t) = value else { continue };
        let Some(Out::YArray(messages)) = t.get(&txn, "messages") else { continue };
        let messages: Vec<NoteMessage> = messages
            .iter(&txn)
            .filter_map(|m| {
                let m = json_of(m, &txn);
                Some(NoteMessage { id: text_of(&m, "id", 64), author: text_of(&m, "authorName", 80), text: text_of(&m, "text", MAX_NOTE_CHARS), at: m.get("at")?.as_f64()? as i64 })
            })
            .collect();
        let Some(Out::Any(Any::String(file))) = t.get(&txn, "file") else { continue };
        if messages.is_empty() {
            continue;
        }
        let file = file.to_string();
        let line = match (t.get(&txn, "start"), files.get(&txn, &file)) {
            (Some(start), Some(Out::YText(text))) => serde_json::from_value::<StickyIndex>(json_of(start, &txn))
                .ok()
                .and_then(|s| s.get_offset(&txn))
                .map(|o| line_of(&text.get_string(&txn), o.index as usize)),
            _ => None,
        };
        let created = match t.get(&txn, "createdAt") {
            Some(Out::Any(Any::Number(n))) => n.as_f64().map_or(messages[0].at, |f| f as i64),
            _ => messages[0].at,
        };
        out.push(NoteThread {
            id: match t.get(&txn, "id") { Some(Out::Any(Any::String(s))) => s.to_string(), _ => key.to_string() },
            file,
            line,
            quote: match t.get(&txn, "quote") { Some(Out::Any(Any::String(s))) => s.to_string(), _ => String::new() },
            resolved: matches!(t.get(&txn, "resolved"), Some(Out::Any(Any::Bool(true)))),
            resolved_by: match t.get(&txn, "resolvedBy") { Some(Out::Any(Any::String(s))) => Some(s.to_string()), _ => None },
            created_at: created,
            messages,
        });
    }
    out.sort_by_key(|t| t.created_at);
    out
}

fn author_name(user: &AuthUser, via: &ViaToken) -> String {
    match &via.0 {
        Some(token) if !token.is_empty() => format!("{} (assistant · {token})", user.display_name),
        Some(_) => format!("{} (assistant)", user.display_name),
        None => user.display_name.clone(),
    }
}

fn clean(text: &str) -> Result<String, AppError> {
    let t = text.trim();
    if t.is_empty() {
        return Err(AppError::BadRequest("The note is empty.".into()));
    }
    Ok(t.chars().take(MAX_NOTE_CHARS).collect())
}

fn message(user: &AuthUser, via: &ViaToken, text: &str) -> Result<Any, AppError> {
    let value = serde_json::json!({
        "id": Uuid::new_v4().to_string(),
        "authorId": user.id.to_string(),
        "authorName": author_name(user, via),
        "authorColor": user.color,
        "text": clean(text)?,
        "at": chrono::Utc::now().timestamp_millis(),
    });
    Any::from_json(&value.to_string()).map_err(|_| AppError::BadRequest("Could not write the note.".into()))
}

async fn writer(state: &AppState, scroll: Uuid, user: &AuthUser) -> Result<(), AppError> {
    if require_role(&state.db, scroll, user.id).await?.can_write() { Ok(()) } else { Err(AppError::Forbidden) }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    pub file: Option<String>,
    /// Include resolved threads (default: only open ones).
    #[serde(default)]
    pub include_resolved: bool,
}

/// `GET /api/scrolls/{id}/notes?file=&includeResolved=`
pub async fn list(State(state): State<AppState>, user: AuthUser, Path(id): Path<Uuid>, Query(q): Query<ListQuery>) -> Result<Json<Vec<NoteThread>>, AppError> {
    require_role(&state.db, id, user.id).await?;
    let doc = state.rooms.doc(&id.to_string()).await?;
    let all = read_threads(&doc);
    Ok(Json(all.into_iter().filter(|t| (q.include_resolved || !t.resolved) && q.file.as_ref().is_none_or(|f| *f == t.file)).collect()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNote {
    pub file: String,
    /// First line the note is about (1-based).
    pub line: usize,
    /// Last line, inclusive (default: the same line).
    pub end_line: Option<usize>,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub id: String,
}

fn sticky(text: &yrs::TextRef, txn: &TransactionMut, index: u32, assoc: Assoc) -> Result<Any, AppError> {
    let s = text.sticky_index(txn, index, assoc).ok_or_else(|| AppError::BadRequest("That place is not in the file.".into()))?;
    Any::from_json(&serde_json::to_string(&s).map_err(|_| AppError::BadRequest("Could not anchor the note.".into()))?).map_err(|_| AppError::BadRequest("Could not anchor the note.".into()))
}

/// Put a new thread on lines `line..=end_line` of `file`.
fn add_thread(doc: &Doc, file: &str, line: usize, end_line: usize, first: Any, thread: &str) -> Result<(), AppError> {
    let files = doc.get_or_insert_map("files");
    let comments = doc.get_or_insert_map(ROOT);
    let mut txn = doc.transact_mut();
    let Some(Out::YText(text)) = files.get(&txn, file) else { return Err(AppError::NotFound) };
    let source = text.get_string(&txn);
    let starts: Vec<usize> = std::iter::once(0).chain(source.match_indices('\n').map(|(i, _)| i + 1)).collect();
    let total = if source.ends_with('\n') { starts.len() - 1 } else { starts.len() };
    if line > total.max(1) {
        return Err(AppError::BadRequest(format!("{file} has {total} lines; line {line} is past the end.")));
    }
    let from = starts[line - 1];
    let to = if end_line >= total { source.len() - usize::from(source.ends_with('\n')) } else { starts[end_line] - 1 };
    let quote: String = {
        let raw = source[from..to].split_whitespace().collect::<Vec<_>>().join(" ");
        if raw.chars().count() > MAX_QUOTE_CHARS { raw.chars().take(MAX_QUOTE_CHARS - 1).collect::<String>().trim_end().to_string() + "…" } else { raw }
    };
    let start = sticky(&text, &txn, from as u32, Assoc::After)?;
    let end = sticky(&text, &txn, to as u32, Assoc::Before)?;
    let t = MapPrelim::from([
        ("id".to_string(), In::Any(Any::from(thread.to_string()))),
        ("file".to_string(), In::Any(Any::from(file.to_string()))),
        ("start".to_string(), In::Any(start)),
        ("end".to_string(), In::Any(end)),
        ("quote".to_string(), In::Any(Any::from(quote))),
        ("resolved".to_string(), In::Any(Any::from(false))),
        ("resolvedBy".to_string(), In::Any(Any::Null)),
        ("createdAt".to_string(), In::Any(Any::from(chrono::Utc::now().timestamp_millis() as f64))),
        ("messages".to_string(), In::from(ArrayPrelim::from([first]))),
    ]);
    comments.insert(&mut txn, thread.to_string(), t);
    Ok(())
}

/// `POST /api/scrolls/{id}/notes`: start a note on some lines of a file.
pub async fn create(State(state): State<AppState>, user: AuthUser, via: ViaToken, Path(id): Path<Uuid>, Json(body): Json<NewNote>) -> Result<Json<Created>, AppError> {
    writer(&state, id, &user).await?;
    let first = message(&user, &via, &body.text)?;
    let thread = Uuid::new_v4().to_string();
    let end_line = body.end_line.unwrap_or(body.line);
    if body.line == 0 || end_line < body.line {
        return Err(AppError::BadRequest("`line` starts at 1, and `endLine` must not be before it.".into()));
    }
    state.rooms.mutate(&id.to_string(), |doc| add_thread(doc, &body.file, body.line, end_line, first, &thread)).await??;
    Ok(Json(Created { id: thread }))
}

#[derive(Debug, Deserialize)]
pub struct Reply {
    pub text: String,
}

/// `POST /api/scrolls/{id}/notes/{tid}/replies`
pub async fn reply(State(state): State<AppState>, user: AuthUser, via: ViaToken, Path((id, tid)): Path<(Uuid, String)>, Json(body): Json<Reply>) -> Result<Json<Created>, AppError> {
    writer(&state, id, &user).await?;
    let msg = message(&user, &via, &body.text)?;
    state
        .rooms
        .mutate(&id.to_string(), |doc| -> Result<(), AppError> {
            let comments = doc.get_or_insert_map(ROOT);
            let mut txn = doc.transact_mut();
            let Some(Out::YMap(t)) = comments.get(&txn, &tid) else { return Err(AppError::NotFound) };
            let Some(Out::YArray(messages)) = t.get(&txn, "messages") else { return Err(AppError::NotFound) };
            messages.push_back(&mut txn, msg);
            Ok(())
        })
        .await??;
    Ok(Json(Created { id: tid }))
}

#[derive(Debug, Deserialize)]
pub struct Resolve {
    pub resolved: bool,
}

/// `PUT /api/scrolls/{id}/notes/{tid}/resolved`
pub async fn resolve(State(state): State<AppState>, user: AuthUser, via: ViaToken, Path((id, tid)): Path<(Uuid, String)>, Json(body): Json<Resolve>) -> Result<Json<serde_json::Value>, AppError> {
    writer(&state, id, &user).await?;
    let who = author_name(&user, &via);
    state
        .rooms
        .mutate(&id.to_string(), |doc| -> Result<(), AppError> {
            let comments = doc.get_or_insert_map(ROOT);
            let mut txn = doc.transact_mut();
            let Some(Out::YMap(t)) = comments.get(&txn, &tid) else { return Err(AppError::NotFound) };
            t.insert(&mut txn, "resolved", body.resolved);
            if body.resolved { t.insert(&mut txn, "resolvedBy", who) } else { t.insert(&mut txn, "resolvedBy", Any::Null) };
            Ok(())
        })
        .await??;
    Ok(Json(serde_json::json!({ "id": tid, "resolved": body.resolved })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::Text;

    fn doc_with(text: &str) -> Doc {
        let doc = Doc::new();
        let files = doc.get_or_insert_map("files");
        let mut txn = doc.transact_mut();
        files.insert(&mut txn, "main.tex", yrs::TextPrelim::new(text));
        drop(txn);
        doc
    }

    fn msg(text: &str) -> Any {
        Any::from_json(&serde_json::json!({ "id": Uuid::new_v4().to_string(), "authorName": "Ann", "text": text, "at": 1000 }).to_string()).unwrap()
    }

    #[test]
    fn a_note_is_listed_with_its_line_and_follows_edits() {
        let doc = doc_with("one\ntwo\nthree\n");
        add_thread(&doc, "main.tex", 2, 2, msg("check this"), "t1").unwrap();
        let threads = read_threads(&doc);
        assert_eq!(threads.len(), 1);
        assert_eq!((threads[0].line, threads[0].quote.as_str(), threads[0].resolved), (Some(2), "two", false));
        assert_eq!(threads[0].messages[0].text, "check this");
        // text typed above moves the note down with it
        let files = doc.get_or_insert_map("files");
        let Some(Out::YText(t)) = files.get(&doc.transact(), "main.tex") else { panic!() };
        t.insert(&mut doc.transact_mut(), 0, "zero\n");
        assert_eq!(read_threads(&doc)[0].line, Some(3));
    }

    #[test]
    fn lines_past_the_end_are_refused() {
        let doc = doc_with("one\ntwo\n");
        assert!(add_thread(&doc, "main.tex", 3, 3, msg("x"), "t").is_err());
        assert!(add_thread(&doc, "nope.tex", 1, 1, msg("x"), "t").is_err());
    }
}
