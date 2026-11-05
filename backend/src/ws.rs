use std::{collections::HashSet, sync::Arc};

use anyhow::{Context, Result};
use axum::{
    extract::{
        Path, State, WebSocketUpgrade,
        ws::{Message as WsMessage, WebSocket},
    },
    http::HeaderMap,
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::broadcast::error::RecvError;
use yrs::{
    Origin, ReadTxn, Transact, Update,
    block::ClientID,
    encoding::read::Cursor,
    sync::{DefaultProtocol, Message, MessageReader, Protocol, SyncMessage},
    updates::{
        decoder::{Decode, DecoderV1},
        encoder::{Encode, Encoder, EncoderV1},
    },
};

use crate::{
    AppState,
    auth::{AuthUser, check_origin},
    error::{AppError, parse_room_id},
    rooms::Room,
    scrolls::require_role,
};

/// `GET /ws/{room}` — upgrade to a y-sync WebSocket for a scroll the caller is a member of.
///
/// Readers connect read-only: they receive everything and share presence, but their document
/// updates are discarded server-side (the client UI is read-only too, but the server decides).
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    user: AuthUser,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    check_origin(&headers, &state.config)?; // cookies authenticate this socket: block cross-site hijacking
    let scroll_id = parse_room_id(&room_id)?;
    let role = require_role(&state.db, scroll_id, user.id).await?;
    let can_write = role.can_write();
    // normalise so the room key is always the canonical hyphenated form
    let room_id = scroll_id.to_string();
    Ok(ws.on_upgrade(move |socket| async move {
        if let Err(e) = serve(socket, state, room_id.clone(), can_write, user).await {
            tracing::warn!(room = %room_id, error = ?e, "websocket session ended with error");
        }
    }))
}

async fn serve(socket: WebSocket, state: AppState, room_id: String, can_write: bool, user: AuthUser) -> Result<()> {
    let (room, mut rx) = state.rooms.join(&room_id).await?;
    let conn_id = state.next_conn_id();
    let origin: Origin = format!("conn-{conn_id}").into();
    let origin_bytes = origin.as_ref().to_vec();
    let (mut sink, mut stream) = socket.split();
    let mut known_clients: HashSet<ClientID> = HashSet::new();
    let mut warned_read_only = false;

    // Greeting: our state vector (so the client sends what we lack) + current presence.
    {
        let aw = room.awareness.read().await;
        let mut enc = EncoderV1::new();
        DefaultProtocol.start(&aw, &mut enc).context("building greeting")?;
        sink.send(WsMessage::Binary(enc.to_vec().into())).await.ok();
    }

    let result: Result<()> = async {
        loop {
            tokio::select! {
                incoming = stream.next() => match incoming {
                    Some(Ok(WsMessage::Binary(data))) => {
                        let mut replies = handle_frame(&state, &room, &origin, &mut known_clients, &data, can_write, &user).await?;
                        if !can_write && !warned_read_only && frame_has_write(&data) {
                            warned_read_only = true;
                            replies.push(Message::Auth(Some("read-only: readers cannot edit this scroll".into())).encode_v1());
                        }
                        for reply in replies {
                            sink.send(WsMessage::Binary(reply.into())).await?;
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    Some(Ok(_)) => {} // ping/pong/text are ignored
                    Some(Err(e)) => return Err(e.into()),
                },
                frame = rx.recv() => match frame {
                    Ok(f) => {
                        if f.origin.as_deref() != Some(origin_bytes.as_slice()) {
                            sink.send(WsMessage::Binary(f.data.into())).await?;
                        }
                    }
                    // We fell behind the broadcast buffer: ask the client to resync from scratch.
                    Err(RecvError::Lagged(n)) => {
                        tracing::warn!(room = %room.id, skipped = n, "connection lagged; forcing resync");
                        let sv = room.doc.transact().state_vector();
                        let msg = Message::Sync(SyncMessage::SyncStep1(sv)).encode_v1();
                        sink.send(WsMessage::Binary(msg.into())).await?;
                    }
                    Err(RecvError::Closed) => break,
                },
            }
        }
        Ok(())
    }
    .await;

    // Drop this connection's presence so remote cursors disappear.
    {
        let mut aw = room.awareness.write().await;
        for id in known_clients {
            aw.remove_state(id);
        }
    }
    drop(rx);
    state.rooms.leave(&room).await;
    result
}

/// Process one binary frame (may contain several y-sync messages). Returns encoded replies.
async fn handle_frame(
    state: &AppState,
    room: &Arc<Room>,
    origin: &Origin,
    known_clients: &mut HashSet<ClientID>,
    data: &[u8],
    can_write: bool,
    user: &AuthUser,
) -> Result<Vec<Vec<u8>>> {
    let mut decoder = DecoderV1::new(Cursor::new(data));
    let mut replies = Vec::new();
    for message in MessageReader::new(&mut decoder) {
        match message.context("decoding y-sync message")? {
            Message::Sync(SyncMessage::SyncStep1(sv)) => {
                let update = room.doc.transact().encode_state_as_update_v1(&sv);
                replies.push(Message::Sync(SyncMessage::SyncStep2(update)).encode_v1());
            }
            Message::Sync(SyncMessage::SyncStep2(u)) | Message::Sync(SyncMessage::Update(u)) => {
                if !can_write {
                    continue; // readers never change the document
                }
                let update = Update::decode_v1(&u).context("decoding update")?;
                room.doc
                    .transact_mut_with(origin.clone())
                    .apply_update(update)
                    .context("applying update")?;
            }
            Message::AwarenessQuery => {
                let aw = room.awareness.read().await;
                replies.push(Message::Awareness(aw.update()?).encode_v1());
            }
            Message::Awareness(mut update) => {
                let (name, color) = state.current_identity(user).await;
                stamp_identity(&mut update, &user.id.to_string(), &name, &color);
                let mut aw = room.awareness.write().await;
                if let Some(summary) = aw.apply_update_summary_with(update, origin.clone())? {
                    known_clients.extend(summary.added.iter().chain(summary.updated.iter()).copied());
                }
            }
            Message::Auth(_) | Message::Custom(..) => {}
        }
    }
    Ok(replies)
}

/// Does this frame contain a document write (SyncStep2/Update) that a reader may not make?
fn frame_has_write(data: &[u8]) -> bool {
    let mut decoder = DecoderV1::new(Cursor::new(data));
    MessageReader::new(&mut decoder).any(|m| matches!(m, Ok(Message::Sync(SyncMessage::SyncStep2(_) | SyncMessage::Update(_)))))
}

/// Presence is client-supplied JSON, so a scribe could label their cursor with someone else's
/// name. Overwrite `user` with what the server knows from the session.
fn stamp_identity(update: &mut yrs::sync::AwarenessUpdate, id: &str, name: &str, color: &str) {
    let identity = serde_json::json!({ "id": id, "name": name, "color": color, "colorLight": format!("{color}33") });
    for entry in update.clients.values_mut() {
        if entry.json.as_ref() == "null" {
            continue; // a removal, nothing to stamp
        }
        let mut state = serde_json::from_str::<serde_json::Value>(&entry.json).ok().filter(|v| v.is_object()).unwrap_or_else(|| serde_json::json!({}));
        state["user"] = identity.clone();
        entry.json = state.to_string().into();
    }
}
