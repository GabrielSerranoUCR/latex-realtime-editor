use std::{
    collections::HashMap,
    sync::{Arc, Weak},
    time::Duration,
};

use anyhow::{Context, Result};
use sqlx::PgPool;
use tokio::sync::{Mutex, Notify, RwLock, broadcast};
use yrs::{
    Doc, ReadTxn, StateVector, Transact, Update,
    sync::{Awareness, Message, SyncMessage},
    updates::{decoder::Decode, encoder::Encode},
};

use crate::store::FsStore;

/// A y-sync frame fanned out to every connection of a room.
#[derive(Clone, Debug)]
pub struct Frame {
    /// Transaction origin of the connection that caused it (so it is not echoed back).
    pub origin: Option<Vec<u8>>,
    pub data: Vec<u8>,
}

/// One collaborative document: the Yjs doc, presence (awareness) and a broadcast channel.
pub struct Room {
    pub id: String,
    pub doc: Doc,
    pub awareness: RwLock<Awareness>,
    pub tx: broadcast::Sender<Frame>,
    dirty: Arc<Notify>,
}

impl Room {
    fn new(id: &str, doc: Doc) -> Arc<Self> {
        let (tx, _) = broadcast::channel(1024);
        let dirty = Arc::new(Notify::new());
        let mut awareness = Awareness::new(doc.clone());

        // Document updates -> every connection except the one that produced them.
        {
            let tx = tx.clone();
            let dirty = dirty.clone();
            doc.observe_update_v1("quill-broadcast", move |txn, e| {
                let origin = txn.origin().map(|o| o.as_ref().to_vec());
                let data = Message::Sync(SyncMessage::Update(e.update.clone())).encode_v1();
                let _ = tx.send(Frame { origin, data });
                dirty.notify_one();
            })
            .expect("observe_update_v1");
        }
        // Presence updates (cursors, names) -> same fan-out.
        {
            let tx = tx.clone();
            awareness.on_update("quill-awareness", move |aw, event, origin| {
                if let Ok(update) = aw.update_with_clients(event.all_changes()) {
                    let data = Message::Awareness(update).encode_v1();
                    let _ = tx.send(Frame { origin: origin.map(|o| o.as_ref().to_vec()), data });
                }
            });
        }

        Arc::new(Self { id: id.to_string(), doc, awareness: RwLock::new(awareness), tx, dirty })
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.doc.transact().encode_state_as_update_v1(&StateVector::default())
    }
}

/// Owns live rooms, loads them from storage on demand and evicts them when idle.
///
/// Documents persist in PostgreSQL (`scroll_docs`); without a database (unit tests) they fall
/// back to the filesystem store.
pub struct RoomManager {
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    store: Arc<FsStore>,
    debounce: Duration,
    db: Option<PgPool>,
    version_interval: Duration,
}

impl RoomManager {
    pub fn new(store: Arc<FsStore>, debounce: Duration, db: Option<PgPool>, version_interval: Duration) -> Arc<Self> {
        Arc::new(Self { rooms: Mutex::new(HashMap::new()), store, debounce, db, version_interval })
    }

    /// Join a room (creating/loading it if needed). Subscribing happens under the map lock so
    /// the room can never be evicted between lookup and subscription.
    pub async fn join(self: &Arc<Self>, id: &str) -> Result<(Arc<Room>, broadcast::Receiver<Frame>)> {
        let mut rooms = self.rooms.lock().await;
        if let Some(room) = rooms.get(id) {
            return Ok((room.clone(), room.tx.subscribe()));
        }
        let doc = self.load_doc(id).await?;
        let room = Room::new(id, doc);
        let rx = room.tx.subscribe();
        rooms.insert(id.to_string(), room.clone());
        self.spawn_persister(Arc::downgrade(&room));
        tracing::info!(room = id, "room opened");
        Ok((room, rx))
    }

    /// Called when a connection ends. Flushes and evicts the room if nobody is left.
    pub async fn leave(self: &Arc<Self>, room: &Arc<Room>) {
        let mut rooms = self.rooms.lock().await;
        if room.tx.receiver_count() == 0 {
            if let Err(e) = self.persist(&room.id, &room.snapshot()).await {
                tracing::error!(room = %room.id, error = ?e, "failed to persist room on close");
            }
            rooms.remove(&room.id);
            room.dirty.notify_one(); // wake the persister so it can notice the room is gone
            tracing::info!(room = %room.id, "room closed");
        }
    }

    /// The current document for a room: the live one, or a transient copy loaded from storage.
    pub async fn doc(&self, id: &str) -> Result<Doc> {
        if let Some(room) = self.rooms.lock().await.get(id) {
            return Ok(room.doc.clone());
        }
        self.load_doc(id).await
    }

