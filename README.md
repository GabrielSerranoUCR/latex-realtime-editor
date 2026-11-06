# The Gilded Quill

**Real-time collaborative LaTeX, in a tavern.** Several people edit the same document at once, see each other's
cursors, and compile to PDF on the server. Open source (MIT), self-hosted, and runs anywhere Docker does.

Documents are called **scrolls**, the people editing them **scribes**, and a scroll's files are *members* seated at
*tables* (folders) in the **Tavern Hall**. The compile output is the **Ink Log**.

```
Angular app ──WebSocket (y-sync, binary CRDT updates)──▶ Axum server ──▶ Yrs room (in memory) ─▶ PostgreSQL
     │                                                        │
     └──HTTP /api/rooms/{room}/compile ──────────────────────▶ worker pool ─▶ Tectonic ─▶ PDF (shared with everyone)
```

- **Frontend:** Angular (zoneless) · Yjs · CodeMirror 6 · RxJS
- **Backend:** Rust · Axum · Yrs · sqlx + PostgreSQL · [Tectonic](https://tectonic-typesetting.github.io) (a XeTeX engine)
- **AI access:** an [MCP server](mcp/README.md) (`quill-mcp`) so an AI assistant can work on scrolls

## Features

**Writing together**
- Live co-editing with remote cursors, selections and presence (CRDT: edits merge, offline edits too).
- LaTeX-aware editor: autocomplete for commands, environments, packages, `\ref` labels, `\cite` keys from `.bib` files,
  and `\input` / `\includegraphics` paths; Word-style shortcuts (⌘B bold, ⌘I italic, …); search and replace across every
  file (⌘F), with regex and whole-word options.
- Margin notes: threaded comments anchored to text, `@mentions`, resolve / reopen.
- Command menu (⌘K), a menu bar, an onboarding tour, three colour themes, resizable and pop-out panels.

**Compiling**
- One click (⌘/Ctrl+Enter) or auto-compile; the PDF preview follows the latest build for everyone at the table.
- **Double-click the PDF preview** to put the caret on the source line that produced that spot (SyncTeX; works from the
  pop-out preview too). The preview is drawn with pdf.js, with zoom and fit-to-width.
- The Ink Log lists errors and warnings by file and line; click one to jump to it.
- Compiles run in a bounded worker pool with a timeout (the Tectonic CLI, one process per compile).

**Files, pictures and the Tavern Hall**
- Files and folders; a map view (round tables, pan and zoom) and a list view; drag to move, rename, duplicate.
  Moving or renaming a file rewrites the references to it (`\includegraphics`, `\input`, `\bibliography`, …).
- Pictures and PDFs (upload, drop on the editor, "Insert image" dialog, a gallery with "used in").
- Import a `.zip` as a new scroll or into an existing one; export a scroll as `.zip`.

**History and recording**
- Version history: automatic snapshots plus named ones, a diff view, restore (the present is saved first).
- Session recording: a timelapse of the text changes (kept in your browser, exportable as `.quillsession`).

**Accounts and sharing**
- Email + password (Argon2id), magic-link sign-in, email verification, password reset, per-account lockout and per-IP rate limits.
- Roles per scroll: **owner**, **scribe** (edit + compile), **reader**. Enforced on the server.
- Invite by email (works for people without an account), share links for edit or view, access requests for private scrolls.
- Profile, active sessions (sign out any device), account deletion.

**AI assistants (MCP)**
- A personal access token (Profile → Security) lets an MCP client (Claude Code, Codex, Antigravity, Claude Desktop, …)
  read, search, edit, compile, and leave margin notes, with your own access and no more.
- Each scroll holds an assistant's edits **for review** by default: you accept or reject each change in a side-by-side
  diff. Only the owner, from a signed-in browser, can let them apply automatically.
- While an assistant is working it appears at the table with its logo; the MCP client announces its own name on its first request.

| Role | Read & live edits | Edit | Compile | Download PDF | Manage members, rename, delete |
|---|:-:|:-:|:-:|:-:|:-:|
| owner  | ✓ | ✓ | ✓ | ✓ | ✓ |
| scribe | ✓ | ✓ | ✓ | ✓ |   |
| reader | ✓ |   |   | ✓ |   |

Non-members get `404` (not `403`), so scroll ids cannot be probed. A reader's document updates are discarded by the server.

## Quick start (development)

You need: **Rust** (stable), **Node 22+**, **Docker** (for PostgreSQL) and **Tectonic** (`brew install tectonic`, or see its docs).

```bash
npm run db:up            # PostgreSQL on localhost:5434 (own container, `quill-db`)
npm run dev:backend      # http://localhost:8080 (migrations run on start)
npm run dev:frontend     # http://localhost:4200 (proxies /api and /ws to :8080)
```

The server reads real environment variables only; it does **not** load a `.env` file. To use one:
`set -a; source backend/.env; set +a; npm run dev:backend` (see [`backend/.env.example`](backend/.env.example)).

Open <http://localhost:4200>, sign up, create a scroll, and invite a second account in another browser profile. In
development, emails (verification, invitations) are written to `data/outbox/` instead of being sent. The first compile on a
cold machine downloads Tectonic's TeX bundle (the server warms this at start).

## Hosting (any provider)

Nothing here is tied to a cloud. You need **a machine that runs Docker** (a VPS, a home server, a cloud VM, Kubernetes if
you convert the compose file) and a **domain name**.

### What is needed

| Need | Details |
|---|---|
| **Docker + Compose v2** | The reference setup is [`deploy/docker-compose.yml`](deploy/docker-compose.yml): `db` (PostgreSQL 16), `backend` (Rust + Tectonic), `frontend` (nginx serving the app and passing `/api` and `/ws` to the backend). |
| **HTTPS reverse proxy** | Any (Caddy, Traefik, nginx, a cloud load balancer, Coolify's proxy…). It terminates TLS and forwards to the `frontend` service on port 8080. It **must forward WebSocket upgrades** and allow long-lived connections. One domain serves everything. |
| **PostgreSQL 16** | Holds accounts, sessions, scrolls, the Yjs documents and version history. The compose file runs one; you can point `QUILL_DATABASE_URL` at a managed database instead. |
| **Persistent storage** | Volume `quill-data` (`/data`: pictures, PDFs) and `db-data` (PostgreSQL). `tectonic-cache` just saves re-downloading TeX files. |
| **Outbound internet for the backend** | Tectonic downloads TeX support files on first use (a pre-warmed `tectonic-cache` volume lets it run offline). |
| **SMTP (optional, recommended)** | For invitations, verification, password reset and magic links. Without it, mails are only written to `/data/outbox` and logged. |
| **Resources** | A small VPS (1–2 vCPU, 2 GB RAM) serves a few people; each concurrent compile uses CPU and memory (`QUILL_COMPILE_WORKERS`, default 2). |

### Option A: build on the server (simplest, no registry)

```bash
git clone https://github.com/GabrielSerranoUCR/the-gilded-quill.git && cd the-gilded-quill/deploy
cp .env.example .env     # set POSTGRES_PASSWORD (long, random) and QUILL_ALLOWED_ORIGIN (https://your.domain); IMAGE_REPO=quill
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

This publishes the frontend on `127.0.0.1:8080` only. Point your HTTPS reverse proxy at it. With Caddy, for example:

```
quill.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

(Caddy forwards WebSockets automatically; with nginx add `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`.)

### Option B: pre-built images from a registry

Build and push the two images (`backend/`, `frontend/`) to any registry (this repository's CI does it for GitHub's `ghcr.io`),
set `IMAGE_REPO` / `IMAGE_TAG`, and run `docker compose up -d` with `deploy/docker-compose.yml`. The sample pipeline
([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) also redeploys on Coolify; see [`deploy/README.md`](deploy/README.md)
for that specific setup. Adapt or remove it for your own platform.

### Without Docker

Build `backend` (`cargo build --release`) and `frontend` (`npm run build`, output `frontend/dist/frontend/browser`), install
Tectonic, run PostgreSQL, serve the frontend files from any web server, and proxy `/api/` and `/ws/` to the backend
(use [`frontend/nginx.conf.template`](frontend/nginx.conf.template) as the reference).

### Configuration

All settings are environment variables on the backend (defaults in [`backend/.env.example`](backend/.env.example)):

| Variable | Default | Meaning |
|---|---|---|
| `QUILL_DATABASE_URL` | local dev DB | PostgreSQL connection URL |
| `QUILL_ALLOWED_ORIGIN` | `http://localhost:4200` | **The public address** (`https://…`, no trailing slash). Writes and WebSocket upgrades from any other `Origin` are rejected. |
| `QUILL_PUBLIC_URL` | = allowed origin | Where links in emails point |
| `QUILL_COOKIE_SECURE` | `false` | **Set `true` behind HTTPS** (the compose file does) |
| `QUILL_TRUST_PROXY` | `false` | `true` only behind a proxy you control (reads `X-Forwarded-For` for rate limits) |
| `QUILL_SMTP_URL` / `QUILL_MAIL_FROM` | unset / noreply | Mail delivery, e.g. `smtps://user:pass@smtp.example.com:465` |
| `QUILL_DATA_DIR` | `./data` | Pictures, PDFs, outbox |
| `QUILL_TECTONIC_BIN` | `tectonic` | Path to the Tectonic CLI |
| `QUILL_COMPILE_WORKERS` / `QUILL_COMPILE_TIMEOUT_SECS` | `2` / `60` | Concurrent compiles and the limit for each |
| `QUILL_SESSION_DAYS` | `30` | How long a sign-in lasts |
| `QUILL_LOGIN_FAILURES_MAX`, `QUILL_LOGIN_WINDOW_MINUTES`, `QUILL_IP_AUTH_MAX` | `5`, `15`, `60` | Login lockout and per-IP auth limits |
| `QUILL_MAX_ASSET_MB` / `QUILL_ASSET_QUOTA_MB` | `25` / `200` | Per picture and per scroll |
| `QUILL_VERSION_INTERVAL_MINUTES` | `10` | Minimum gap between automatic version snapshots |
| `QUILL_PORT`, `RUST_LOG` | `8080`, info | Listen port and log level |

### Operating it

- **Updating:** pull the new code (or images) and redeploy. Database migrations run automatically when the backend starts.
- **Backups:** back up the PostgreSQL volume (`pg_dump`) and `quill-data`.
- **One backend instance only.** Live editing rooms are held in the backend's memory; there is no Redis pub/sub yet, so
  do not run several backend replicas behind one load balancer.
- **Health check:** `GET /healthz`.
- **Sign-up is open:** anyone who can reach the site can create an account. If it is for a private group, put the site behind
  a VPN, an authenticating proxy, or an IP allowlist.

## Security notes

- Run behind HTTPS, with `QUILL_COOKIE_SECURE=true` and `QUILL_ALLOWED_ORIGIN` set to the real origin (the compose file does).
- Sessions are opaque random tokens in an HttpOnly `SameSite=Lax` cookie; only their SHA-256 hash is stored. Access tokens
  (MCP) are shown once and stored hashed; they can be read-only, expire, and be revoked, and can never accept their own edits.
- **LaTeX is code.** The Docker setup runs the backend as an unprivileged user with a compile timeout, but if you expose the
  site to people you do not trust, also run it with no access to your internal network and with CPU / memory limits.
- Known gaps: no two-factor authentication; presence is server-stamped but margin-note author names are written by the
  author's browser.

## Tests

```bash
npm run db:up            # tests need PostgreSQL (they use their own `quill_test` database)
npm run test:backend     # unit + end-to-end tests (real server, real DB, real Yjs clients)
npm run test:frontend    # Angular/Vitest (set QUILL_WS=ws://localhost:8080 with a running backend for the live provider tests)
npm --prefix mcp test    # MCP helpers
# full-stack smoke test in a real browser (needs Chrome, a running backend with Tectonic, and `ng serve`):
npm --prefix e2e install && npm run test:e2e
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the backend tests with a real PostgreSQL, the frontend tests and
build, the MCP tests, and builds both images on every pull request.

## Document model

One Yjs document per scroll:

| Root type | Shape | Meaning |
|---|---|---|
| `files` | `Y.Map<Y.Text>` | project path → file contents |
| `meta` | `Y.Map` | `main` (entry file), `lastBuild`, pending AI edits, assistants at work |
| `tables`, `layout` | `Y.Map` | empty folders; positions of tables on the Tavern Hall map |
| `comments` | `Y.Map` | margin-note threads |

The server reads this same structure to compile, so what is on screen is what gets built.

## Project layout

```
backend/    Rust server (axum, yrs, sqlx), migrations, Dockerfile (bundles Tectonic)
frontend/   Angular app, nginx config, Dockerfile
mcp/        quill-mcp: MCP server for AI assistants (npm package)
deploy/     docker-compose for production, Coolify notes
e2e/        browser smoke test
```

## Contributing

Issues and pull requests are welcome. Please run the tests above before opening one. Work on a branch and open a pull
request against `main`.

## License

MIT, see [LICENSE](LICENSE).
