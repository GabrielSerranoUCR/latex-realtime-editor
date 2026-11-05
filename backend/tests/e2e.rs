//! End-to-end tests: a real server, a real PostgreSQL database and real Yjs clients.
//!
//! Needs the dev database:  docker compose up -d db
//! (override with QUILL_TEST_DATABASE_URL, which must point at a server where `quill_test`
//! may be created). All tests share one database and use unique emails/ids, so they can
//! run in parallel.

use std::{
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use quill_server::{AppState, config::Config, db, router};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::{sync::{OnceCell, mpsc}, task::JoinHandle};
use tokio_tungstenite::{connect_async, tungstenite::{Message as Ws, client::IntoClientRequest}};
use uuid::Uuid;
use yrs::{
    Doc, GetString, Map, Out, ReadTxn, Text, TextPrelim, Transact,
    sync::{Awareness, DefaultProtocol, Message, Protocol, SyncMessage},
    updates::encoder::{Encode, Encoder, EncoderV1},
};

const PASSWORD: &str = "correct horse battery staple";
const ORIGIN: &str = "http://localhost:4200";

const STUB_ENGINE: &str = r#"#!/bin/bash
# Fake `tectonic -X compile --outdir <dir> <main.tex>`
while [ $# -gt 0 ]; do
  case "$1" in --outdir) OUT="$2"; shift 2;; *) MAIN="$1"; shift;; esac
done
if grep -q FAIL "$MAIN"; then echo "error: $MAIN:3: boom"; exit 1; fi
if grep -q NEEDS_IMAGE "$MAIN" && [ ! -f figures/orbit.png ]; then echo "error: $MAIN:1: missing figures/orbit.png"; exit 1; fi
if grep -q NEEDS_FONTENC_SHIM "$MAIN" && ! grep -q "Unicode engine" fontenc.sty 2>/dev/null; then echo "error: $MAIN:1: the 8-bit fontenc would garble UTF-8"; exit 1; fi
echo "warning: stub warning"
printf '%%PDF-1.4 stub of %s' "$MAIN" > "$OUT/${MAIN%.tex}.pdf"
"#;

// ---------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------

static TEST_DB: OnceCell<String> = OnceCell::const_new();

/// Create (once per process) and migrate the shared test database.
async fn test_database_url() -> String {
    TEST_DB
        .get_or_init(|| async {
            let admin = std::env::var("QUILL_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://quill:quill@localhost:5434/postgres".into());
            let admin_pool = PgPool::connect(&admin).await.expect("connect to PostgreSQL (docker compose up -d db)");
            let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM pg_database WHERE datname = 'quill_test'").fetch_optional(&admin_pool).await.unwrap();
            if exists.is_none() {
                let _ = sqlx::query("CREATE DATABASE quill_test").execute(&admin_pool).await; // another process may win the race
            }
            let url = admin.rsplit_once('/').map(|(base, _)| format!("{base}/quill_test")).unwrap();
            let pool = PgPool::connect(&url).await.unwrap();
            db::migrate(&pool).await.unwrap();
            url
        })
        .await
        .clone()
}

struct TestServer {
    addr: SocketAddr,
    db: PgPool,
    http: reqwest::Client,
    outbox: PathBuf,
    data: PathBuf,
    state: AppState,
    _dir: tempfile::TempDir,
}

async fn start_server() -> TestServer {
    start_server_with(|_| {}).await
}

async fn start_server_with(tweak: impl FnOnce(&mut Config)) -> TestServer {
    let dir = tempfile::tempdir().unwrap();
    let engine: PathBuf = dir.path().join("fake-tectonic");
    std::fs::write(&engine, STUB_ENGINE).unwrap();
    std::fs::set_permissions(&engine, std::fs::Permissions::from_mode(0o755)).unwrap();
    let url = test_database_url().await;
    let pool = PgPool::connect(&url).await.unwrap();
    let mut config = Config::for_tests(dir.path().join("data"), engine, url);
    tweak(&mut config);
    let outbox = config.data_dir.join("outbox");
    let data = config.data_dir.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = AppState::new(config, pool.clone());
    let served = state.clone();
    tokio::spawn(async move { axum::serve(listener, router(served).into_make_service_with_connect_info::<SocketAddr>()).await.unwrap() });
    let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    TestServer { addr, db: pool, http, outbox, data, state, _dir: dir }
}

struct Resp {
    status: u16,
    json: Value,
    bytes: Vec<u8>,
    cookie: Option<String>,
    retry_after: Option<String>,
    headers: Vec<(String, String)>,
}

impl Resp {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

async fn into_resp(res: reqwest::Response) -> Resp {
    let status = res.status().as_u16();
    let headers: Vec<(String, String)> = res.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string())).collect();
    let cookie = res.headers().get_all("set-cookie").iter().filter_map(|v| v.to_str().ok()).find(|v| v.starts_with("quill_session=")).map(|v| v.split(';').next().unwrap().to_string());
    let retry_after = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(String::from);
    let bytes = res.bytes().await.unwrap().to_vec();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    Resp { status, json, bytes, cookie, retry_after, headers }
}

#[derive(Clone)]
struct User {
    id: Uuid,
    email: String,
    cookie: String, // "quill_session=..."
}

impl TestServer {
    /// Sends a request. Returns a future that owns everything it needs (no borrows), so tests can
    /// wrap calls in small closures.
    fn request(&self, method: reqwest::Method, path: &str, cookie: Option<String>, origin: Option<String>, body: Option<Value>) -> impl std::future::Future<Output = Resp> + use<> {
        let (http, addr, path) = (self.http.clone(), self.addr, path.to_string());
        async move {
            let mut req = http.request(method, format!("http://{addr}{path}"));
            if let Some(c) = cookie {
                req = req.header("cookie", c);
            }
            if let Some(o) = origin {
                req = req.header("origin", o);
            }
            if let Some(b) = body {
                req = req.json(&b);
            }
            into_resp(req.send().await.unwrap()).await
        }
    }
    /// A request authenticated with a personal access token instead of a browser cookie.
    fn with_token(&self, method: reqwest::Method, path: &str, token: &str, body: Option<Value>) -> impl std::future::Future<Output = Resp> + use<> {
        let (http, addr, path, token) = (self.http.clone(), self.addr, path.to_string(), token.to_string());
        async move {
            let mut req = http.request(method, format!("http://{addr}{path}")).bearer_auth(token);
            if let Some(b) = body {
                req = req.json(&b);
            }
            into_resp(req.send().await.unwrap()).await
        }
    }
    /// A request with a raw (binary) body, e.g. an asset upload.
    fn raw(&self, method: reqwest::Method, path: &str, u: Option<&User>, body: Vec<u8>) -> impl std::future::Future<Output = Resp> + use<> {
        let (http, addr, path, cookie) = (self.http.clone(), self.addr, path.to_string(), u.map(|u| u.cookie.clone()));
        async move {
            let mut req = http.request(method, format!("http://{addr}{path}")).body(body);
            if let Some(c) = cookie {
                req = req.header("cookie", c);
            }
            into_resp(req.send().await.unwrap()).await
        }
    }
    fn get(&self, path: &str, u: Option<&User>) -> impl std::future::Future<Output = Resp> + use<> {
        self.request(reqwest::Method::GET, path, u.map(|u| u.cookie.clone()), None, None)
    }
    fn post(&self, path: &str, u: Option<&User>, body: Value) -> impl std::future::Future<Output = Resp> + use<> {
        self.request(reqwest::Method::POST, path, u.map(|u| u.cookie.clone()), None, Some(body))
    }
    fn send(&self, m: reqwest::Method, path: &str, u: &User, body: Option<Value>) -> impl std::future::Future<Output = Resp> + use<> {
        self.request(m, path, Some(u.cookie.clone()), None, body)
    }

    /// A signed-up user whose email is already verified (most tests are not about verification).
    async fn new_user(&self, name: &str) -> User {
        let u = self.new_unverified_user(name).await;
        sqlx::query("UPDATE users SET email_verified_at = now() WHERE id = $1").bind(u.id).execute(&self.db).await.unwrap();
        u
    }
    async fn new_unverified_user(&self, name: &str) -> User {
        let email = format!("{}-{}@guild.test", name.to_lowercase(), Uuid::new_v4().simple());
        self.signup(name, &email).await
    }
    async fn signup(&self, name: &str, email: &str) -> User {
        let r = self.post("/api/auth/signup", None, json!({"email": email, "displayName": name, "password": PASSWORD})).await;
        assert_eq!(r.status, 201, "signup failed: {}", r.json);
        User { id: r.json["id"].as_str().unwrap().parse().unwrap(), email: email.to_string(), cookie: r.cookie.expect("session cookie") }
    }
    async fn new_scroll(&self, owner: &User, title: &str) -> Uuid {
        let r = self.post("/api/scrolls", Some(owner), json!({ "title": title })).await;
        assert_eq!(r.status, 201, "{}", r.json);
        r.json["id"].as_str().unwrap().parse().unwrap()
    }
    /// Owner invites by email and the invitee accepts (the real flow, minus clicking the email link).
    async fn invite(&self, owner: &User, scroll: Uuid, who: &User, role: &str) {
        let r = self.post(&format!("/api/scrolls/{scroll}/invitations"), Some(owner), json!({"email": who.email, "role": role})).await;
        assert_eq!(r.status, 201, "{}", r.json);
        let id = r.json["id"].as_str().unwrap().to_string();
        let a = self.post(&format!("/api/invitations/{id}/accept"), Some(who), json!({})).await;
        assert_eq!(a.status, 200, "{}", a.json);
    }

    /// Every mail sent to `email`, oldest first.
    fn mails_to(&self, email: &str) -> Vec<String> {
        let Ok(dir) = std::fs::read_dir(&self.outbox) else { return vec![] };
        let mut files: Vec<_> = dir.flatten().map(|e| e.path()).collect();
        files.sort();
        files.iter().filter_map(|p| std::fs::read_to_string(p).ok()).filter(|m| m.starts_with(&format!("To: {email}\n"))).collect()
    }
    /// The value after `marker` (e.g. "token=") in the last mail to `email`.
    fn link_value(&self, email: &str, marker: &str) -> String {
        let mail = self.mails_to(email).pop().unwrap_or_else(|| panic!("no mail to {email}"));
        let rest = mail.split(marker).nth(1).unwrap_or_else(|| panic!("no `{marker}` in mail: {mail}"));
        rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect()
    }
}

/// A minimal y-sync client (what the Angular app does with y-protocols).
struct Client {
    doc: Doc,
    awareness: Arc<Mutex<Awareness>>,
    out: mpsc::UnboundedSender<Vec<u8>>,
    task: JoinHandle<()>,
}

