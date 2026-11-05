# The Gilded Quill — real-time collaborative LaTeX

Write LaTeX together, live, and compile it on the server. Angular + Yjs on the client,
Rust (Axum + Yrs + Tectonic) on the server. UI design (Figma, tavern theme) lives in the
`LatexCollaborative` Figma folder.

```
Angular app ──WebSocket (y-sync, binary CRDT updates)──▶ Axum ──▶ Yrs room (in-memory doc)
     │                                                     │            └─ debounced snapshots ▶ data/docs/*.ydoc
     └──HTTP POST /api/rooms/{room}/compile ─────────────▶ worker pool ─▶ Tectonic ▶ data/pdfs/{room}/latest.pdf
```

## Run it

Prerequisites: Rust (stable), Node 22+, Docker (for PostgreSQL) and
[Tectonic](https://tectonic-typesetting.github.io) (`brew install tectonic`).

```bash
npm run db:up            # PostgreSQL on localhost:5434 (its own container, `quill-db`)
npm run dev:backend      # http://localhost:8080  (migrations run on start; see backend/.env.example)
# The server reads real environment variables only; it does NOT load a .env file by itself. To use one:
#   set -a; source backend/.env; set +a; npm run dev:backend
npm run dev:frontend     # http://localhost:4200  (proxies /api and /ws to :8080)
```

Open <http://localhost:4200>, sign up, create a scroll and invite a second account (Share →
email → role) in another browser profile. Edits, cursors and presence sync live; **Compile**
(or ⌘/Ctrl+Enter) builds the PDF, and every scribe's preview follows the latest build. The first compile on a cold machine downloads
Tectonic's TeX bundle; the server warms that cache at startup so users don't pay for it.

## Tests

```bash
npm run db:up            # tests need PostgreSQL (they use a separate `quill_test` database)
npm run test:backend     # unit + end-to-end tests (real server, real DB, real Yjs clients)
npm run dev:backend &    # in another shell, for the live provider tests below
QUILL_WS=ws://localhost:8080 npm run test:frontend
# full-stack smoke test in a real browser (needs Chrome, the backend with Tectonic, and `ng serve`):
npm --prefix e2e install && npm run test:e2e
```

## Document model

One Yjs document per room (= scroll):

| Root type | Shape | Meaning |
|---|---|---|
| `files` | `Y.Map<Y.Text>` | project path → file contents |
| `meta`  | `Y.Map`         | `main` = entry file (default `main.tex`) |

The server reads this same structure to compile, so what is on screen is what gets built.

## Where this differs from the original architecture sketch

| Sketch | Built | Why / next step |
|---|---|---|
| Tectonic *engine* inside the worker pool | Tectonic **CLI** per compile, bounded by a semaphore, killed on timeout | Keeps untrusted TeX out of the server process and lets it be sandboxed. Embedding the crate is possible later. |
| PostgreSQL / Redis document state | Filesystem snapshots (`FsStore`) | One struct is the seam; swap for Postgres (snapshots/updates) and Redis (pub/sub for multiple server instances). |
| Object storage for PDFs | Local `data/pdfs` | Same seam. |
| PostgreSQL document state | PostgreSQL holds **accounts, sessions, scrolls and memberships**; the Yjs document itself is still a filesystem snapshot | Next: store snapshots/updates in Postgres (and Redis pub/sub so several server instances can share rooms). |
| Session authentication | Email + password (Argon2id), opaque session tokens in an HttpOnly `SameSite=Lax` cookie (only a SHA-256 hash is stored), owner / scribe / reader roles | See *Security notes* for what is still missing. |
| CodeMirror 6 / Monaco | CodeMirror 6 + `y-codemirror.next` | Remote cursors and selections come for free. |

## Accounts and permissions

| Role | Read & get live edits | Edit | Compile | Download PDF | Manage members / rename / delete |
|---|:-:|:-:|:-:|:-:|:-:|
| owner  | ✓ | ✓ | ✓ | ✓ | ✓ |
| scribe | ✓ | ✓ | ✓ | ✓ |   |
| reader | ✓ |   |   | ✓ |   |

