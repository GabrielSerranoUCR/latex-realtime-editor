# Gilded Quill MCP server

Lets an AI assistant (Claude Desktop, Claude Code, or any MCP client) read, search, edit and compile the scrolls
(LaTeX documents) of a Gilded Quill server, as you, with your own access and no more.

## Set up

1. Start the app as usual (backend on `:8080`, frontend on `:4200`).
2. In the app: **Profile → Security → Access tokens → Make a token**. Choose **Allow editing** only if the assistant
   should be able to change scrolls (otherwise it can read and compile). The token is shown once.
3. Add the server to your MCP client. For Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gilded-quill": {
      "command": "node",
      "args": ["/path/to/latex-realtime-editor/mcp/src/server.mjs"],
      "env": { "QUILL_URL": "http://localhost:4200", "QUILL_TOKEN": "qq_..." }
    }
  }
}
```

`QUILL_URL` is the address you use in the browser (the dev server forwards `/api` to the backend; `http://localhost:8080` also works).
Run `npm install` once in this folder first.

## Tools

| Tool | What it does |
|---|---|
| `list_scrolls` | Your scrolls, your role in each, and how assistants' edits are handled |
| `get_scroll` | Files, pictures, the main file, the mode, waiting proposals |
| `read_file` | A file, or a line range, with line numbers |
| `search` | Text or regular expression across every file |
| `edit_file` | Replace an exact passage (unique, or `replace_all`): only that part changes |
| `write_file` | Create a file or replace a whole one |
| `delete_file` | Delete a file (the main file too: another source becomes the main file) |
| `create_scroll`, `rename_scroll` | Make a scroll (you own it) or change its title (owner only) |
| `delete_scroll` | Delete a whole scroll (owner only; needs `confirm_title` to match; there is no undo in the app) |
| `list_images`, `get_image` | Pictures and PDFs of a scroll; `get_image` shows png/jpg/gif/webp to the model |
| `upload_image` | Add or replace a picture from a local `file_path`, `data_base64` or an http(s) `url` |
| `move_image`, `delete_image` | Rename / move / copy a picture, or delete it (references in `.tex` are not rewritten) |
| `compile` | Tectonic build with errors by file and line, warnings, and the log tail |
| `list_proposals`, `get_proposal_status` | Edits waiting for a person, and how one ended |

## Who decides what reaches the document

Each scroll has a setting, **AI assistant edits** (Edit menu → AI assistant edits…):

- **Review each edit** (the default): an assistant's write, edit or delete is kept as a proposal, with the reason it gave and a
  `git diff`-style view (line numbers, hunks, green additions and red deletions against the file as it is now). A scribe or the owner
  accepts or rejects each change on its own, or ticks several (or all) and decides in bulk. The tool result says it was *queued, not applied*.
- **Apply automatically**: edits land at once, like another scribe typing. **Only the scroll's owner can choose this**, and only
  from a signed-in browser: an access token can never change the mode, accept its own edit, or make more tokens.

Pictures and whole-scroll deletes have no proposal to wait in, so in **review** mode an access token may only *add* a new
picture or *copy* one; replacing, moving, deleting a picture and deleting the scroll are refused (with the way forward) until a
person does it in the app or the owner chooses **Apply automatically**. Creating and renaming scrolls always work for a write token.

A token has its owner's role in each scroll (a reader's token cannot change a scroll even with editing allowed), can be given an
expiry, and can be revoked at any time.

## Tests

```
npm test                 # the pure helpers
node test/e2e.mjs        # drives the real server over stdio against a running backend (with Tectonic)
```