async fn try_connect(addr: SocketAddr, room: &str, cookie: Option<&str>, origin: Option<&str>) -> Result<Client, u16> {
    let mut req = format!("ws://{addr}/ws/{room}").into_client_request().unwrap();
    if let Some(c) = cookie {
        req.headers_mut().insert("cookie", c.parse().unwrap());
    }
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    let (ws, _) = match connect_async(req).await {
        Ok(ok) => ok,
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => return Err(resp.status().as_u16()),
        Err(e) => panic!("ws connect: {e}"),
    };
    let (mut sink, mut stream) = ws.split();
    let doc = Doc::new();
    let awareness = Arc::new(Mutex::new(Awareness::new(doc.clone())));
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let out = out_tx.clone();
    doc.observe_update_v1("client-out", move |_, e| {
        let _ = out_tx.send(Message::Sync(SyncMessage::Update(e.update.clone())).encode_v1());
    })
    .unwrap();
    let aw = awareness.clone();
    let task = tokio::spawn(async move {
        let mut enc = EncoderV1::new();
        DefaultProtocol.start(&aw.lock().unwrap(), &mut enc).unwrap();
        sink.send(Ws::Binary(enc.to_vec().into())).await.unwrap();
        loop {
            tokio::select! {
                Some(out) = out_rx.recv() => { if sink.send(Ws::Binary(out.into())).await.is_err() { break; } }
                incoming = stream.next() => match incoming {
                    Some(Ok(Ws::Binary(data))) => {
                        // Auth(denied) frames are expected for readers; DefaultProtocol turns them into errors.
                        let replies = DefaultProtocol.handle(&mut aw.lock().unwrap(), &data); // guard dropped here
                        if let Ok(replies) = replies {
                            for r in replies { if sink.send(Ws::Binary(r.encode_v1().into())).await.is_err() { break; } }
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => break,
                },
            }
        }
    });
    Ok(Client { doc, awareness, out, task })
}

async fn connect(srv: &TestServer, room: Uuid, u: &User) -> Client {
    try_connect(srv.addr, &room.to_string(), Some(&u.cookie), None).await.expect("ws connect")
}

impl Client {
    fn write_file(&self, name: &str, content: &str) {
        let files = self.doc.get_or_insert_map("files");
        let mut txn = self.doc.transact_mut();
        files.insert(&mut txn, name, TextPrelim::new(content));
    }
    fn append(&self, name: &str, more: &str) {
        let files = self.doc.get_or_insert_map("files");
        let mut txn = self.doc.transact_mut();
        if let Some(Out::YText(t)) = files.get(&txn, name) {
            let len = t.len(&txn);
            t.insert(&mut txn, len, more);
        } else {
            panic!("{name} not present");
        }
    }
    fn file_text(&self, name: &str) -> Option<String> {
        let files = self.doc.get_or_insert_map("files");
        let txn = self.doc.transact();
        match files.get(&txn, name) {
            Some(Out::YText(t)) => Some(t.get_string(&txn)),
            _ => None,
        }
    }
    fn doc_meta_number(&self, key: &str) -> Option<f64> {
        let meta = self.doc.get_or_insert_map("meta");
        let txn = self.doc.transact();
        match meta.get(&txn, key) {
            Some(Out::Any(a)) => a.cast::<f64>().ok(),
            _ => None,
        }
    }
    fn asset_keys(&self) -> Vec<String> {
        let assets = self.doc.get_or_insert_map("assets");
        let txn = self.doc.transact();
        let mut keys: Vec<String> = assets.keys(&txn).map(String::from).collect();
        keys.sort();
        keys
    }
    async fn eventually_assets(&self, expected: &[&str]) {
        for _ in 0..100 {
            if self.asset_keys() == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        panic!("timed out: expected assets {expected:?}, got {:?}", self.asset_keys());
    }
    fn read_file(&self, name: &str) -> Option<String> {
        let files = self.doc.get_or_insert_map("files");
        let txn = self.doc.transact();
        match files.get(&txn, name) {
            Some(Out::YText(t)) => Some(t.get_string(&txn)),
            _ => None,
        }
    }
    async fn eventually(&self, name: &str, expected: &str) {
        for _ in 0..100 {
            if self.read_file(name).as_deref() == Some(expected) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        panic!("timed out: expected {name} == {expected:?}, got {:?}", self.read_file(name));
    }
    fn disconnect(self) {
        self.task.abort();
    }
}

// ---------------------------------------------------------------------------------------------
// accounts & sessions
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn signup_login_logout_flow() {
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;

    let me = srv.get("/api/me", Some(&u)).await;
    assert_eq!(me.status, 200);
    assert_eq!(me.json["email"], u.email.as_str());
    assert!(me.json.get("passwordHash").is_none() && me.json.get("password_hash").is_none(), "never expose hashes");

    // wrong password and unknown email are indistinguishable
    let bad = srv.post("/api/auth/login", None, json!({"email": u.email, "password": "wrong password!!"})).await;
    let unknown = srv.post("/api/auth/login", None, json!({"email": "nobody@guild.test", "password": "wrong password!!"})).await;
    assert_eq!((bad.status, unknown.status), (400, 400));
    assert_eq!(bad.json["error"], unknown.json["error"]);

    // login is case-insensitive on email and issues a fresh session
    let ok = srv.post("/api/auth/login", None, json!({"email": u.email.to_uppercase(), "password": PASSWORD})).await;
    assert_eq!(ok.status, 200);
    let second = User { cookie: ok.cookie.clone().unwrap(), ..u.clone() };
    assert_eq!(srv.get("/api/me", Some(&second)).await.status, 200);

    // logout kills only that session
    assert_eq!(srv.post("/api/auth/logout", Some(&second), json!({})).await.status, 204);
    assert_eq!(srv.get("/api/me", Some(&second)).await.status, 401);
    assert_eq!(srv.get("/api/me", Some(&u)).await.status, 200);
    assert_eq!(srv.get("/api/me", None).await.status, 401);
}

#[tokio::test]
async fn signup_validation() {
    let srv = start_server().await;
    let email = format!("dup-{}@guild.test", Uuid::new_v4().simple());
    let body = |email: &str, name: &str, pw: &str| json!({"email": email, "displayName": name, "password": pw});
    assert_eq!(srv.post("/api/auth/signup", None, body(&email, "Dup", PASSWORD)).await.status, 201);
    assert_eq!(srv.post("/api/auth/signup", None, body(&email.to_uppercase(), "Dup2", PASSWORD)).await.status, 409);
    assert_eq!(srv.post("/api/auth/signup", None, body("not-an-email", "X", PASSWORD)).await.status, 400);
    assert_eq!(srv.post("/api/auth/signup", None, body("a@b.test", "X", "short")).await.status, 400);
    assert_eq!(srv.post("/api/auth/signup", None, body("a@b.test", "   ", PASSWORD)).await.status, 400);
}

#[tokio::test]
async fn passwords_and_session_tokens_are_never_stored_in_clear() {
    let srv = start_server().await;
    let u = srv.new_user("Marcus").await;
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1").bind(u.id).fetch_one(&srv.db).await.unwrap();
    assert!(hash.starts_with("$argon2id$"), "{hash}");
    assert!(!hash.contains(PASSWORD));
    let token = u.cookie.trim_start_matches("quill_session=");
    let stored: Vec<Vec<u8>> = sqlx::query_scalar("SELECT token_hash FROM sessions WHERE user_id = $1").bind(u.id).fetch_all(&srv.db).await.unwrap();
    assert!(!stored.is_empty() && stored.iter().all(|h| h.len() == 32 && h.as_slice() != token.as_bytes()));
}

#[tokio::test]
async fn expired_sessions_are_rejected() {
    let srv = start_server().await;
    let u = srv.new_user("Rowan").await;
    sqlx::query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1").bind(u.id).execute(&srv.db).await.unwrap();
    assert_eq!(srv.get("/api/me", Some(&u)).await.status, 401);
}

#[tokio::test]
async fn cross_site_writes_are_rejected() {
    let srv = start_server().await;
    let u = srv.new_user("Mirelle").await;
    let evil = srv.request(reqwest::Method::POST, "/api/scrolls", Some(u.cookie.clone()), Some("https://evil.example".into()), Some(json!({"title": "pwned"}))).await;
    assert_eq!(evil.status, 403);
    let ours = srv.request(reqwest::Method::POST, "/api/scrolls", Some(u.cookie.clone()), Some(ORIGIN.into()), Some(json!({"title": "fine"}))).await;
    assert_eq!(ours.status, 201);
}

// ---------------------------------------------------------------------------------------------
// scrolls & membership
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn scroll_lifecycle_and_privacy() {
    let srv = start_server().await;
    let (owner, stranger) = (srv.new_user("Owner").await, srv.new_user("Stranger").await);
    assert_eq!(srv.get("/api/scrolls", None).await.status, 401);

    let id = srv.new_scroll(&owner, "  Thesis – Chapter 4  ").await;
    let mine = srv.get("/api/scrolls", Some(&owner)).await;
    assert_eq!(mine.json.as_array().unwrap().iter().filter(|s| s["id"] == id.to_string()).count(), 1);
    let one = srv.get(&format!("/api/scrolls/{id}"), Some(&owner)).await;
    assert_eq!((one.json["title"].as_str().unwrap(), one.json["role"].as_str().unwrap()), ("Thesis – Chapter 4", "owner"));

    // invisible and untouchable for strangers (404, not 403, so ids cannot be probed)
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&stranger)).await.status, 404);
    assert_eq!(srv.send(reqwest::Method::DELETE, &format!("/api/scrolls/{id}"), &stranger, None).await.status, 404);
    assert!(srv.get("/api/scrolls", Some(&stranger)).await.json.as_array().unwrap().iter().all(|s| s["id"] != id.to_string()));

    assert_eq!(srv.post("/api/scrolls", Some(&owner), json!({"title": "   "})).await.status, 400);
    assert_eq!(srv.send(reqwest::Method::PATCH, &format!("/api/scrolls/{id}"), &owner, Some(json!({"title": "Renamed"}))).await.status, 204);
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&owner)).await.json["title"], "Renamed");

    // deleting moves it to the cellar: gone for everyone
    assert_eq!(srv.send(reqwest::Method::DELETE, &format!("/api/scrolls/{id}"), &owner, None).await.status, 204);
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&owner)).await.status, 404);
}

#[tokio::test]
async fn access_tokens_act_as_their_owner() {
    use reqwest::Method;
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;

    assert_eq!(srv.post("/api/me/tokens", Some(&u), json!({"name": "  "})).await.status, 400);
    assert_eq!(srv.post("/api/me/tokens", Some(&u), json!({"name": "x", "days": 0})).await.status, 400);
    let made = srv.post("/api/me/tokens", Some(&u), json!({"name": "Claude on my laptop"})).await;
    assert_eq!(made.status, 201, "{}", made.json);
    let token = made.json["token"].as_str().unwrap().to_string();
    assert!(token.starts_with("qq_"));
    assert_eq!(made.json["write"], false, "read-only unless asked");

    // the list never shows the token again
    let list = srv.get("/api/me/tokens", Some(&u)).await;
    assert_eq!(list.json.as_array().unwrap().len(), 1);
    assert!(list.json[0].get("token").is_none());
    assert_eq!(list.json[0]["name"], "Claude on my laptop");

    // it acts as its owner
    let me = srv.with_token(Method::GET, "/api/me", &token, None).await;
    assert_eq!((me.status, me.json["email"].as_str()), (200, Some(u.email.as_str())));
    assert_eq!(srv.with_token(Method::GET, "/api/me", "qq_not_a_token", None).await.status, 401);
    assert_eq!(srv.get("/api/me/tokens", Some(&u)).await.json[0]["lastUsedAt"].is_null(), false, "use is noted");

    // a read-only token reads and compiles, and changes nothing
    let id = srv.new_scroll(&u, "Thesis").await;
    assert_eq!(srv.with_token(Method::GET, &format!("/api/scrolls/{id}"), &token, None).await.status, 200);
    assert_eq!(srv.with_token(Method::PATCH, &format!("/api/scrolls/{id}"), &token, Some(json!({"title": "Hacked"}))).await.status, 403);
    assert_eq!(srv.with_token(Method::POST, "/api/scrolls", &token, Some(json!({"title": "Spam"}))).await.status, 403);
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&u)).await.json["title"], "Thesis");

    // a token cannot make tokens (only a signed-in browser can), nor change who may do what
    assert_eq!(srv.with_token(Method::POST, "/api/me/tokens", &token, Some(json!({"name": "more", "write": true}))).await.status, 403);
    let writer = srv.post("/api/me/tokens", Some(&u), json!({"name": "writer", "write": true})).await.json["token"].as_str().unwrap().to_string();
    assert_eq!(srv.with_token(Method::POST, "/api/me/tokens", &writer, Some(json!({"name": "more"}))).await.status, 403);
    assert_eq!(srv.with_token(Method::PUT, &format!("/api/scrolls/{id}/ai-mode"), &writer, Some(json!({"mode": "auto"}))).await.status, 403);
    assert_eq!(srv.with_token(Method::PATCH, &format!("/api/scrolls/{id}"), &writer, Some(json!({"title": "Renamed by a write token"}))).await.status, 204, "a write token is its owner's hands");

    // revoking, and expiry
    let tid = list.json[0]["id"].as_str().unwrap().to_string();
    assert_eq!(srv.send(Method::DELETE, &format!("/api/me/tokens/{tid}"), &u, None).await.status, 204);
    assert_eq!(srv.with_token(Method::GET, "/api/me", &token, None).await.status, 401, "revoked at once");
    assert_eq!(srv.send(Method::DELETE, &format!("/api/me/tokens/{tid}"), &u, None).await.status, 404);
    sqlx::query("UPDATE api_tokens SET expires_at = now() - interval '1 day' WHERE user_id = $1").bind(u.id).execute(&srv.db).await.unwrap();
    assert_eq!(srv.with_token(Method::GET, "/api/me", &writer, None).await.status, 401, "expired");

    // someone else's token is not yours to list or revoke
    let other = srv.new_user("Other").await;
    assert_eq!(srv.get("/api/me/tokens", Some(&other)).await.json, json!([]));
    assert_eq!(srv.send(Method::DELETE, &format!("/api/me/tokens/{tid}"), &other, None).await.status, 404);
}