Enforced **on the server**: a reader's document updates are discarded (the UI is read-only too, but
that is only courtesy), non-members get `404` (not `403`) so scroll ids cannot be probed, and
the WebSocket is authenticated by the session cookie.

## Security notes

* **Not yet built:** login rate-limiting / lockout, email verification and password reset,
  and a way to invite people who have no account yet (today you can only add existing accounts, which
  also reveals whether an email is registered). Presence names are client-supplied, so a
  scribe could impersonate another's cursor label.
* Run behind HTTPS and set `QUILL_COOKIE_SECURE=true`; set `QUILL_ALLOWED_ORIGIN` to your real origin.
  State-changing requests and WebSocket upgrades are rejected when their `Origin` differs.
* LaTeX is code. Run the compile worker in a container/sandbox with no network and CPU/memory
  limits before exposing this to untrusted users. The server already validates room ids and
  project paths, and enforces a compile timeout.

## What's implemented vs. designed

Implemented: accounts (sign up / sign in / sign out), the quest board (create, list, delete scrolls),
sharing with roles, read-only readers, the "lost in the cellar" 404, collaborative editor
(files, presence, offline merge), compile + PDF preview shared by everyone at the table,
ink log with clickable errors, offline banner/status, tavern theme tokens, LaTeX autocomplete
(single-argument commands insert `\cmd{}` with the caret inside; commands with several arguments insert their whole template, e.g. `\frac{num}{den}`; `\begin` and `\end` take a staged flow and environments close in a second Tab with a template; packages, project-wide `\ref` labels,
`\cite` keys from `.bib` files, `\input`/`\includegraphics` paths — see `frontend/src/app/core/latex`).
Designed in Figma but not yet built: the command palette and the onboarding tour (plus the parts of profile and settings listed below).

## Status of the "not built yet" list