    /// Edit a document from the server (asset uploads, version restore).
    ///
    /// If the room is live the change is applied to the live document, so connected clients get
    /// it through the normal broadcast. Otherwise the stored document is loaded, changed and saved.
    /// The room map stays locked meanwhile so nobody can open the room mid-edit.
    pub async fn mutate<R>(self: &Arc<Self>, id: &str, f: impl FnOnce(&Doc) -> R) -> Result<R> {
        let rooms = self.rooms.lock().await;
        if let Some(room) = rooms.get(id) {
            return Ok(f(&room.doc));
        }
        let doc = self.load_doc(id).await?;
        let out = f(&doc);
        let bytes = doc.transact().encode_state_as_update_v1(&StateVector::default());
        self.persist(id, &bytes).await?;
        Ok(out)
    }

    /// The bytes of a room's current document (live state if open, else storage).
    pub async fn snapshot_of(&self, id: &str) -> Result<Vec<u8>> {
        Ok(self.doc(id).await?.transact().encode_state_as_update_v1(&StateVector::default()))
    }

    async fn load_snapshot(&self, id: &str) -> Result<Option<Vec<u8>>> {
        if let (Some(db), Ok(uuid)) = (&self.db, uuid::Uuid::parse_str(id)) {
            return Ok(sqlx::query_scalar("SELECT snapshot FROM scroll_docs WHERE scroll_id = $1").bind(uuid).fetch_optional(db).await.context("loading document")?);
        }
        Ok(self.store.load_doc(id).await.context("loading snapshot")?)
    }

    /// Save the document, bump `updated_at`, and take an automatic version if one is due.
    async fn persist(&self, id: &str, bytes: &[u8]) -> Result<()> {
        if let (Some(db), Ok(uuid)) = (&self.db, uuid::Uuid::parse_str(id)) {
            sqlx::query("INSERT INTO scroll_docs (scroll_id, snapshot) VALUES ($1, $2) ON CONFLICT (scroll_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = now()")
                .bind(uuid)
                .bind(bytes)
                .execute(db)
                .await
                .context("saving document")?;
            sqlx::query("UPDATE scrolls SET updated_at = now() WHERE id = $1").bind(uuid).execute(db).await.context("touching scroll")?;
            if let Err(e) = crate::versions::maybe_auto_snapshot(db, uuid, bytes, self.version_interval).await {
                tracing::warn!(room = id, error = ?e, "automatic version failed");
            }
            return Ok(());
        }
        self.store.save_doc(id, bytes).await.context("saving snapshot")?;
        Ok(())
    }

    async fn load_doc(&self, id: &str) -> Result<Doc> {
        let doc = Doc::new();
        if let Some(bytes) = self.load_snapshot(id).await? {
            let update = Update::decode_v1(&bytes).context("decoding snapshot")?;
            doc.transact_mut().apply_update(update).context("applying snapshot")?;
        }
        Ok(doc)
    }

    /// One-time upgrade: import documents saved by the old filesystem store.
    pub async fn import_fs_docs(&self) -> Result<usize> {
        let Some(db) = &self.db else { return Ok(0) };
        let dir = self.store.docs_dir();
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else { return Ok(0) };
        let mut imported = 0;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let Some(id) = path.file_stem().and_then(|s| s.to_str()).and_then(|s| uuid::Uuid::parse_str(s).ok()) else { continue };
            if path.extension().and_then(|e| e.to_str()) != Some("ydoc") {
                continue;
            }
            let bytes = tokio::fs::read(&path).await?;
            let done = sqlx::query("INSERT INTO scroll_docs (scroll_id, snapshot) SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM scrolls WHERE id = $1) ON CONFLICT (scroll_id) DO NOTHING")
                .bind(id)
                .bind(&bytes)
                .execute(db)
                .await?;
            if done.rows_affected() > 0 {
                imported += 1;
            }
            let _ = tokio::fs::rename(&path, path.with_extension("ydoc.imported")).await;
        }
        Ok(imported)
    }

    fn spawn_persister(self: &Arc<Self>, room: Weak<Room>) {
        let this = self.clone();
        let debounce = self.debounce;
        tokio::spawn(async move {
            loop {
                let Some(r) = room.upgrade() else { break };
                let dirty = r.dirty.clone();
                drop(r);
                dirty.notified().await;
                tokio::time::sleep(debounce).await;
                let Some(r) = room.upgrade() else { break };
                if let Err(e) = this.persist(&r.id, &r.snapshot()).await {
                    tracing::error!(room = %r.id, error = ?e, "failed to persist room");
                }
            }
        });
    }
}