#[tokio::test]
async fn documents_over_http_with_auto_mode() {
    use reqwest::Method;
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;
    let id = srv.new_scroll(&u, "Thesis").await;
    let live = connect(&srv, id, &u).await; // someone has the scroll open
    live.write_file("main.tex", "\\documentclass{article}\nHello world\nHello again\n");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let token = srv.post("/api/me/tokens", Some(&u), json!({"name": "assistant", "write": true})).await.json["token"].as_str().unwrap().to_string();
    let files = format!("/api/scrolls/{id}/files");
    let t = |m: Method, p: &str, b: Option<Value>| srv.with_token(m, p, &token, b);

    // the owner chooses auto: only a browser session may
    assert_eq!(t(Method::PUT, &format!("/api/scrolls/{id}/ai-mode"), Some(json!({"mode": "auto"}))).await.status, 403);
    assert_eq!(srv.send(Method::PUT, &format!("/api/scrolls/{id}/ai-mode"), &u, Some(json!({"mode": "sometimes"}))).await.status, 400);
    assert_eq!(srv.send(Method::PUT, &format!("/api/scrolls/{id}/ai-mode"), &u, Some(json!({"mode": "auto"}))).await.status, 204);
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&u)).await.json["aiEditMode"], "auto");

    // list and read
    let list = t(Method::GET, &files, None).await;
    assert_eq!((list.json["main"].as_str(), list.json["files"][0]["path"].as_str(), list.json["files"][0]["lines"].as_u64()), (Some("main.tex"), Some("main.tex"), Some(3)));
    let all = t(Method::GET, &format!("{files}/main.tex"), None).await;
    assert_eq!((all.json["totalLines"].as_u64(), all.json["content"].as_str().map(|c| c.starts_with("\\documentclass"))), (Some(3), Some(true)));
    let part = t(Method::GET, &format!("{files}/main.tex?start=2&end=2"), None).await;
    assert_eq!((part.json["content"].as_str(), part.json["startLine"].as_u64(), part.json["endLine"].as_u64()), (Some("Hello world\n"), Some(2), Some(2)));
    assert_eq!(t(Method::GET, &format!("{files}/main.tex?start=3&end=2"), None).await.status, 400);
    assert_eq!(t(Method::GET, &format!("{files}/nope.tex"), None).await.status, 404);

    // edit: unique text, ambiguous text, missing text, replace all
    let e1 = t(Method::PATCH, &format!("{files}/main.tex"), Some(json!({"oldText": "world", "newText": "wörld ✓"}))).await;
    assert_eq!((e1.status, e1.json["replacements"].as_u64()), (200, Some(1)), "{}", e1.json);
    assert_eq!(t(Method::PATCH, &format!("{files}/main.tex"), Some(json!({"oldText": "Hello", "newText": "Hi"}))).await.status, 409, "appears twice");
    assert_eq!(t(Method::PATCH, &format!("{files}/main.tex"), Some(json!({"oldText": "absent", "newText": "x"}))).await.status, 409);
    assert_eq!(t(Method::PATCH, &format!("{files}/main.tex"), Some(json!({"oldText": "", "newText": "x"}))).await.status, 400);
    assert_eq!(t(Method::PATCH, &format!("{files}/main.tex"), Some(json!({"oldText": "a", "newText": "a"}))).await.status, 400);
    let e2 = t(Method::PATCH, &format!("{files}/main.tex"), Some(json!({"oldText": "Hello", "newText": "Hi", "replaceAll": true}))).await;
    assert_eq!(e2.json["replacements"].as_u64(), Some(2));
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(live.file_text("main.tex").unwrap(), "\\documentclass{article}\nHi wörld ✓\nHi again\n", "the open editor sees it live, non-ASCII intact");

    // write: create a file in a folder, replace it, refuse bad names, a clash with a picture, big files
    let w = t(Method::PUT, &format!("{files}/chapters/intro.tex"), Some(json!({"content": "First\n"}))).await;
    assert_eq!((w.status, w.json["created"].clone()), (200, json!(true)), "{}", w.json);
    let w2 = t(Method::PUT, &format!("{files}/chapters/intro.tex"), Some(json!({"content": "Second\n"}))).await;
    assert_eq!(w2.json["created"], false);
    for bad in ["x.exe", "back%5Cslash.tex", "bad%24name.tex"] {
        assert_eq!(t(Method::PUT, &format!("{files}/{bad}"), Some(json!({"content": "x"}))).await.status, 400, "{bad}");
    }
    assert_eq!(t(Method::PUT, &format!("{files}/big.tex"), Some(json!({"content": "x".repeat(1024 * 1024 + 1)}))).await.status, 400);
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(live.file_text("chapters/intro.tex").unwrap(), "Second\n");

    // delete: not the main file
    assert_eq!(t(Method::DELETE, &format!("{files}/main.tex"), None).await.status, 409);
    assert_eq!(t(Method::DELETE, &format!("{files}/chapters/intro.tex"), None).await.json["deleted"], true);
    assert_eq!(t(Method::DELETE, &format!("{files}/chapters/intro.tex"), None).await.status, 404);

    // a reader's token cannot change a thing; a stranger's cannot even look
    let reader = srv.new_user("Reader").await;
    srv.invite(&u, id, &reader, "reader").await;
    let rt = srv.post("/api/me/tokens", Some(&reader), json!({"name": "r", "write": true})).await.json["token"].as_str().unwrap().to_string();
    assert_eq!(srv.with_token(Method::GET, &files, &rt, None).await.status, 200);
    assert_eq!(srv.with_token(Method::PATCH, &format!("{files}/main.tex"), &rt, Some(json!({"oldText": "Hi", "newText": "Yo"}))).await.status, 403);
    let stranger = srv.new_user("Stranger").await;
    let st = srv.post("/api/me/tokens", Some(&stranger), json!({"name": "s", "write": true})).await.json["token"].as_str().unwrap().to_string();
    assert_eq!(srv.with_token(Method::GET, &files, &st, None).await.status, 404);
}

#[tokio::test]
async fn review_mode_holds_an_assistants_edits_until_a_person_accepts() {
    use reqwest::Method;
    let srv = start_server().await;
    let (owner, scribe) = (srv.new_user("Owner").await, srv.new_user("Scribe").await);
    let id = srv.new_scroll(&owner, "Thesis").await;
    srv.invite(&owner, id, &scribe, "scribe").await;
    let live = connect(&srv, id, &owner).await;
    live.write_file("main.tex", "alpha\nbeta\n");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let token = srv.post("/api/me/tokens", Some(&scribe), json!({"name": "Claude", "write": true})).await.json["token"].as_str().unwrap().to_string();
    let files = format!("/api/scrolls/{id}/files");
    let props = format!("/api/scrolls/{id}/proposals");

    // the default is review, and a scribe cannot turn it off
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&scribe)).await.json["aiEditMode"], "review");
    assert_eq!(srv.send(Method::PUT, &format!("/api/scrolls/{id}/ai-mode"), &scribe, Some(json!({"mode": "auto"}))).await.status, 403, "only the owner");

    // the assistant's edit is queued, not applied
    let q = srv.with_token(Method::PATCH, &format!("{files}/main.tex"), &token, Some(json!({"oldText": "beta", "newText": "gamma", "note": "fix the second word"}))).await;
    assert_eq!(q.status, 202, "{}", q.json);
    assert_eq!(q.json["queued"], true);
    let pid = q.json["proposalId"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(live.file_text("main.tex").unwrap(), "alpha\nbeta\n", "nothing changed yet");

    // mistakes are reported at once, not queued
    assert_eq!(srv.with_token(Method::PATCH, &format!("{files}/main.tex"), &token, Some(json!({"oldText": "absent", "newText": "x"}))).await.status, 409);
    assert_eq!(srv.with_token(Method::PUT, &format!("{files}/x.exe"), &token, Some(json!({"content": "x"}))).await.status, 400);
    // writes and deletes are held too
    let w = srv.with_token(Method::PUT, &format!("{files}/new.tex"), &token, Some(json!({"content": "fresh\n"}))).await;
    assert_eq!(w.status, 202);
    let d = srv.with_token(Method::DELETE, &format!("{files}/new.tex"), &token, None).await;
    assert_eq!(d.status, 404, "there is no such file yet: only accepted changes exist");

    // anyone with the scroll sees the queue; it carries the note and who sent it
    let list = srv.get(&props, Some(&owner)).await;
    assert_eq!(list.json.as_array().unwrap().len(), 2);
    assert_eq!((list.json[0]["kind"].as_str(), list.json[0]["note"].as_str(), list.json[0]["by"].as_str(), list.json[0]["tokenName"].as_str()), (Some("edit"), Some("fix the second word"), Some("Scribe"), Some("Claude")));
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(live.doc_meta_number("pendingEdits"), Some(2.0), "the open editor is told how many wait");

    // only a person can decide: not the assistant, not a reader
    assert_eq!(srv.with_token(Method::POST, &format!("{props}/{pid}/accept"), &token, None).await.status, 403, "an assistant cannot approve itself");
    let reader = srv.new_user("Reader").await;
    srv.invite(&owner, id, &reader, "reader").await;
    assert_eq!(srv.post(&format!("{props}/{pid}/accept"), Some(&reader), json!({})).await.status, 403);

    // accept: now it is in the document, for everyone
    assert_eq!(srv.post(&format!("{props}/{pid}/accept"), Some(&scribe), json!({})).await.status, 204);
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(live.file_text("main.tex").unwrap(), "alpha\ngamma\n");
    assert_eq!(srv.with_token(Method::GET, &format!("{props}/{pid}"), &token, None).await.json["status"], "accepted", "the assistant can see the outcome");
    assert_eq!(srv.post(&format!("{props}/{pid}/accept"), Some(&scribe), json!({})).await.status, 404, "decided once");

    // reject the other; the queue empties
    let other = list.json[1]["id"].as_str().unwrap().to_string();
    assert_eq!(srv.post(&format!("{props}/{other}/reject"), Some(&owner), json!({})).await.status, 204);
    assert_eq!(srv.get(&props, Some(&owner)).await.json, json!([]));
    assert_eq!(srv.with_token(Method::GET, &format!("{props}/{other}"), &token, None).await.json["status"], "rejected");
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(live.file_text("new.tex"), None);
    assert_eq!(live.doc_meta_number("pendingEdits"), Some(0.0));

    // an edit that no longer fits when it is accepted says so, and changes nothing
    let q2 = srv.with_token(Method::PATCH, &format!("{files}/main.tex"), &token, Some(json!({"oldText": "gamma", "newText": "delta"}))).await.json["proposalId"].as_str().unwrap().to_string();
    live.append("main.tex", "");
    {
        let f = live.doc.get_or_insert_map("files");
        let mut txn = live.doc.transact_mut();
        if let Some(Out::YText(t)) = f.get(&txn, "main.tex") {
            t.remove_range(&mut txn, 6, 5); // someone rewrote "gamma" meanwhile
            t.insert(&mut txn, 6, "omega");
        }
    }
    tokio::time::sleep(Duration::from_millis(250)).await;
    let late = srv.post(&format!("{props}/{q2}/accept"), Some(&owner), json!({})).await;
    assert_eq!(late.status, 409, "{}", late.json);
    assert!(late.json["error"].as_str().unwrap().contains("no longer fits"));
    assert_eq!(srv.get(&props, Some(&owner)).await.json.as_array().unwrap().len(), 1, "it stays, to be rejected");

    // auto mode: the owner switches it, and the same edit now applies at once
    assert_eq!(srv.send(Method::PUT, &format!("/api/scrolls/{id}/ai-mode"), &owner, Some(json!({"mode": "auto"}))).await.status, 204);
    let direct = srv.with_token(Method::PATCH, &format!("{files}/main.tex"), &token, Some(json!({"oldText": "omega", "newText": "sigma"}))).await;
    assert_eq!(direct.status, 200, "{}", direct.json);
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(live.file_text("main.tex").unwrap(), "alpha\nsigma\n");
}

#[tokio::test]
async fn magic_link_signs_in_once() {
    let srv = start_server().await;
    let u = srv.new_unverified_user("Aelith").await;
    assert_eq!(srv.get("/api/me", Some(&u)).await.json["emailVerified"], false);

    // the answer never says whether an account exists
    let ghost = srv.post("/api/auth/magic", None, json!({"email": "ghost@guild.test"})).await;
    let real = srv.post("/api/auth/magic", None, json!({"email": u.email.to_uppercase()})).await;
    assert_eq!((ghost.status, real.status), (204, 204));
    assert!(srv.mails_to("ghost@guild.test").is_empty());
    let mails = srv.mails_to(&u.email);
    assert!(mails.last().unwrap().contains("/magic?token="), "the link is in the email");

    let token = srv.link_value(&u.email, "token=");
    assert_eq!(srv.post("/api/auth/magic/consume", None, json!({"token": "bogus"})).await.status, 400);
    let ok = srv.post("/api/auth/magic/consume", None, json!({"token": token})).await;
    assert_eq!(ok.status, 200, "{}", ok.json);
    assert_eq!(ok.json["email"], u.email.to_lowercase());
    assert_eq!(ok.json["emailVerified"], true, "opening the link proves the address is theirs");
    let cookie = ok.cookie.expect("a session cookie");
    let me = srv.get("/api/me", Some(&User { id: u.id, email: u.email.clone(), cookie })).await;
    assert_eq!(me.status, 200, "the new session works");

    // one use only
    assert_eq!(srv.post("/api/auth/magic/consume", None, json!({"token": token})).await.status, 400);
    // a newer link replaces the older one
    srv.post("/api/auth/magic", None, json!({"email": u.email})).await;
    let first = srv.link_value(&u.email, "token=");
    srv.post("/api/auth/magic", None, json!({"email": u.email})).await;
    let second = srv.link_value(&u.email, "token=");
    assert_ne!(first, second);
    assert_eq!(srv.post("/api/auth/magic/consume", None, json!({"token": first})).await.status, 400);
    assert_eq!(srv.post("/api/auth/magic/consume", None, json!({"token": second})).await.status, 200);
}

#[tokio::test]
async fn magic_link_requests_are_rate_limited_per_address() {
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;
    for _ in 0..5 {
        assert_eq!(srv.post("/api/auth/magic", None, json!({"email": u.email})).await.status, 204);
    }
    assert_eq!(srv.post("/api/auth/magic", None, json!({"email": u.email})).await.status, 429);
}