**Backend (done, 57 tests):** login lockout and per-IP rate limits, email verification, password reset,
email invitations that work for people without accounts (bound to a *verified* address), server-stamped
presence names, profile / change-password / sessions / account deletion, Yjs documents in PostgreSQL
(old filesystem documents are imported), binary assets (images/PDFs) shared live and copied into
compiles (renamed, moved to another table or duplicated in one server call, `POST /api/scrolls/{id}/asset-moves`), version history (automatic + named snapshots, restore), and real SMTP delivery.
**Frontend (done):** forgot/reset/verify pages, verification banner, invitation page, pending invitations
on the quest board, share dialog using email invitations, images and PDFs (upload button and drop zone
in the Tavern Hall side panel, live list for everyone, Portrait Gallery panel with download / replace /
remove, and the "Hang a Portrait in Your Scroll" dialog that inserts a `figure` at the cursor).
**Profile** (your avatar in the editor header, the dashboard or the hall): *Profile* tab — display name,
a guild/affiliation line, cursor colour (the five the server offers), "Show my cursor to other scribes" and
"Appear as present at the table" (off makes you invisible to the others, though you still see them), sign
out. *Security* tab — change password (with a strength guide; other devices are signed out), "email me a
reset link", active sessions named by browser ("Safari on macOS") with sign-out for each, and *Delete my
account* (type your email and password; scrolls with other scribes pass to the next scribe). *Notifications*
tab — what the tavern tells you while you work: margin notes and @mentions as toasts, desktop notifications
when the tab is hidden (the browser's permission is asked for), a bell, scribes joining/leaving, and quiet
hours that silence all of it. Names and colours you change show up for everyone at the table at once (the
server re-reads them for each presence message). **Settings** (the *Settings* button in the editor) —
*Compiler*: the main document (shared; scribes and the owner may change it), auto-compile a couple of
seconds after you stop typing, show warnings in the ink log; *Editor*: font, size, line height, line numbers,
wrapping, auto-close brackets, browser spell-check, with a live sample; *Collaboration*: show others' cursors
and name flags. Everything except the main document is kept in this browser (`localStorage`), for you only.
Not built, because nothing behind it exists: change portrait (avatar upload), interface language, two-factor
authentication, the by-email notification group, TeX engines other than Tectonic, compile timeout / draft
mode, vim and emacs keybindings, a second editor colour theme, and the permission settings (default role,
share-link expiry, "only the owner can compile") that would need server enforcement.
**Margin notes** (the *Notes* button, or Ctrl/⌘+Alt+M): select some text, or just put the caret on a line,
and write a note about it. Notes are threads: reply, `@mention` a scribe (suggestions as you type; your own
mentions are highlighted), resolve and reopen, delete your own messages (the starter or the owner can delete
a whole thread). The text a note is about is highlighted and marked in the gutter, and the note stays on its
words as people type around it (the anchors are Yjs relative positions); if the words are deleted the note
says so and keeps its quote. Notes live in the scroll's shared document (`comments`), so they appear for
everyone instantly, work offline like any edit, and persist with the scroll. Limits: readers can read notes
but not write them (the server discards readers' document updates), an author's name is whatever that
scribe's browser wrote (like any edit, it is not server-verified), there are no notifications for
mentions yet, and restoring an old version leaves notes alone (an anchor may then say its text is gone).
**Pictures and references.** Drop a picture (or several) on the editor, or drag one out of the Tavern Hall list
into it, and *Hang a Portrait in Your Scroll* always opens first, with that picture chosen and the drop point as
the place: nothing is inserted until you say how. Several pictures are asked about one after the other; anything
that is not a picture says what can be dropped; readers are told they cannot. In the Tavern Hall, dragging a
member to another table *moves* it (the same file, one server call; it is never uploaded again), and moving or
renaming a file there also rewrites what points at it: `\includegraphics`, `\input`, `\include`, `\subfile`,
`\bibliography`, `\addbibresource`, `\usepackage`, `\documentclass`, `\includepdf`, `\lstinputlisting`,
`\verbatiminput`, `\includesvg` (commented-out lines are left alone, and a reference written without its
ending keeps leaving it off). It says how many references it updated; a `\graphicspath` setup is not followed.
The path inside `\includegraphics{…}` (and `\includepdf{…}`) autocompletes from the pictures in the scroll, with
kind and size and a thumbnail, and the list opens by itself when Tab lands on the `path` placeholder of the
inserted template.
**Folders.** The Tavern Hall list in the editor has *+ File* and *+ Folder* buttons. A folder is a table: it can be
made at the top level or inside another folder, it exists even while empty, everyone at the table sees it at once,
and it shows up on the Tavern Hall map (where *New Table* makes the same thing). The plus beside a folder starts a
new file already inside it, and an empty folder can be removed with its ×.
**Panels** (the *Panels* button in the editor header): drag the strips between panels to resize the Tavern
Hall, the preview and the ink log (or focus a strip and use the arrow keys, Shift for bigger steps,
Home/End for the limits; double-click or Enter resets it). The source editor always keeps at least 320 px.
Show or hide each panel (a hidden Tavern Hall folds into a narrow rail), send the *Scroll Preview* or the
*Ink Log* to a window of their own, and keep the arrangement with *Save as my tavern layout* (stored in this
browser only; *Reset to default layout* goes back and forgets it). A popped-out window is live-linked: the
preview follows every build and the log mirrors the compile state over a `BroadcastChannel`; clicking an
error there jumps to it in the editor; *Dock back* (or just closing the window) brings the panel home.
**Time travel** (the *History* button in the editor): every automatic and named snapshot on a timeline
(filters: all / named / mine; the live scroll is the *Now* entry). Pick one to read it as a read-only diff
against the present, file by file, in the editor's place: green lines would come back, red lines would go
away, long unchanged stretches fold. *Restore this version* rewrites the live scroll for everyone and first
saves the present as a snapshot, with an *Undo* right after; *Name it* turns a snapshot into a named one
(kept for good); *Save a version* names the present. Readers can look but not change anything. Pictures are
not part of snapshots. Diffing uses Myers' algorithm, so large files with a few edits stay instant.
**The Tavern Hall** (`/scroll/:id/hall`): every directory is a round table and every file a member on a
stool, on a map you drag to pan and zoom (buttons, Ctrl/⌘ + scroll, `+`/`-`/`0`/`F`, minimap, "Go to
table"). A table seats ten stools; beyond that the last stool is *the bench* (`+N`), a searchable list,
and the main file, the selection and files other scribes are in keep their stools. Also: List view with
search and filters, drop files on a table (or the door) to seat them, context menu (open, rename, move to
table, duplicate, download, copy path, remove), "New Table" (empty tables are shared through the
document's `tables` map), `.zip` import (drop an archive on the hall or on a table: it is unpacked in the browser, folders become tables, one wrapping folder is unwrapped, OS litter is ignored, unsupported or unsafe entries are skipped and listed, and the real inflated size is capped so a lying header cannot make a zip bomb; limits: 100 MB archive, 1000 files, 10 MB per picture, 1 MB per text file), an MCP server (`mcp/`, see its README) so an AI assistant can read, search, edit and compile scrolls with a personal access token (Profile → Security; read-only or read+write, expiring, revocable); a scroll's AI edits are held for review by default and only the owner can switch them to automatic; a menu bar (File/Edit/Format/View/Insert/Tools/Help) with New, Open, Import, Export as .zip, Rename and the rest; session recording (Tools → Record a session: a timelapse of the text changes only, an hour or 5 MB at most, kept in the browser for 30 minutes to watch or export as a `.quillsession` file, which can be opened again from Tools), passwordless sign-in ("Email me a magic link" on the sign-in page: a one-time link that lives 15 minutes, replaced by any newer one, also confirms the address; a 60-second wait before it can be asked for again), a "Your session has ended" screen that appears over the page you were on (so what you had typed is still there) when the server stops accepting your session, and a "You need a seat" page for private scrolls (the person asks with an optional message; the owner is emailed and gives a seat as scribe or reader, or declines, in Share), search and replace across every file (⌘F / Ctrl+F opens "Search the Tavern": matches grouped by file and lit up in the text, options for case, regular expressions ($1 works in the replacement), whole words and this file only; Enter / Shift+Enter or ⌘G step through matches; Replace all asks for a second click first and replaces everything in one shared change; readers can search but not replace), an onboarding tour (four steps: Tavern Hall, the desk, Compile, Share; opens by itself the first time in a browser, or with `?tour=1`, and again from the command menu's "Take the tour"; arrow keys, Esc to skip; never opens by itself in automated browsers), a command menu (⌘K / Ctrl+K in the editor: actions, files and help; ⌘1–4 or ⌥1–4 narrow it to all / actions / files / help (Safari keeps ⌘1–4 for its own tabs, so use ⌥ there); ⌘↵ runs a command and keeps the menu open), Word-style text shortcuts in the editor (⌘B bold, ⌘I italic, ⌘U underline, ⌘⇧E emph, ⌘E monospace, ⌘. (or ⌘⌥.) superscript, ⌘, (or ⌘⌥,) subscript, ⌘/ comment lines, ⌘⇧8 / ⌘⇧7 lists, ⌘⌥1-3 headings; math-aware: \\mathbf and ^{} inside math; Ctrl in place of ⌘ on Windows and Linux; ⌘⇧B hides the Tavern Hall panel, ⌘⇧H opens it), share links (the owner makes one link for editing and one for viewing in Share; anyone signed in who opens `/join/<token>` takes that seat, never a lower one than they have; links can be replaced or turned off), tables on the Tavern Hall map can be dragged to new places by scribes (positions are saved in the scroll's `layout` map and shared; tables never overlap, an unmoved hall keeps the old spiral; the map has walls), three themes (Quill's Tavern, Royal Chambers, Dwarves' Caves; pick one in your profile, kept in this browser; colours are tokens in `frontend/src/styles.scss`, one block per theme), a confirmation before removing a file from the Tavern Hall list, the selected `.tex` file is the one that compiles, error lines are highlighted after a failed compile, **Import scroll (.zip)** on the Your Scrolls page (makes a new scroll named after the archive, unpacks it with the same progress dialog, then opens it; the starter file is not written over it), folders in the editor's Tavern Hall list fold and unfold (click, Enter/Space, arrow keys; the active file's folders always open), presence badges for scribes sitting at a file, portraits with "used in".
**Still to build in the frontend:** command palette, onboarding tour; in the
hall: last-edited / editor columns (the server does not record them yet). Not built anywhere: Redis pub/sub for
running several server instances.
