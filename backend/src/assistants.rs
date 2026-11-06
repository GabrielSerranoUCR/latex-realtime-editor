//! Who is an AI assistant (an access token, through MCP) working in a scroll right now. Anyone with the scroll
//! open sees a robot among the scribes at the table, for as long as the assistant keeps making requests. It rides
//! on the shared document's `meta` (like the count of waiting edits), so it reaches every open browser at once.

use std::{
    collections::{BTreeSet, HashMap},
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{extract::{Request, State}, middleware::Next, response::Response};
use uuid::Uuid;
use yrs::{Any, Map, Transact};

use crate::{AppState, auth::{bearer_token, hash_token}};

/// An assistant counts as at work this long after its last request.
const ACTIVE_FOR: Duration = Duration::from_secs(25);

#[derive(Default)]
pub struct Assistants {
    seen: Mutex<HashMap<Uuid, HashMap<String, Instant>>>,
}

impl Assistants {
    /// Note a request; returns the names now at work if that changed the list.
    fn touch(&self, scroll: Uuid, name: &str) -> Option<Vec<String>> {
        let mut all = self.seen.lock().unwrap();
        let room = all.entry(scroll).or_default();
        let before = names(room);
        room.insert(name.to_string(), Instant::now());
        let after = names(room);
        (before != after).then_some(after)
    }

    /// Drop those idle for too long; returns the names left if that changed the list.
    fn expire(&self, scroll: Uuid) -> Option<Vec<String>> {
        let mut all = self.seen.lock().unwrap();
        let room = all.get_mut(&scroll)?;
        let before = names(room);
        room.retain(|_, at| at.elapsed() < ACTIVE_FOR);
        let after = names(room);
        if room.is_empty() {
            all.remove(&scroll);
        }
        (before != after).then_some(after)
    }
}

fn names(room: &HashMap<String, Instant>) -> Vec<String> {
    room.keys().cloned().collect::<BTreeSet<_>>().into_iter().collect()
}

async fn publish(state: &AppState, scroll: Uuid, list: Vec<String>) {
    let json = serde_json::to_string(&list).unwrap_or_else(|_| "[]".into());
    let Ok(any) = Any::from_json(&json) else { return };
    let _ = state
        .rooms
        .mutate(&scroll.to_string(), |doc| {
            let meta = doc.get_or_insert_map("meta");
            let mut txn = doc.transact_mut();
            meta.insert(&mut txn, "assistants", any);
        })
        .await;
}

/// The scroll an API path is about (`/api/scrolls/{id}/…` or `/api/rooms/{id}/…`).
fn scroll_of(path: &str) -> Option<Uuid> {
    let mut parts = path.trim_start_matches('/').split('/');
    (parts.next()? == "api" && matches!(parts.next()?, "scrolls" | "rooms")).then_some(())?;
    parts.next()?.parse().ok()
}

/// Middleware: a request with an access token on a scroll means an assistant is working in it.
pub async fn track(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if let (Some(scroll), Some(token)) = (scroll_of(req.uri().path()), bearer_token(req.headers())) {
        let name: Option<String> = sqlx::query_scalar("SELECT name FROM api_tokens WHERE token_hash = $1").bind(hash_token(&token)).fetch_optional(&state.db).await.ok().flatten();
        if let Some(name) = name {
            let name = if name.trim().is_empty() { "Assistant".to_string() } else { name };
            if let Some(list) = state.assistants.touch(scroll, &name) {
                publish(&state, scroll, list).await;
            }
            let state = state.clone();
            tokio::spawn(async move {
                tokio::time::sleep(ACTIVE_FOR + Duration::from_millis(500)).await;
                if let Some(list) = state.assistants.expire(scroll) {
                    publish(&state, scroll, list).await;
                }
            });
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_name_the_scroll() {
        let id = Uuid::new_v4();
        assert_eq!(scroll_of(&format!("/api/scrolls/{id}/files/main.tex")), Some(id));
        assert_eq!(scroll_of(&format!("/api/rooms/{id}/compile")), Some(id));
        assert_eq!(scroll_of("/api/scrolls"), None);
        assert_eq!(scroll_of("/api/auth/login"), None);
    }

    #[test]
    fn the_list_changes_only_when_someone_arrives_or_leaves() {
        let a = Assistants::default();
        let s = Uuid::new_v4();
        assert_eq!(a.touch(s, "Claude"), Some(vec!["Claude".into()]));
        assert_eq!(a.touch(s, "Claude"), None);
        assert_eq!(a.touch(s, "Bot"), Some(vec!["Bot".into(), "Claude".into()]));
        assert_eq!(a.expire(s), None); // both are fresh
    }
}