#[tokio::test]
async fn asking_for_a_seat() {
    use reqwest::Method;
    let srv = start_server().await;
    let (owner, stranger, other) = (srv.new_user("Owner").await, srv.new_user("Stranger").await, srv.new_user("Other").await);
    let id = srv.new_scroll(&owner, "Thesis").await;

    // the door tells a stranger only the title and the owner's name; the scroll itself stays a 404
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&stranger)).await.status, 404);
    let door = srv.get(&format!("/api/scrolls/{id}/door"), Some(&stranger)).await;
    assert_eq!((door.status, door.json["title"].as_str(), door.json["ownerName"].as_str()), (200, Some("Thesis"), Some("Owner")));
    assert_eq!((door.json["member"].clone(), door.json["requested"].clone()), (json!(false), json!(false)));
    assert_eq!(srv.get(&format!("/api/scrolls/{id}/door"), None).await.status, 401);
    assert_eq!(srv.get(&format!("/api/scrolls/{}/door", Uuid::new_v4()), Some(&stranger)).await.status, 404);
    assert_eq!(srv.get(&format!("/api/scrolls/{id}/door"), Some(&owner)).await.json["member"], true);

    // ask: the owner is emailed, the request is listed for them only
    assert_eq!(srv.post(&format!("/api/scrolls/{id}/requests"), Some(&owner), json!({})).await.status, 409, "an owner already has a seat");
    assert_eq!(srv.post(&format!("/api/scrolls/{id}/requests"), Some(&stranger), json!({"message": "x".repeat(501)})).await.status, 400);
    let ask = srv.post(&format!("/api/scrolls/{id}/requests"), Some(&stranger), json!({"message": "Hi, I am helping with chapter 4"})).await;
    assert_eq!(ask.status, 202, "{}", ask.json);
    assert!(srv.mails_to(&owner.email).iter().any(|m| m.contains("asks for a seat") && m.contains("helping with chapter 4")));
    assert_eq!(srv.get(&format!("/api/scrolls/{id}/door"), Some(&stranger)).await.json["requested"], true);
    let list = srv.get(&format!("/api/scrolls/{id}/requests"), Some(&owner)).await;
    assert_eq!(list.json.as_array().unwrap().len(), 1);
    assert_eq!(list.json[0]["message"], "Hi, I am helping with chapter 4");
    assert_eq!(srv.get(&format!("/api/scrolls/{id}/requests"), Some(&stranger)).await.status, 404, "only the owner can look");

    // only the owner decides
    let uid = stranger.id;
    assert_eq!(srv.post(&format!("/api/scrolls/{id}/requests/{uid}/approve"), Some(&other), json!({"role": "scribe"})).await.status, 404);
    assert_eq!(srv.post(&format!("/api/scrolls/{id}/requests/{uid}/approve"), Some(&owner), json!({"role": "owner"})).await.status, 400);
    let ok = srv.post(&format!("/api/scrolls/{id}/requests/{uid}/approve"), Some(&owner), json!({"role": "reader"})).await;
    assert_eq!(ok.status, 204, "{}", ok.json);
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&stranger)).await.json["role"], "reader");
    assert!(srv.mails_to(&stranger.email).iter().any(|m| m.contains("gave you a seat")));
    assert_eq!(srv.get(&format!("/api/scrolls/{id}/requests"), Some(&owner)).await.json, json!([]));
    assert_eq!(srv.post(&format!("/api/scrolls/{id}/requests/{uid}/approve"), Some(&owner), json!({"role": "scribe"})).await.status, 404, "nothing left to approve");

    // declining
    srv.post(&format!("/api/scrolls/{id}/requests"), Some(&other), json!({})).await;
    let oid = other.id;
    assert_eq!(srv.send(Method::DELETE, &format!("/api/scrolls/{id}/requests/{oid}"), &stranger, None).await.status, 403, "a reader cannot decline");
    assert_eq!(srv.send(Method::DELETE, &format!("/api/scrolls/{id}/requests/{oid}"), &owner, None).await.status, 204);
    assert_eq!(srv.get(&format!("/api/scrolls/{id}/requests"), Some(&owner)).await.json, json!([]));
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&other)).await.status, 404, "declining gives no seat");
}

#[tokio::test]
async fn share_links_for_editing_and_for_viewing() {
    use reqwest::Method;
    let srv = start_server().await;
    let (owner, scribe, reader, other) = (srv.new_user("Owner").await, srv.new_user("Newscribe").await, srv.new_user("Newreader").await, srv.new_user("Other").await);
    let id = srv.new_scroll(&owner, "Linked").await;

    // nothing is switched on at first, and only the owner can look
    assert_eq!(srv.get(&format!("/api/scrolls/{id}/links"), Some(&owner)).await.json, json!([]));
    assert_eq!(srv.get(&format!("/api/scrolls/{id}/links"), Some(&other)).await.status, 404);

    // switch both on
    let edit = srv.send(Method::PUT, &format!("/api/scrolls/{id}/links/scribe"), &owner, None).await;
    let view = srv.send(Method::PUT, &format!("/api/scrolls/{id}/links/reader"), &owner, None).await;
    assert_eq!((edit.status, view.status), (200, 200), "{} {}", edit.json, view.json);
    let (edit_token, view_token) = (edit.json["token"].as_str().unwrap().to_string(), view.json["token"].as_str().unwrap().to_string());
    assert_ne!(edit_token, view_token);
    assert_eq!(srv.get(&format!("/api/scrolls/{id}/links"), Some(&owner)).await.json.as_array().unwrap().len(), 2);
    assert_eq!(srv.send(Method::PUT, &format!("/api/scrolls/{id}/links/owner"), &owner, None).await.status, 400, "no link makes owners");
    assert_eq!(srv.send(Method::PUT, &format!("/api/scrolls/{id}/links/scribe"), &other, None).await.status, 404, "non-members cannot make links");

    // a stranger must sign in; then the preview says what the link opens
    assert_eq!(srv.get(&format!("/api/links/{edit_token}"), None).await.status, 401);
    let p = srv.get(&format!("/api/links/{edit_token}"), Some(&scribe)).await;
    assert_eq!((p.json["scrollTitle"].as_str(), p.json["role"].as_str()), (Some("Linked"), Some("scribe")));

    // joining takes the seat that the link gives
    let j = srv.post(&format!("/api/links/{edit_token}/join"), Some(&scribe), json!({})).await;
    assert_eq!((j.status, j.json["role"].as_str()), (200, Some("scribe")), "{}", j.json);
    let j = srv.post(&format!("/api/links/{view_token}/join"), Some(&reader), json!({})).await;
    assert_eq!((j.status, j.json["role"].as_str()), (200, Some("reader")), "{}", j.json);
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&reader)).await.json["role"], "reader");

    // never a demotion: a scribe using the viewing link, or the owner using any link, keeps their seat
    assert_eq!(srv.post(&format!("/api/links/{view_token}/join"), Some(&scribe), json!({})).await.json["role"], "scribe");
    assert_eq!(srv.post(&format!("/api/links/{edit_token}/join"), Some(&owner), json!({})).await.json["role"], "owner");
    // a reader who opens the editing link is raised to scribe
    assert_eq!(srv.post(&format!("/api/links/{edit_token}/join"), Some(&reader), json!({})).await.json["role"], "scribe");

    // resetting gives a new address and the old one stops working
    let fresh = srv.send(Method::PUT, &format!("/api/scrolls/{id}/links/scribe"), &owner, None).await.json["token"].as_str().unwrap().to_string();
    assert_ne!(fresh, edit_token);
    assert_eq!(srv.get(&format!("/api/links/{edit_token}"), Some(&other)).await.status, 404);
    assert_eq!(srv.post(&format!("/api/links/{fresh}/join"), Some(&other), json!({})).await.json["role"], "scribe");

    // turning a link off
    assert_eq!(srv.send(Method::DELETE, &format!("/api/scrolls/{id}/links/reader"), &owner, None).await.status, 204);
    assert_eq!(srv.post(&format!("/api/links/{view_token}/join"), Some(&srv.new_user("Late").await), json!({})).await.status, 404);
}

#[tokio::test]
async fn membership_rules() {
    let srv = start_server().await;
    let (owner, scribe, reader, other) = (srv.new_user("Owner").await, srv.new_user("Scribe").await, srv.new_user("Reader").await, srv.new_user("Other").await);
    let id = srv.new_scroll(&owner, "Shared").await;
    let members = |u: &User| srv.get(&format!("/api/scrolls/{id}/members"), Some(u));

    srv.invite(&owner, id, &scribe, "scribe").await;
    srv.invite(&owner, id, &reader, "reader").await;

    // members see the scroll with their own role and the member list
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&scribe)).await.json["role"], "scribe");
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&reader)).await.json["role"], "reader");
    let list = members(&reader).await.json;
    assert_eq!(list.as_array().unwrap().len(), 3);
    assert_eq!(list[0]["role"], "owner"); // owner listed first
    assert_eq!(members(&other).await.status, 404);

    // only the owner manages members
    let add = |by: &User, email: &str, role: &str| srv.post(&format!("/api/scrolls/{id}/invitations"), Some(by), json!({"email": email, "role": role}));
    assert_eq!(add(&scribe, &other.email, "reader").await.status, 403);
    assert_eq!(add(&reader, &other.email, "reader").await.status, 403);
    assert_eq!(add(&owner, &scribe.email, "reader").await.status, 409, "already a member");
    assert_eq!(add(&owner, &other.email, "owner").await.status, 400, "one owner only");
    assert_eq!(add(&owner, "ghost@guild.test", "reader").await.status, 201, "people without an account can be invited");
    assert_eq!(srv.send(reqwest::Method::PATCH, &format!("/api/scrolls/{id}"), &scribe, Some(json!({"title": "x"}))).await.status, 403);
    assert_eq!(srv.send(reqwest::Method::DELETE, &format!("/api/scrolls/{id}"), &scribe, None).await.status, 403);

    // promote / demote
    let set = |by: &User, target: &User, role: &str| srv.send(reqwest::Method::PUT, &format!("/api/scrolls/{id}/members/{}", target.id), by, Some(json!({"role": role})));
    assert_eq!(set(&scribe, &reader, "scribe").await.status, 403);
    assert_eq!(set(&owner, &reader, "scribe").await.status, 204);
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&reader)).await.json["role"], "scribe");
    assert_eq!(set(&owner, &owner, "reader").await.status, 404, "the owner row is immutable");

    // removing: owner removes anyone; members may leave; the owner may not leave
    let remove = |by: &User, target: &User| srv.send(reqwest::Method::DELETE, &format!("/api/scrolls/{id}/members/{}", target.id), by, None);
    assert_eq!(remove(&scribe, &reader).await.status, 403);
    assert_eq!(remove(&scribe, &scribe).await.status, 204, "leave");
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&scribe)).await.status, 404);
    assert_eq!(remove(&owner, &reader).await.status, 204);
    assert_eq!(remove(&owner, &owner).await.status, 400);
}

// ---------------------------------------------------------------------------------------------
// real-time collaboration & access control
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn websocket_access_control() {
    let srv = start_server().await;
    let (owner, stranger) = (srv.new_user("Owner").await, srv.new_user("Stranger").await);
    let id = srv.new_scroll(&owner, "Private").await;
    let room = id.to_string();

    assert_eq!(try_connect(srv.addr, &room, None, None).await.err(), Some(401), "no session");
    assert_eq!(try_connect(srv.addr, &room, Some(&stranger.cookie), None).await.err(), Some(404), "not a member");
    assert_eq!(try_connect(srv.addr, &room, Some(&owner.cookie), Some("https://evil.example")).await.err(), Some(403), "cross-site websocket hijacking");
    assert_eq!(try_connect(srv.addr, "not-a-uuid", Some(&owner.cookie), None).await.err(), Some(400));
    assert!(try_connect(srv.addr, &room, Some(&owner.cookie), Some(ORIGIN)).await.is_ok());
}

#[tokio::test]
async fn scribes_converge() {
    let srv = start_server().await;
    let (a_user, b_user) = (srv.new_user("Aelith").await, srv.new_user("Marcus").await);
    let id = srv.new_scroll(&a_user, "Joint").await;
    srv.invite(&a_user, id, &b_user, "scribe").await;
    let a = connect(&srv, id, &a_user).await;
    let b = connect(&srv, id, &b_user).await;

    a.write_file("main.tex", "hello");
    b.eventually("main.tex", "hello").await;
    b.append("main.tex", " world");
    a.eventually("main.tex", "hello world").await;

    a.append("main.tex", "!");
    b.append("main.tex", "?");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (ta, tb) = (a.read_file("main.tex").unwrap(), b.read_file("main.tex").unwrap());
    assert_eq!(ta, tb, "replicas diverged");
    assert!(ta.starts_with("hello world") && ta.contains('!') && ta.contains('?'));
}

#[tokio::test]
async fn readers_see_everything_but_cannot_write() {
    let srv = start_server().await;
    let (owner, reader) = (srv.new_user("Owner").await, srv.new_user("Reader").await);
    let id = srv.new_scroll(&owner, "Read-only test").await;
    srv.invite(&owner, id, &reader, "reader").await;
    let o = connect(&srv, id, &owner).await;
    let r = connect(&srv, id, &reader).await;

    // the reader receives the owner's edits live
    o.write_file("main.tex", "owner text");
    r.eventually("main.tex", "owner text").await;

    // the reader tries to write: locally it "works" (a hostile client), the server must discard it
    r.write_file("evil.tex", "reader tried to sneak this in");
    r.append("main.tex", " + vandalism");
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(o.read_file("evil.tex"), None, "reader write leaked to a scribe");
    assert_eq!(o.read_file("main.tex").as_deref(), Some("owner text"));

    // ...and it is not in the stored document either: a fresh connection never sees it
    let fresh = connect(&srv, id, &owner).await;
    fresh.eventually("main.tex", "owner text").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(fresh.read_file("evil.tex"), None);

    // readers still share presence
    let upd = {
        let mut aw = r.awareness.lock().unwrap();
        aw.set_local_state(json!({"user": {"name": "Reader"}})).unwrap();
        aw.update().unwrap()
    };
    r.out.send(Message::Awareness(upd).encode_v1()).unwrap();
    for _ in 0..100 {
        if o.awareness.lock().unwrap().iter().any(|(_, s)| s.data.is_some()) { return; }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    panic!("owner never saw the reader's presence");
}

#[tokio::test]
async fn rooms_are_isolated_and_late_joiners_catch_up() {
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;
    let (alpha, beta) = (srv.new_scroll(&u, "alpha").await, srv.new_scroll(&u, "beta").await);
    let a = connect(&srv, alpha, &u).await;
    a.write_file("main.tex", "alpha doc");
    tokio::time::sleep(Duration::from_millis(100)).await;

    let other = connect(&srv, beta, &u).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(other.read_file("main.tex"), None);

    let late = connect(&srv, alpha, &u).await;
    late.eventually("main.tex", "alpha doc").await;
}

#[tokio::test]
async fn document_persists_and_updated_at_moves() {
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;
    let id = srv.new_scroll(&u, "Persisted").await;
    let before = srv.get(&format!("/api/scrolls/{id}"), Some(&u)).await.json["updatedAt"].as_str().unwrap().to_string();

    let a = connect(&srv, id, &u).await;
    a.write_file("main.tex", "survives a restart of the room");
    tokio::time::sleep(Duration::from_millis(250)).await;
    a.disconnect();
    tokio::time::sleep(Duration::from_millis(300)).await; // server flushes + evicts the room

    let again = connect(&srv, id, &u).await;
    again.eventually("main.tex", "survives a restart of the room").await;
    let after = srv.get(&format!("/api/scrolls/{id}"), Some(&u)).await.json["updatedAt"].as_str().unwrap().to_string();
    assert!(after > before, "updatedAt should move after edits ({before} -> {after})");
}

#[tokio::test]
async fn presence_is_shared_and_cleared_when_a_client_leaves() {
    let srv = start_server().await;
    let (au, bu) = (srv.new_user("Aelith").await, srv.new_user("Marcus").await);
    let id = srv.new_scroll(&au, "presence").await;
    srv.invite(&au, id, &bu, "scribe").await;
    let a = connect(&srv, id, &au).await;
    let b = connect(&srv, id, &bu).await;
    tokio::time::sleep(Duration::from_millis(150)).await;

    let update = {
        let mut aw = a.awareness.lock().unwrap();
        aw.set_local_state(json!({"user": {"name": "Aelith", "color": "#D9772B"}})).unwrap();
        aw.update().unwrap()
    };
    a.out.send(Message::Awareness(update).encode_v1()).unwrap();

    // removed clients linger as tombstones (data == None); only live states count
    let count = |c: &Client| c.awareness.lock().unwrap().iter().filter(|(_, st)| st.data.is_some()).count();
    for _ in 0..100 {
        if count(&b) == 1 { break; }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    assert_eq!(count(&b), 1, "B should see A's presence");
    a.disconnect();
    for _ in 0..100 {
        if count(&b) == 0 { break; }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    assert_eq!(count(&b), 0, "A's presence must be removed when A disconnects");
}

// ---------------------------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn compile_returns_pdf_and_diagnostics() {
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;
    let id = srv.new_scroll(&u, "Build").await;
    let c = connect(&srv, id, &u).await;
    c.write_file("main.tex", "\\documentclass{article}\\begin{document}Hi\\end{document}");
    tokio::time::sleep(Duration::from_millis(200)).await;

    let r = srv.post(&format!("/api/rooms/{id}/compile"), Some(&u), json!({})).await;
    assert_eq!(r.status, 200, "{}", r.json);
    assert_eq!(r.json["ok"], true);
    assert_eq!(r.json["diagnostics"][0]["severity"], "warning");
    let url = r.json["pdfUrl"].as_str().unwrap().to_string();
    let pdf = srv.get(&url, Some(&u)).await;
    assert_eq!(pdf.status, 200);
    assert!(pdf.bytes.starts_with(b"%PDF-1.4 stub of main.tex"));

    c.append("main.tex", " FAIL");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let r = srv.post(&format!("/api/rooms/{id}/compile"), Some(&u), json!({})).await;
    assert_eq!(r.json["ok"], false);
    assert!(r.json["pdfUrl"].is_null());
    assert_eq!((r.json["diagnostics"][0]["file"].as_str(), r.json["diagnostics"][0]["line"].as_u64()), (Some("main.tex"), Some(3)));
    assert_eq!(srv.get(&url, Some(&u)).await.status, 200, "the last good PDF stays available");
}

#[tokio::test]
async fn compile_builds_the_selected_source() {
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;
    let id = srv.new_scroll(&u, "Slides").await;
    let c = connect(&srv, id, &u).await;
    c.write_file("main.tex", "\\documentclass{article}");
    c.write_file("slides.tex", "\\documentclass{beamer}");
    tokio::time::sleep(Duration::from_millis(200)).await;

    let r = srv.post(&format!("/api/rooms/{id}/compile"), Some(&u), json!({ "main": "slides.tex" })).await;
    assert_eq!(r.status, 200, "{}", r.json);
    let pdf = srv.get(r.json["pdfUrl"].as_str().unwrap(), Some(&u)).await;
    assert!(pdf.bytes.starts_with(b"%PDF-1.4 stub of slides.tex"), "{:?}", String::from_utf8_lossy(&pdf.bytes));

    // something that is not a source of this scroll falls back to the main file
    let r = srv.post(&format!("/api/rooms/{id}/compile"), Some(&u), json!({ "main": "nope.tex" })).await;
    let pdf = srv.get(r.json["pdfUrl"].as_str().unwrap(), Some(&u)).await;
    assert!(pdf.bytes.starts_with(b"%PDF-1.4 stub of main.tex"));
}

#[tokio::test]
async fn compile_keeps_spanish_symbols_by_neutralising_8bit_fontenc() {
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;
    let id = srv.new_scroll(&u, "Espanol").await;
    let c = connect(&srv, id, &u).await;
    c.write_file("main.tex", "NEEDS_FONTENC_SHIM \\usepackage[T1]{fontenc} ¿Qué pasa? ¡Hola!");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let r = srv.post(&format!("/api/rooms/{id}/compile"), Some(&u), json!({})).await;
    assert_eq!(r.json["ok"], true, "{}", r.json);
}

#[tokio::test]
async fn compile_and_pdf_permissions() {
    let srv = start_server().await;
    let (owner, scribe, reader, stranger) = (srv.new_user("Owner").await, srv.new_user("Scribe").await, srv.new_user("Reader").await, srv.new_user("Stranger").await);
    let id = srv.new_scroll(&owner, "Perms").await;
    srv.invite(&owner, id, &scribe, "scribe").await;
    srv.invite(&owner, id, &reader, "reader").await;
    let c = connect(&srv, id, &owner).await;
    c.write_file("main.tex", "x");
    tokio::time::sleep(Duration::from_millis(200)).await;

    let compile = |u: Option<&User>| srv.post(&format!("/api/rooms/{id}/compile"), u, json!({}));
    assert_eq!(compile(None).await.status, 401);
    assert_eq!(compile(Some(&stranger)).await.status, 404);
    assert_eq!(compile(Some(&reader)).await.status, 403, "readers may not spend compile time");
    assert_eq!(compile(Some(&scribe)).await.status, 200);
    assert_eq!(compile(Some(&owner)).await.status, 200);

    let pdf = |u: Option<&User>| srv.get(&format!("/api/rooms/{id}/pdf"), u);
    assert_eq!(pdf(None).await.status, 401);
    assert_eq!(pdf(Some(&stranger)).await.status, 404);
    assert_eq!(pdf(Some(&reader)).await.status, 200, "readers may download the PDF");
}

#[tokio::test]
async fn bad_room_ids_and_empty_rooms() {
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;
    assert_eq!(srv.post("/api/rooms/not-a-uuid/compile", Some(&u), json!({})).await.status, 400);
    let id = srv.new_scroll(&u, "Empty").await;
    assert_eq!(srv.post(&format!("/api/rooms/{id}/compile"), Some(&u), json!({})).await.status, 422);
    assert_eq!(srv.get(&format!("/api/rooms/{id}/pdf"), Some(&u)).await.status, 404);
    let health = srv.get("/healthz", None).await;
    assert_eq!((health.status, health.bytes.as_slice()), (200, b"ok".as_slice()));
}


// ---------------------------------------------------------------------------------------------
// abuse protection
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn failed_logins_lock_an_account_for_a_while() {
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;
    let attempt = |pw: &'static str| srv.post("/api/auth/login", None, json!({"email": u.email, "password": pw}));
    for _ in 0..5 {
        assert_eq!(attempt("wrong password!!").await.status, 400);
    }
    let locked = attempt("wrong password!!").await;
    assert_eq!(locked.status, 429);
    assert!(locked.retry_after.as_deref().and_then(|v| v.parse::<u64>().ok()).is_some_and(|s| s > 0), "Retry-After header");
    assert_eq!(attempt(PASSWORD).await.status, 429, "even the right password waits out the lockout");

    // the lockout is per email: other accounts are unaffected, and unknown emails lock too (no oracle)
    let other = srv.new_user("Other").await;
    assert_eq!(srv.post("/api/auth/login", None, json!({"email": other.email, "password": PASSWORD})).await.status, 200);
    for _ in 0..5 {
        srv.post("/api/auth/login", None, json!({"email": "ghost@guild.test", "password": "wrong password!!"})).await;
    }
    assert_eq!(srv.post("/api/auth/login", None, json!({"email": "ghost@guild.test", "password": "wrong password!!"})).await.status, 429);
}

#[tokio::test]
async fn a_successful_login_resets_the_failure_counter() {
    let srv = start_server().await;
    let u = srv.new_user("Marcus").await;
    let attempt = |pw: &'static str| srv.post("/api/auth/login", None, json!({"email": u.email, "password": pw}));
    for _ in 0..4 {
        assert_eq!(attempt("wrong password!!").await.status, 400);
    }
    assert_eq!(attempt(PASSWORD).await.status, 200);
    for _ in 0..4 {
        assert_eq!(attempt("wrong password!!").await.status, 400, "counter was cleared by the success");
    }
}

#[tokio::test]
async fn auth_requests_are_limited_per_client_ip() {
    let srv = start_server_with(|c| c.ip_auth_max = 4).await;
    let body = |i: u32| json!({"email": format!("flood-{i}-{}@guild.test", Uuid::new_v4().simple()), "displayName": "Flood", "password": PASSWORD});
    for i in 0..4 {
        assert_eq!(srv.post("/api/auth/signup", None, body(i)).await.status, 201);
    }
    assert_eq!(srv.post("/api/auth/signup", None, body(9)).await.status, 429);
    assert_eq!(srv.post("/api/auth/login", None, json!({"email": "a@b.test", "password": "x"})).await.status, 429, "the budget is shared across auth endpoints");
}

// ---------------------------------------------------------------------------------------------
// email verification & password reset
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn email_verification_flow() {
    let srv = start_server().await;
    let u = srv.new_unverified_user("Rowan").await;
    assert_eq!(srv.get("/api/me", Some(&u)).await.json["emailVerified"], false);
    assert_eq!(srv.mails_to(&u.email).len(), 1, "a confirmation mail is sent at signup");

    let token = srv.link_value(&u.email, "token=");
    assert_eq!(srv.post("/api/auth/verify", None, json!({"token": "bogus"})).await.status, 400);
    assert_eq!(srv.post("/api/auth/verify", None, json!({"token": token})).await.status, 204);
    assert_eq!(srv.get("/api/me", Some(&u)).await.json["emailVerified"], true);
    assert_eq!(srv.post("/api/auth/verify", None, json!({"token": token})).await.status, 400, "links work once");

    // already verified: resending is a quiet no-op
    assert_eq!(srv.post("/api/auth/resend-verification", Some(&u), json!({})).await.status, 204);
    assert_eq!(srv.mails_to(&u.email).len(), 1);
}

#[tokio::test]
async fn verification_links_expire_and_resends_are_limited() {
    let srv = start_server().await;
    let u = srv.new_unverified_user("Mirelle").await;
    let token = srv.link_value(&u.email, "token=");
    sqlx::query("UPDATE email_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1").bind(u.id).execute(&srv.db).await.unwrap();
    assert_eq!(srv.post("/api/auth/verify", None, json!({"token": token})).await.status, 400);

    for _ in 0..3 {
        assert_eq!(srv.post("/api/auth/resend-verification", Some(&u), json!({})).await.status, 204);
    }
    assert_eq!(srv.post("/api/auth/resend-verification", Some(&u), json!({})).await.status, 429);
    assert_eq!(srv.mails_to(&u.email).len(), 4, "1 at signup + 3 resends");
}

#[tokio::test]
async fn password_reset_flow() {
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;
    let old_session = u.clone();

    // never reveals whether an account exists
    let ghost = srv.post("/api/auth/forgot", None, json!({"email": "ghost@guild.test"})).await;
    let real = srv.post("/api/auth/forgot", None, json!({"email": u.email.to_uppercase()})).await;
    assert_eq!((ghost.status, real.status), (204, 204));
    assert!(srv.mails_to("ghost@guild.test").is_empty());
    assert_eq!(srv.mails_to(&u.email).len(), 2, "the signup confirmation plus the reset link");
    assert!(srv.mails_to(&u.email)[1].contains("reset-password?token="));

    let token = srv.link_value(&u.email, "token=");
    let new_pw = "a brand new passphrase";
    assert_eq!(srv.post("/api/auth/reset", None, json!({"token": token, "password": "short"})).await.status, 400);
    assert_eq!(srv.post("/api/auth/reset", None, json!({"token": "bogus", "password": new_pw})).await.status, 400);
    assert_eq!(srv.post("/api/auth/reset", None, json!({"token": token, "password": new_pw})).await.status, 204, "a weak attempt did not burn the link");

    assert_eq!(srv.get("/api/me", Some(&old_session)).await.status, 401, "every old session is signed out");
    assert_eq!(srv.post("/api/auth/login", None, json!({"email": u.email, "password": PASSWORD})).await.status, 400);
    assert_eq!(srv.post("/api/auth/login", None, json!({"email": u.email, "password": new_pw})).await.status, 200);
    assert_eq!(srv.post("/api/auth/reset", None, json!({"token": token, "password": "yet another one!"})).await.status, 400, "links work once");
}

#[tokio::test]
async fn only_the_newest_reset_link_works_and_requests_are_limited() {
    let srv = start_server().await;
    let u = srv.new_user("Marcus").await;
    srv.post("/api/auth/forgot", None, json!({"email": u.email})).await;
    let first = srv.link_value(&u.email, "token=");
    srv.post("/api/auth/forgot", None, json!({"email": u.email})).await;
    let second = srv.link_value(&u.email, "token=");
    assert_ne!(first, second);
    assert_eq!(srv.post("/api/auth/reset", None, json!({"token": first, "password": "a brand new passphrase"})).await.status, 400);
    assert_eq!(srv.post("/api/auth/reset", None, json!({"token": second, "password": "a brand new passphrase"})).await.status, 204);

    srv.post("/api/auth/forgot", None, json!({"email": u.email})).await; // 3rd in the hour
    assert_eq!(srv.post("/api/auth/forgot", None, json!({"email": u.email})).await.status, 429);
}

#[tokio::test]
async fn reset_links_expire() {
    let srv = start_server().await;
    let u = srv.new_user("Rowan").await;
    srv.post("/api/auth/forgot", None, json!({"email": u.email})).await;
    let token = srv.link_value(&u.email, "token=");
    sqlx::query("UPDATE email_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND kind = 'reset'").bind(u.id).execute(&srv.db).await.unwrap();
    assert_eq!(srv.post("/api/auth/reset", None, json!({"token": token, "password": "a brand new passphrase"})).await.status, 400);
}

#[tokio::test]
async fn resetting_also_verifies_the_email() {
    let srv = start_server().await;
    let u = srv.new_unverified_user("Mirelle").await;
    srv.post("/api/auth/forgot", None, json!({"email": u.email})).await;
    let token = srv.link_value(&u.email, "token=");
    srv.post("/api/auth/reset", None, json!({"token": token, "password": "a brand new passphrase"})).await;
    let login = srv.post("/api/auth/login", None, json!({"email": u.email, "password": "a brand new passphrase"})).await;
    assert_eq!(login.json["emailVerified"], true, "proving control of the inbox verifies it");
}

// ---------------------------------------------------------------------------------------------
// profile, password, sessions, deletion
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn profile_updates_are_validated() {
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;
    let patch = |body: Value| srv.send(reqwest::Method::PATCH, "/api/me", &u, Some(body));
    let ok = patch(json!({"displayName": "  Dame Aelith  ", "color": "#D9772B"})).await;
    assert_eq!((ok.status, ok.json["displayName"].as_str(), ok.json["color"].as_str()), (200, Some("Dame Aelith"), Some("#D9772B")));
    assert_eq!(srv.get("/api/me", Some(&u)).await.json["displayName"], "Dame Aelith");
    assert_eq!(patch(json!({"displayName": "   "})).await.status, 400);
    assert_eq!(patch(json!({"displayName": "x".repeat(61)})).await.status, 400);
    assert_eq!(patch(json!({"color": "#123456"})).await.status, 400, "only offered colours");
    assert_eq!(patch(json!({"color": "javascript:alert(1)"})).await.status, 400);
    assert_eq!(patch(json!({})).await.status, 200, "no-op");

    // a line about who you write for: trimmed, one line, bounded, and clearable
    let aff = patch(json!({"affiliation": "  University of Costa Rica  "})).await;
    assert_eq!((aff.status, aff.json["affiliation"].as_str()), (200, Some("University of Costa Rica")));
    assert_eq!(srv.get("/api/me", Some(&u)).await.json["affiliation"], "University of Costa Rica");
    assert_eq!(patch(json!({"displayName": "Dame Aelith"})).await.json["affiliation"], "University of Costa Rica", "other edits keep it");
    assert_eq!(patch(json!({"affiliation": "two\nlines"})).await.status, 400);
    assert_eq!(patch(json!({"affiliation": "x".repeat(81)})).await.status, 400);
    assert_eq!(patch(json!({"affiliation": ""})).await.json["affiliation"], "");
}

#[tokio::test]
async fn changing_the_password_signs_out_other_devices_only() {
    let srv = start_server().await;
    let u = srv.new_user("Marcus").await;
    let other_device = User { cookie: srv.post("/api/auth/login", None, json!({"email": u.email, "password": PASSWORD})).await.cookie.unwrap(), ..u.clone() };

    let change = |cur: &str, new: &str| srv.post("/api/me/password", Some(&u), json!({"currentPassword": cur, "newPassword": new}));
    assert_eq!(change("not my password", "a brand new passphrase").await.status, 400);
    assert_eq!(change(PASSWORD, "short").await.status, 400);
    assert_eq!(change(PASSWORD, "a brand new passphrase").await.status, 204);

    assert_eq!(srv.get("/api/me", Some(&u)).await.status, 200, "this device stays signed in");
    assert_eq!(srv.get("/api/me", Some(&other_device)).await.status, 401, "other devices are signed out");
    assert_eq!(srv.post("/api/auth/login", None, json!({"email": u.email, "password": "a brand new passphrase"})).await.status, 200);
}

#[tokio::test]
async fn sessions_can_be_listed_and_revoked() {
    let srv = start_server().await;
    let u = srv.new_user("Rowan").await;
    let laptop = User { cookie: srv.post("/api/auth/login", None, json!({"email": u.email, "password": PASSWORD})).await.cookie.unwrap(), ..u.clone() };

    let list = srv.get("/api/me/sessions", Some(&u)).await.json;
    let sessions = list.as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions.iter().filter(|s| s["current"] == true).count(), 1);
    let other_id = sessions.iter().find(|s| s["current"] == false).unwrap()["id"].as_str().unwrap().to_string();

    assert_eq!(srv.send(reqwest::Method::DELETE, &format!("/api/me/sessions/{other_id}"), &u, None).await.status, 204);
    assert_eq!(srv.get("/api/me", Some(&laptop)).await.status, 401);
    assert_eq!(srv.get("/api/me", Some(&u)).await.status, 200);

    // you cannot revoke someone else's session
    let victim = srv.new_user("Victim").await;
    let vid = srv.get("/api/me/sessions", Some(&victim)).await.json[0]["id"].as_str().unwrap().to_string();
    srv.send(reqwest::Method::DELETE, &format!("/api/me/sessions/{vid}"), &u, None).await;
    assert_eq!(srv.get("/api/me", Some(&victim)).await.status, 200);
}

#[tokio::test]
async fn sessions_remember_which_browser_started_them() {
    let srv = start_server().await;
    let u = srv.new_user("Rowan").await;
    let ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15";
    let login = srv.http.post(format!("http://{}/api/auth/login", srv.addr)).header("user-agent", ua).json(&json!({"email": u.email, "password": PASSWORD})).send().await.unwrap();
    assert_eq!(login.status(), 200);
    let list = srv.get("/api/me/sessions", Some(&u)).await.json;
    let agents: Vec<&str> = list.as_array().unwrap().iter().map(|s| s["userAgent"].as_str().unwrap()).collect();
    assert!(agents.contains(&ua), "{agents:?}");
    // an enormous header is stored bounded
    let long = format!("Agent/{}", "x".repeat(500));
    srv.http.post(format!("http://{}/api/auth/login", srv.addr)).header("user-agent", long).json(&json!({"email": u.email, "password": PASSWORD})).send().await.unwrap();
    let list = srv.get("/api/me/sessions", Some(&u)).await.json;
    assert!(list.as_array().unwrap().iter().all(|s| s["userAgent"].as_str().unwrap().chars().count() <= 200));
    assert!(list.as_array().unwrap().iter().any(|s| s["userAgent"].as_str().unwrap().starts_with("Agent/xxx")));
}

#[tokio::test]
async fn deleting_an_account_hands_shared_scrolls_to_the_next_scribe() {
    let srv = start_server().await;
    let (owner, scribe, reader) = (srv.new_user("Owner").await, srv.new_user("Scribe").await, srv.new_user("Reader").await);
    let shared = srv.new_scroll(&owner, "Shared").await;
    let solo = srv.new_scroll(&owner, "Solo").await;
    srv.invite(&owner, shared, &reader, "reader").await;
    srv.invite(&owner, shared, &scribe, "scribe").await;

    let del = |pw: &str| srv.send(reqwest::Method::DELETE, "/api/me", &owner, Some(json!({"password": pw})));
    assert_eq!(del("wrong password").await.status, 400);
    assert_eq!(del(PASSWORD).await.status, 204);

    assert_eq!(srv.get("/api/me", Some(&owner)).await.status, 401, "sessions are gone");
    assert_eq!(srv.post("/api/auth/login", None, json!({"email": owner.email, "password": PASSWORD})).await.status, 400);
    // the scribe (preferred over the reader) became the owner and still has the scroll
    assert_eq!(srv.get(&format!("/api/scrolls/{shared}"), Some(&scribe)).await.json["role"], "owner");
    assert_eq!(srv.get(&format!("/api/scrolls/{shared}"), Some(&reader)).await.json["role"], "reader");
    // the scroll nobody else had is gone
    assert_eq!(srv.get(&format!("/api/scrolls/{solo}"), Some(&scribe)).await.status, 404);
    let owner_count: i64 = sqlx::query_scalar("SELECT count(*) FROM scroll_members WHERE scroll_id = $1 AND role = 'owner'").bind(shared).fetch_one(&srv.db).await.unwrap();
    assert_eq!(owner_count, 1);
}

// ---------------------------------------------------------------------------------------------
// invitations
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn invitations_reach_people_without_an_account() {
    let srv = start_server().await;
    let owner = srv.new_user("Owner").await;
    let id = srv.new_scroll(&owner, "Thesis").await;
    let ghost = format!("newcomer-{}@guild.test", Uuid::new_v4().simple());

    let r = srv.post(&format!("/api/scrolls/{id}/invitations"), Some(&owner), json!({"email": ghost, "role": "reader"})).await;
    assert_eq!(r.status, 201);
    let invite_id = r.json["id"].as_str().unwrap().to_string();
    assert!(srv.mails_to(&ghost)[0].contains(&format!("/invitations/{invite_id}")), "the mail links to the invitation");

    // they sign up with that address, but unverified they can see and accept nothing
    let newcomer = srv.signup("Newcomer", &ghost).await;
    assert_eq!(srv.get("/api/invitations", Some(&newcomer)).await.status, 403);
    assert_eq!(srv.post(&format!("/api/invitations/{invite_id}/accept"), Some(&newcomer), json!({})).await.status, 403);

    // verified -> it appears with details, and accepting grants the invited role
    let token = srv.link_value(&ghost, "token=");
    assert_eq!(srv.post("/api/auth/verify", None, json!({"token": token})).await.status, 204);
    let mine = srv.get("/api/invitations", Some(&newcomer)).await.json;
    assert_eq!((mine.as_array().unwrap().len(), mine[0]["scrollTitle"].as_str(), mine[0]["inviterName"].as_str(), mine[0]["role"].as_str()), (1, Some("Thesis"), Some("Owner"), Some("reader")));
    assert_eq!(srv.get(&format!("/api/invitations/{invite_id}"), Some(&newcomer)).await.status, 200);
    let accepted = srv.post(&format!("/api/invitations/{invite_id}/accept"), Some(&newcomer), json!({})).await;
    assert_eq!((accepted.status, accepted.json["scrollId"].as_str()), (200, Some(id.to_string().as_str())));
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&newcomer)).await.json["role"], "reader");
    assert_eq!(srv.get("/api/invitations", Some(&newcomer)).await.json.as_array().unwrap().len(), 0);
    assert_eq!(srv.post(&format!("/api/invitations/{invite_id}/accept"), Some(&newcomer), json!({})).await.status, 404, "accepting twice");
}

#[tokio::test]
async fn invitations_cannot_be_claimed_by_other_people() {
    let srv = start_server().await;
    let (owner, invitee, intruder) = (srv.new_user("Owner").await, srv.new_user("Invitee").await, srv.new_user("Intruder").await);
    let id = srv.new_scroll(&owner, "Private").await;
    let r = srv.post(&format!("/api/scrolls/{id}/invitations"), Some(&owner), json!({"email": invitee.email, "role": "scribe"})).await;
    let invite_id = r.json["id"].as_str().unwrap().to_string();

    // knowing the invitation id is not enough: it is bound to the invited (verified) email
    assert_eq!(srv.get(&format!("/api/invitations/{invite_id}"), Some(&intruder)).await.status, 404);
    assert_eq!(srv.post(&format!("/api/invitations/{invite_id}/accept"), Some(&intruder), json!({})).await.status, 404);
    srv.send(reqwest::Method::DELETE, &format!("/api/invitations/{invite_id}"), &intruder, None).await; // cannot decline it either
    assert_eq!(srv.get(&format!("/api/scrolls/{id}"), Some(&intruder)).await.status, 404);
    assert_eq!(srv.get("/api/invitations", Some(&intruder)).await.json.as_array().unwrap().len(), 0);
    assert_eq!(srv.post(&format!("/api/invitations/{invite_id}/accept"), Some(&invitee), json!({})).await.status, 200, "the rightful invitee still can");

    // unauthenticated is rejected outright
    assert_eq!(srv.get("/api/invitations", None).await.status, 401);
}

#[tokio::test]
async fn managing_invitations() {
    let srv = start_server().await;
    let (owner, scribe) = (srv.new_user("Owner").await, srv.new_user("Scribe").await);
    let id = srv.new_scroll(&owner, "Managed").await;
    srv.invite(&owner, id, &scribe, "scribe").await;
    let invite = |by: &User, email: &str, role: &str| srv.post(&format!("/api/scrolls/{id}/invitations"), Some(by), json!({"email": email, "role": role}));

    assert_eq!(invite(&scribe, "x@guild.test", "reader").await.status, 403, "only the owner invites");
    assert_eq!(srv.get(&format!("/api/scrolls/{id}/invitations"), Some(&scribe)).await.status, 403);
    assert_eq!(invite(&owner, &scribe.email, "reader").await.status, 409, "already a member");
    assert_eq!(invite(&owner, "not-an-email", "reader").await.status, 400);
    assert_eq!(invite(&owner, "x@guild.test", "owner").await.status, 400);

    // re-inviting the same address updates the single pending invitation
    let first = invite(&owner, "pending@guild.test", "reader").await;
    let again = invite(&owner, "PENDING@guild.test", "scribe").await;
    assert_eq!(first.json["id"], again.json["id"]);
    let pending = srv.get(&format!("/api/scrolls/{id}/invitations"), Some(&owner)).await.json;
    assert_eq!((pending.as_array().unwrap().len(), pending[0]["role"].as_str()), (1, Some("scribe")));

    // revoke
    let inv_id = first.json["id"].as_str().unwrap();
    assert_eq!(srv.send(reqwest::Method::DELETE, &format!("/api/scrolls/{id}/invitations/{inv_id}"), &scribe, None).await.status, 403);
    assert_eq!(srv.send(reqwest::Method::DELETE, &format!("/api/scrolls/{id}/invitations/{inv_id}"), &owner, None).await.status, 204);
    assert_eq!(srv.get(&format!("/api/scrolls/{id}/invitations"), Some(&owner)).await.json.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn expired_and_declined_invitations_are_unusable() {
    let srv = start_server().await;
    let (owner, a, b) = (srv.new_user("Owner").await, srv.new_user("A").await, srv.new_user("B").await);
    let id = srv.new_scroll(&owner, "Expiry").await;
    let ia = srv.post(&format!("/api/scrolls/{id}/invitations"), Some(&owner), json!({"email": a.email, "role": "reader"})).await.json["id"].as_str().unwrap().to_string();
    let ib = srv.post(&format!("/api/scrolls/{id}/invitations"), Some(&owner), json!({"email": b.email, "role": "reader"})).await.json["id"].as_str().unwrap().to_string();

    sqlx::query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id::text = $1").bind(&ia).execute(&srv.db).await.unwrap();
    assert_eq!(srv.get("/api/invitations", Some(&a)).await.json.as_array().unwrap().len(), 0);
    assert_eq!(srv.post(&format!("/api/invitations/{ia}/accept"), Some(&a), json!({})).await.status, 404);

    assert_eq!(srv.send(reqwest::Method::DELETE, &format!("/api/invitations/{ib}"), &b, None).await.status, 204, "decline");
    assert_eq!(srv.post(&format!("/api/invitations/{ib}/accept"), Some(&b), json!({})).await.status, 404);

    // a deleted scroll's invitations die with it
    let ic = srv.new_scroll(&owner, "Gone").await;
    let inv = srv.post(&format!("/api/scrolls/{ic}/invitations"), Some(&owner), json!({"email": a.email, "role": "reader"})).await.json["id"].as_str().unwrap().to_string();
    srv.send(reqwest::Method::DELETE, &format!("/api/scrolls/{ic}"), &owner, None).await;
    assert_eq!(srv.post(&format!("/api/invitations/{inv}/accept"), Some(&a), json!({})).await.status, 404);
}

// ---------------------------------------------------------------------------------------------
// presence identity
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn presence_names_come_from_the_server_not_the_client() {
    let srv = start_server().await;
    let (au, bu) = (srv.new_user("Aelith").await, srv.new_user("Marcus").await);
    let id = srv.new_scroll(&au, "Impersonation").await;
    srv.invite(&au, id, &bu, "scribe").await;
    let a = connect(&srv, id, &au).await;
    let b = connect(&srv, id, &bu).await;
    tokio::time::sleep(Duration::from_millis(150)).await;

    // Aelith's client lies about who she is (and tries to look like the owner "Admin")
    let update = {
        let mut aw = a.awareness.lock().unwrap();
        aw.set_local_state(json!({"user": {"name": "Admin", "color": "#000000"}, "cursor": {"line": 3}})).unwrap();
        aw.update().unwrap()
    };
    a.out.send(Message::Awareness(update).encode_v1()).unwrap();

    let seen = |c: &Client| -> Option<Value> {
        c.awareness.lock().unwrap().iter().find_map(|(_, st)| st.data.as_ref().and_then(|d| serde_json::from_str(d).ok()))
    };
    let mut state = None;
    for _ in 0..100 {
        state = seen(&b);
        if state.is_some() { break; }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let state = state.expect("B never saw A's presence");
    assert_eq!(state["user"]["name"], "Aelith", "the server overwrites the claimed name: {state}");
    assert_eq!(state["user"]["id"], au.id.to_string(), "and says whose account it is, so a scribe's own tabs can be told apart");
    assert_ne!(state["user"]["color"], "#000000");
    assert_eq!(state["cursor"]["line"], 3, "other presence fields (cursor) pass through untouched");
}

#[tokio::test]
async fn presence_follows_a_changed_profile_without_reconnecting() {
    let srv = start_server().await;
    let (au, bu) = (srv.new_user("Aelith").await, srv.new_user("Marcus").await);
    let id = srv.new_scroll(&au, "Renames").await;
    srv.invite(&au, id, &bu, "scribe").await;
    let a = connect(&srv, id, &au).await;
    let b = connect(&srv, id, &bu).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    let announce = |c: &Client| {
        let update = {
            let mut aw = c.awareness.lock().unwrap();
            aw.set_local_state(json!({"user": {"name": "ignored"}})).unwrap();
            aw.update().unwrap()
        };
        c.out.send(Message::Awareness(update).encode_v1()).unwrap();
    };
    let seen = |c: &Client| -> Option<Value> { c.awareness.lock().unwrap().iter().find_map(|(_, st)| st.data.as_ref().and_then(|d| serde_json::from_str(d).ok())) };
    announce(&a);
    let mut first = None;
    for _ in 0..100 {
        first = seen(&b);
        if first.is_some() { break; }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    assert_eq!(first.expect("presence")["user"]["name"], "Aelith");

    // she renames herself and picks a new colour while connected; her next presence message carries both
    let patch = srv.send(reqwest::Method::PATCH, "/api/me", &au, Some(json!({"displayName": "Aelith the Bold", "color": "#9B3030"}))).await;
    assert_eq!(patch.status, 200);
    announce(&a);
    let mut now = None;
    for _ in 0..100 {
        now = seen(&b).filter(|s| s["user"]["name"] == "Aelith the Bold");
        if now.is_some() { break; }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let now = now.expect("B never saw the new name");
    assert_eq!(now["user"]["color"], "#9B3030");
}

// ---------------------------------------------------------------------------------------------
// assets (images, PDFs)
// ---------------------------------------------------------------------------------------------

fn png() -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    v.extend_from_slice(b"fake-image-data");
    v
}

async fn team(srv: &TestServer) -> (User, User, User, User, Uuid) {
    let (owner, scribe, reader, stranger) = (srv.new_user("Owner").await, srv.new_user("Scribe").await, srv.new_user("Reader").await, srv.new_user("Stranger").await);
    let id = srv.new_scroll(&owner, "Assets").await;
    srv.invite(&owner, id, &scribe, "scribe").await;
    srv.invite(&owner, id, &reader, "reader").await;
    (owner, scribe, reader, stranger, id)
}

#[tokio::test]
async fn assets_upload_download_list_and_delete() {
    let srv = start_server().await;
    let (owner, scribe, reader, stranger, id) = team(&srv).await;
    let watcher = connect(&srv, id, &reader).await;
    let url = format!("/api/scrolls/{id}/assets/figures/orbit.png");

    assert_eq!(srv.raw(reqwest::Method::PUT, &url, None, png()).await.status, 401);
    assert_eq!(srv.raw(reqwest::Method::PUT, &url, Some(&stranger), png()).await.status, 404);
    assert_eq!(srv.raw(reqwest::Method::PUT, &url, Some(&reader), png()).await.status, 403, "readers cannot upload");
    let up = srv.raw(reqwest::Method::PUT, &url, Some(&scribe), png()).await;
    assert_eq!(up.status, 200, "{}", up.json);
    assert_eq!((up.json["path"].as_str(), up.json["mime"].as_str(), up.json["size"].as_i64()), (Some("figures/orbit.png"), Some("image/png"), Some(png().len() as i64)));
    assert_eq!(up.json["sha256"].as_str().unwrap().len(), 64);

    // everyone at the table sees it appear in the shared document, live
    watcher.eventually_assets(&["figures/orbit.png"]).await;

    // members can download it, with a locked-down policy; strangers cannot
    let got = srv.get(&url, Some(&reader)).await;
    assert_eq!((got.status, got.bytes.as_slice()), (200, png().as_slice()));
    assert_eq!(got.header("content-type"), Some("image/png"));
    assert_eq!(got.header("x-content-type-options"), Some("nosniff"));
    assert!(got.header("content-security-policy").unwrap().contains("sandbox"));
    assert_eq!(srv.get(&url, Some(&stranger)).await.status, 404);
    assert_eq!(srv.get(&url, None).await.status, 401);
    let list = srv.get(&format!("/api/scrolls/{id}/assets"), Some(&reader)).await.json;
    assert_eq!((list.as_array().unwrap().len(), list[0]["path"].as_str()), (1, Some("figures/orbit.png")));

    // replace in place, then delete
    let mut bigger = png();
    bigger.extend_from_slice(&[0u8; 100]);
    assert_eq!(srv.raw(reqwest::Method::PUT, &url, Some(&owner), bigger.clone()).await.status, 200);
    assert_eq!(srv.get(&url, Some(&owner)).await.bytes, bigger);
    assert_eq!(srv.raw(reqwest::Method::DELETE, &url, Some(&reader), vec![]).await.status, 403);
    assert_eq!(srv.raw(reqwest::Method::DELETE, &url, Some(&scribe), vec![]).await.status, 204);
    assert_eq!(srv.get(&url, Some(&owner)).await.status, 404);
    watcher.eventually_assets(&[]).await;
    assert_eq!(srv.raw(reqwest::Method::DELETE, &url, Some(&scribe), vec![]).await.status, 404);
}

#[tokio::test]
async fn assets_can_be_moved_renamed_and_copied_on_the_server() {
    let srv = start_server().await;
    let (owner, scribe, reader, stranger, id) = team(&srv).await;
    let watcher = connect(&srv, id, &reader).await;
    let base = format!("/api/scrolls/{id}");
    let put = |path: &str| srv.raw(reqwest::Method::PUT, &format!("{base}/assets/{path}"), Some(&owner), png());
    let mv = |u: &User, from: &str, to: &str, copy: bool| srv.post(&format!("{base}/asset-moves"), Some(u), json!({ "from": from, "to": to, "copy": copy }));
    assert_eq!(put("figures/orbit.png").await.status, 200);
    watcher.eventually_assets(&["figures/orbit.png"]).await;

    // permissions first
    assert_eq!(mv(&reader, "figures/orbit.png", "x.png", false).await.status, 403, "readers cannot move");
    assert_eq!(mv(&stranger, "figures/orbit.png", "x.png", false).await.status, 404, "strangers cannot probe");
    assert_eq!(srv.post(&format!("{base}/asset-moves"), None, json!({ "from": "a.png", "to": "b.png" })).await.status, 401);

    // rename into another table: bytes follow, the old name is gone, everyone sees it live
    let moved = mv(&scribe, "figures/orbit.png", "appendix/orbit-final.png", false).await;
    assert_eq!(moved.status, 200, "{}", moved.json);
    assert_eq!(moved.json["path"].as_str(), Some("appendix/orbit-final.png"));
    watcher.eventually_assets(&["appendix/orbit-final.png"]).await;
    assert_eq!(srv.get(&format!("{base}/assets/appendix/orbit-final.png"), Some(&reader)).await.bytes, png());
    assert_eq!(srv.get(&format!("{base}/assets/figures/orbit.png"), Some(&reader)).await.status, 404);

    // a copy keeps the original; both are listed
    assert_eq!(mv(&owner, "appendix/orbit-final.png", "appendix/orbit-copy.png", true).await.status, 200);
    watcher.eventually_assets(&["appendix/orbit-copy.png", "appendix/orbit-final.png"]).await;
    assert_eq!(srv.get(&format!("{base}/assets/appendix/orbit-copy.png"), Some(&owner)).await.bytes, png());
    let listed = srv.get(&format!("{base}/assets"), Some(&reader)).await.json;
    assert_eq!(listed.as_array().unwrap().len(), 2);

    // refusals: taken names, text clashes, type changes, bad paths, missing sources
    assert_eq!(mv(&owner, "appendix/orbit-copy.png", "appendix/orbit-final.png", false).await.status, 409, "name taken");
    assert_eq!(mv(&owner, "appendix/orbit-copy.png", "appendix/orbit-copy.jpg", false).await.status, 400, "type cannot change");
    assert_eq!(mv(&owner, "appendix/orbit-copy.png", "../escape.png", false).await.status, 400, "traversal");
    assert_eq!(mv(&owner, "nothing.png", "somewhere.png", false).await.status, 404);
    let c = connect(&srv, id, &owner).await;
    c.write_file("notes.png", "this is text");
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(mv(&owner, "appendix/orbit-copy.png", "notes.png", false).await.status, 409, "text file owns that name");
    // nothing was lost by the refusals
    assert_eq!(srv.get(&format!("{base}/assets/appendix/orbit-copy.png"), Some(&owner)).await.bytes, png());
    // moving onto itself is a harmless no-op
    assert_eq!(mv(&owner, "appendix/orbit-copy.png", "appendix/orbit-copy.png", false).await.status, 200);
}

#[tokio::test]
async fn copies_count_against_the_scroll_quota() {
    let srv = start_server().await; // 4 MB per scroll, 1 MB per file
    let (owner, _, _, _, id) = team(&srv).await;
    let base = format!("/api/scrolls/{id}");
    let mut one_mb = png();
    one_mb.resize(1024 * 1024 - 8, 0);
    for i in 0..4 {
        assert_eq!(srv.raw(reqwest::Method::PUT, &format!("{base}/assets/p{i}.png"), Some(&owner), one_mb.clone()).await.status, 200);
    }
    let copy = srv.post(&format!("{base}/asset-moves"), Some(&owner), json!({ "from": "p0.png", "to": "p0-copy.png", "copy": true })).await;
    assert_eq!(copy.status, 413, "a copy would exceed the quota");
    // a move needs no extra space
    assert_eq!(srv.post(&format!("{base}/asset-moves"), Some(&owner), json!({ "from": "p0.png", "to": "q0.png" })).await.status, 200);
}

#[tokio::test]
async fn asset_uploads_are_validated() {
    let srv = start_server().await; // limits in test config: 1 MB per file, 4 MB per scroll
    let (owner, _, _, _, id) = team(&srv).await;
    let put = |path: &str, body: Vec<u8>| srv.raw(reqwest::Method::PUT, &format!("/api/scrolls/{id}/assets/{path}"), Some(&owner), body);

    assert_eq!(put("run.exe", png()).await.status, 400, "unsupported type");
    assert_eq!(put("noextension", png()).await.status, 400);
    assert_eq!(put("figures/..%2Fx.png", png()).await.status, 400, "path traversal");
    assert_eq!(put("pic.png", b"MZ not really a png".to_vec()).await.status, 400, "content must match the type");
    assert_eq!(put("empty.png", vec![]).await.status, 400);
    let mut huge = png();
    huge.resize(1024 * 1024 + 1, 0);
    assert_eq!(put("huge.png", huge).await.status, 413, "over the per-file limit");

    // per-scroll quota (4 MB): four ~1 MB files fit, the next does not; replacing one still works
    let mut one_mb = png();
    one_mb.resize(1024 * 1024 - 8, 0);
    for i in 0..3 {
        assert_eq!(put(&format!("big{i}.png"), one_mb.clone()).await.status, 200);
    }
    assert_eq!(put("big3.png", one_mb.clone()).await.status, 200);
    assert_eq!(put("big4.png", one_mb.clone()).await.status, 413, "quota exhausted");
    assert_eq!(put("big0.png", one_mb.clone()).await.status, 200, "replacing a file does not double-count it");

    // a text file and an asset cannot share a name
    let c = connect(&srv, id, &owner).await;
    c.write_file("notes.png", "this is text");
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(put("notes.png", png()).await.status, 409);
}

#[tokio::test]
async fn compile_sees_uploaded_assets() {
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;
    let id = srv.new_scroll(&u, "With image").await;
    let c = connect(&srv, id, &u).await;
    c.write_file("main.tex", "\\includegraphics{figures/orbit} NEEDS_IMAGE");
    tokio::time::sleep(Duration::from_millis(200)).await;

    let compile = || srv.post(&format!("/api/rooms/{id}/compile"), Some(&u), json!({}));
    let before = compile().await;
    assert_eq!(before.json["ok"], false);
    assert!(before.json["diagnostics"][0]["message"].as_str().unwrap().contains("missing figures/orbit.png"));

    assert_eq!(srv.raw(reqwest::Method::PUT, &format!("/api/scrolls/{id}/assets/figures/orbit.png"), Some(&u), png()).await.status, 200);
    assert_eq!(compile().await.json["ok"], true, "the uploaded image is copied next to the sources");
}

// ---------------------------------------------------------------------------------------------
// version history
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn named_versions_can_be_listed_read_and_restored() {
    let srv = start_server().await;
    let (owner, scribe, reader, stranger, id) = team(&srv).await;
    let live = connect(&srv, id, &scribe).await;
    live.write_file("main.tex", "version one");
    live.write_file("old.tex", "to be removed later");
    tokio::time::sleep(Duration::from_millis(250)).await;

    let base = format!("/api/scrolls/{id}/versions");
    assert_eq!(srv.post(&base, Some(&reader), json!({"label": "nope"})).await.status, 403, "readers cannot save versions");
    assert_eq!(srv.post(&base, Some(&stranger), json!({})).await.status, 404);
    let v1 = srv.post(&base, Some(&scribe), json!({"label": "  Draft 1  "})).await;
    assert_eq!(v1.status, 201, "{}", v1.json);
    assert_eq!((v1.json["label"].as_str(), v1.json["auto"].as_bool(), v1.json["authorName"].as_str()), (Some("Draft 1"), Some(false), Some("Scribe")));
    let v1_id = v1.json["id"].as_str().unwrap().to_string();
    assert_eq!(srv.post(&base, Some(&scribe), json!({"label": "x".repeat(81)})).await.status, 400);

    // the document moves on
    live.append("main.tex", " + more words");
    live.write_file("new.tex", "added later");
    tokio::time::sleep(Duration::from_millis(250)).await;

    // everyone at the table can browse history and read an old version's files
    let list = srv.get(&base, Some(&reader)).await.json;
    assert_eq!(list.as_array().unwrap().iter().filter(|v| v["label"] == "Draft 1").count(), 1);
    let detail = srv.get(&format!("{base}/{v1_id}"), Some(&reader)).await.json;
    assert_eq!(detail["files"]["main.tex"], "version one");
    assert!(detail["files"].get("new.tex").is_none());
    assert_eq!(srv.get(&format!("{base}/{v1_id}"), Some(&stranger)).await.status, 404);

    // the author's id travels with the version, so a client can filter "mine"
    assert!(v1.json["authorId"].as_str().is_some());
    // naming an existing snapshot: writers only, keeps it, validates the name
    let named = srv.send(reqwest::Method::PATCH, &format!("{base}/{v1_id}"), &scribe, Some(json!({"label": "  Draft 1 (reviewed) "}))).await;
    assert_eq!((named.status, named.json["label"].as_str(), named.json["auto"].as_bool()), (200, Some("Draft 1 (reviewed)"), Some(false)), "{}", named.json);
    assert_eq!(srv.send(reqwest::Method::PATCH, &format!("{base}/{v1_id}"), &reader, Some(json!({"label": "x"}))).await.status, 403);
    assert_eq!(srv.send(reqwest::Method::PATCH, &format!("{base}/{v1_id}"), &stranger, Some(json!({"label": "x"}))).await.status, 404);
    assert_eq!(srv.send(reqwest::Method::PATCH, &format!("{base}/{v1_id}"), &scribe, Some(json!({"label": "   "}))).await.status, 400);
    assert_eq!(srv.send(reqwest::Method::PATCH, &format!("{base}/{v1_id}"), &scribe, Some(json!({"label": "x".repeat(81)}))).await.status, 400);
    assert_eq!(srv.send(reqwest::Method::PATCH, &format!("{base}/{}", Uuid::new_v4()), &scribe, Some(json!({"label": "x"}))).await.status, 404);
    assert_eq!(srv.send(reqwest::Method::PATCH, &format!("{base}/{v1_id}"), &scribe, Some(json!({"label": "Draft 1"}))).await.status, 200);

    // restoring is for writers; it edits the live document, so connected scribes see it at once
    assert_eq!(srv.post(&format!("{base}/{v1_id}/restore"), Some(&reader), json!({})).await.status, 403);
    assert_eq!(srv.post(&format!("{base}/{v1_id}/restore"), Some(&scribe), json!({})).await.status, 204);
    live.eventually("main.tex", "version one").await;
    for _ in 0..100 {
        if live.read_file("new.tex").is_none() && live.read_file("old.tex").as_deref() == Some("to be removed later") { break; }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    assert_eq!(live.read_file("new.tex"), None, "files added later are removed");
    assert_eq!(live.read_file("old.tex").as_deref(), Some("to be removed later"));

    // restoring kept the present as a version, so it can be undone
    let after = srv.get(&base, Some(&owner)).await.json;
    let safety = after.as_array().unwrap().iter().find(|v| v["label"] == "Before restoring an earlier version").expect("a safety version");
    let undo = srv.get(&format!("{base}/{}", safety["id"].as_str().unwrap()), Some(&owner)).await.json;
    assert_eq!(undo["files"]["main.tex"], "version one + more words");
    assert_eq!(undo["files"]["new.tex"], "added later");

    // deleting versions is the owner's call; unknown ids are 404
    assert_eq!(srv.send(reqwest::Method::DELETE, &format!("{base}/{v1_id}"), &scribe, None).await.status, 403);
    assert_eq!(srv.send(reqwest::Method::DELETE, &format!("{base}/{v1_id}"), &owner, None).await.status, 204);
    assert_eq!(srv.get(&format!("{base}/{v1_id}"), Some(&owner)).await.status, 404);
    assert_eq!(srv.post(&format!("{base}/{}/restore", Uuid::new_v4()), Some(&owner), json!({})).await.status, 404);
}

#[tokio::test]
async fn a_version_of_another_scroll_cannot_be_restored_here() {
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;
    let (a, b) = (srv.new_scroll(&u, "A").await, srv.new_scroll(&u, "B").await);
    let ca = connect(&srv, a, &u).await;
    ca.write_file("main.tex", "secret of A");
    tokio::time::sleep(Duration::from_millis(250)).await;
    let va = srv.post(&format!("/api/scrolls/{a}/versions"), Some(&u), json!({})).await.json["id"].as_str().unwrap().to_string();
    assert_eq!(srv.post(&format!("/api/scrolls/{b}/versions/{va}/restore"), Some(&u), json!({})).await.status, 404);
    assert_eq!(srv.get(&format!("/api/scrolls/{b}/versions/{va}"), Some(&u)).await.status, 404);
}

#[tokio::test]
async fn automatic_versions_follow_changes_not_idleness() {
    let srv = start_server_with(|c| {
        c.version_interval = Duration::from_millis(200);
        c.persist_debounce = Duration::from_millis(50);
    })
    .await;
    let u = srv.new_user("Aelith").await;
    let id = srv.new_scroll(&u, "Auto").await;
    let c = connect(&srv, id, &u).await;
    let count = || async { srv.get(&format!("/api/scrolls/{id}/versions"), Some(&u)).await.json.as_array().unwrap().len() };

    c.write_file("main.tex", "first");
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(count().await, 1, "the first save is snapshotted");
    let first = srv.get(&format!("/api/scrolls/{id}/versions"), Some(&u)).await.json;
    assert_eq!((first[0]["auto"].as_bool(), first[0]["authorName"].is_null()), (Some(true), true));

    tokio::time::sleep(Duration::from_millis(500)).await; // idle: nothing changes, nothing is added
    assert_eq!(count().await, 1);

    c.append("main.tex", " second");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(count().await, 2, "a change after the interval is snapshotted");
}

// ---------------------------------------------------------------------------------------------
// document storage
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn documents_live_in_postgres_and_old_filesystem_documents_are_imported() {
    let srv = start_server().await;
    let u = srv.new_user("Aelith").await;
    let id = srv.new_scroll(&u, "Stored").await;
    let c = connect(&srv, id, &u).await;
    c.write_file("main.tex", "in the database");
    tokio::time::sleep(Duration::from_millis(250)).await;
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM scroll_docs WHERE scroll_id = $1").bind(id).fetch_one(&srv.db).await.unwrap();
    assert_eq!(rows, 1);

    // a scroll saved by the previous (filesystem) version of the server
    let legacy = srv.new_scroll(&u, "Legacy").await;
    let doc = Doc::new();
    {
        let files = doc.get_or_insert_map("files");
        let mut txn = doc.transact_mut();
        files.insert(&mut txn, "main.tex", TextPrelim::new("from the old store"));
    }
    let bytes = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
    std::fs::create_dir_all(srv.data.join("docs")).unwrap();
    std::fs::write(srv.data.join("docs").join(format!("{legacy}.ydoc")), bytes).unwrap();
    std::fs::write(srv.data.join("docs").join(format!("{}.ydoc", Uuid::new_v4())), b"orphan").unwrap(); // no such scroll: skipped

    assert_eq!(srv.state.rooms.import_fs_docs().await.unwrap(), 1);
    assert_eq!(srv.state.rooms.import_fs_docs().await.unwrap(), 0, "imports happen once");
    let l = connect(&srv, legacy, &u).await;
    l.eventually("main.tex", "from the old store").await;
}

// ---------------------------------------------------------------------------------------------
// real SMTP delivery
// ---------------------------------------------------------------------------------------------

/// A tiny SMTP server that accepts one message and hands back its raw text.
async fn fake_smtp() -> (u16, tokio::sync::oneshot::Receiver<String>) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (sock, _) = listener.accept().await.unwrap();
        let (r, mut w) = sock.into_split();
        let mut r = BufReader::new(r);
        w.write_all(b"220 fake.smtp ESMTP\r\n").await.unwrap();
        let (mut in_data, mut data, mut line) = (false, String::new(), String::new());
        loop {
            line.clear();
            if r.read_line(&mut line).await.unwrap() == 0 { break; }
            if in_data {
                if line == ".\r\n" {
                    in_data = false;
                    w.write_all(b"250 queued\r\n").await.unwrap();
                } else {
                    data.push_str(&line);
                }
                continue;
            }
            let cmd = line.trim_end().to_uppercase();
            if cmd.starts_with("EHLO") { w.write_all(b"250-fake.smtp\r\n250 8BITMIME\r\n").await.unwrap(); }
            else if cmd.starts_with("HELO") || cmd.starts_with("MAIL") || cmd.starts_with("RCPT") || cmd.starts_with("RSET") { w.write_all(b"250 ok\r\n").await.unwrap(); }
            else if cmd == "DATA" { in_data = true; w.write_all(b"354 go ahead\r\n").await.unwrap(); }
            else if cmd == "QUIT" { w.write_all(b"221 bye\r\n").await.unwrap(); break; }
            else { w.write_all(b"250 ok\r\n").await.unwrap(); }
        }
        let _ = tx.send(data);
    });
    (port, rx)
}

#[tokio::test]
async fn mail_is_delivered_over_smtp_when_configured() {
    let (port, received) = fake_smtp().await;
    let srv = start_server_with(|c| {
        c.smtp_url = Some(format!("smtp://127.0.0.1:{port}"));
        c.mail_from = "The Gilded Quill <quill@guild.test>".into();
    })
    .await;
    let u = srv.new_user("Aelith").await; // signup sends a confirmation mail
    let raw = tokio::time::timeout(Duration::from_secs(10), received).await.expect("SMTP server got a message").unwrap();

    assert!(raw.contains("To: ") && raw.contains(&u.email), "{raw}");
    assert!(raw.contains("From: ") && raw.contains("quill@guild.test"));
    assert!(raw.contains("Subject: Confirm your email"));
    assert!(raw.contains("/verify-email?token="), "the link made it through the wire");
    assert!(srv.mails_to(&u.email).is_empty(), "with SMTP configured nothing is parked in the outbox");
}
