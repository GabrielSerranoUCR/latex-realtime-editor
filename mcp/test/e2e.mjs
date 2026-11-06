// Drives the real MCP server (over stdio, as an AI client would) against a running Gilded Quill backend.
//   node test/e2e.mjs           (backend on QUILL_URL, default http://localhost:8080, with Tectonic installed)
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BASE = process.env.QUILL_URL || 'http://localhost:8080';
let passed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (ok) passed++;
  else process.exitCode = 1;
};

// a person, in a browser (cookie): makes the scroll and the tokens, and accepts proposals
const email = `mcp-${Date.now()}@guild.test`;
const signup = await fetch(`${BASE}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, displayName: 'Mcp Tester', password: 'correct horse battery staple' }) });
const cookie = signup.headers.getSetCookie().find((c) => c.startsWith('quill_session=')).split(';')[0];
const person = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
const scroll = (await person('POST', '/api/scrolls', { title: 'MCP test' })).body.id;
const makeToken = async (name, write) => (await person('POST', '/api/me/tokens', { name, write })).body.token;

async function connect(token) {
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/server.mjs'], env: { ...process.env, QUILL_URL: BASE, QUILL_TOKEN: token } }));
  return client;
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: !!r.isError, text: r.content.map((c) => c.text).join('\n') };
};

try {
  const writer = await connect(await makeToken('e2e writer', true));
  const tools = (await writer.listTools()).tools.map((t) => t.name).sort();
  check('the server offers its tools', ['compile', 'create_scroll', 'delete_scroll', 'rename_scroll', 'list_images', 'upload_image', 'get_image', 'move_image', 'delete_image', 'delete_file', 'edit_file', 'get_proposal_status', 'get_scroll', 'list_proposals', 'list_scrolls', 'read_file', 'search', 'write_file'].every((n) => tools.includes(n)), tools.join(', '));
  check('every tool has a description for the model', (await writer.listTools()).tools.every((t) => (t.description || '').length > 30));

  const list = await call(writer, 'list_scrolls');
  check('list_scrolls shows the scroll and that edits are held for review', list.text.includes(scroll) && list.text.includes('held for review'), list.text);

  // review mode (the default): the assistant's write waits for a person
  const queued = await call(writer, 'write_file', { scroll, path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nHello Hamiltonian\n\\end{document}\n', note: 'start the document' });
  check('in review mode a write is queued, and the tool says nothing changed yet', !queued.error && queued.text.includes('QUEUED, NOT APPLIED'), queued.text);
  const pid = queued.text.match(/proposal ([0-9a-f-]{36})/)[1];
  check('list_proposals shows it', (await call(writer, 'list_proposals', { scroll })).text.includes(pid));
  check('get_proposal_status says pending', (await call(writer, 'get_proposal_status', { scroll, proposal_id: pid })).text.includes('pending'));
  check('the file does not exist yet', (await call(writer, 'read_file', { scroll, path: 'main.tex' })).error);
  check('the assistant cannot accept its own edit (the API refuses a token)', (await fetch(`${BASE}/api/scrolls/${scroll}/proposals/${pid}/accept`, { method: 'POST', headers: { authorization: `Bearer x`, 'content-type': 'application/json' }, body: '{}' })).status === 401);
  assert.equal((await person('POST', `/api/scrolls/${scroll}/proposals/${pid}/accept`, {})).status, 204);
  check('after a person accepts, get_proposal_status says accepted', (await call(writer, 'get_proposal_status', { scroll, proposal_id: pid })).text.includes('accepted'));

  const read = await call(writer, 'read_file', { scroll, path: 'main.tex' });
  check('read_file shows the accepted text with line numbers', read.text.includes('3 | Hello Hamiltonian'), read.text);
  const raw = await call(writer, 'read_file', { scroll, path: 'main.tex', start_line: 3, end_line: 3, line_numbers: false });
  check('read_file can give a line range as raw text', raw.text.endsWith('Hello Hamiltonian\n') && raw.text.includes('lines 3-3 of 4'), raw.text);

  // auto mode: only the owner (a browser) can choose it
  assert.equal((await person('PUT', `/api/scrolls/${scroll}/ai-mode`, { mode: 'auto' })).status, 204);
  const edited = await call(writer, 'edit_file', { scroll, path: 'main.tex', old_text: 'Hello Hamiltonian', new_text: 'Hello \\textbf{world}' });
  check('in auto mode an edit applies at once', !edited.error && edited.text.startsWith('Edited main.tex: 1 replacement'), edited.text);
  check('the change is in the document', (await call(writer, 'read_file', { scroll, path: 'main.tex', line_numbers: false })).text.includes('Hello \\textbf{world}'));
  const wrong = await call(writer, 'edit_file', { scroll, path: 'main.tex', old_text: 'not there', new_text: 'x' });
  check('an edit whose old_text is missing is an error that says how to fix it', wrong.error && wrong.text.includes('was not found'), wrong.text);
  const created = await call(writer, 'write_file', { scroll, path: 'chapters/two.tex', content: 'Hamiltonian again\n' });
  check('write_file creates a file in a folder', created.text.startsWith('Created chapters/two.tex'), created.text);
  const found = await call(writer, 'search', { scroll, query: 'hamiltonian' });
  check('search finds text across files', found.text.includes('chapters/two.tex:1:1') && found.text.includes('1 match'), found.text);
  check('search with a bad regex says so', (await call(writer, 'search', { scroll, query: '(', regex: true })).error);
  const info = await call(writer, 'get_scroll', { scroll });
  check('get_scroll shows files, the main file and the mode', info.text.includes('main.tex') && info.text.includes('chapters/two.tex') && info.text.includes('Main file: main.tex') && info.text.includes('applied automatically'), info.text);
  const compiled = await call(writer, 'compile', { scroll });
  check('compile runs the real engine and reports success', compiled.text.startsWith('Compiled successfully'), compiled.text.slice(0, 200));
  await call(writer, 'edit_file', { scroll, path: 'main.tex', old_text: '\\textbf{world}', new_text: '\\undefinedcommand{world}' });
  const broken = await call(writer, 'compile', { scroll });
  check('a broken document reports the error with file and line', broken.text.includes('FAILED') && /main\.tex:\d+/.test(broken.text), broken.text.slice(0, 300));
  const del = await call(writer, 'delete_file', { scroll, path: 'chapters/two.tex' });
  check('delete_file removes a file', del.text.includes('Deleted chapters/two.tex'), del.text);
  const delMain = await call(writer, 'delete_file', { scroll, path: 'main.tex' });
  check('the main file can be deleted too', !delMain.error && delMain.text.includes('Deleted main.tex'), delMain.text);

  // scrolls: create, rename, delete (a new scroll is in review mode, which guards destructive steps)
  const made = await call(writer, 'create_scroll', { title: 'Made by an assistant' });
  const sid = made.text.match(/\(([0-9a-f-]{36})\)/)?.[1];
  check('create_scroll makes a scroll that shows up in list_scrolls', !made.error && sid && (await call(writer, 'list_scrolls')).text.includes('Made by an assistant'), made.text);
  check('rename_scroll changes the title', (await call(writer, 'rename_scroll', { scroll: sid, title: 'Renamed scroll' })).text.includes('Renamed') && (await call(writer, 'list_scrolls')).text.includes('Renamed scroll'));

  // pictures: a 1x1 png
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const up = await call(writer, 'upload_image', { scroll: sid, path: 'figures/dot.png', data_base64: PNG });
  check('upload_image stores a picture (new files are allowed in review mode)', !up.error && up.text.includes('figures/dot.png') && up.text.includes('image/png'), up.text);
  check('list_images shows it', (await call(writer, 'list_images', { scroll: sid })).text.includes('figures/dot.png'));
  check('get_scroll lists it among the pictures', (await call(writer, 'get_scroll', { scroll: sid })).text.includes('figures/dot.png'));
  const viewed = await writer.callTool({ name: 'get_image', arguments: { scroll: sid, path: 'figures/dot.png' } });
  const img = viewed.content.find((c) => c.type === 'image');
  check('get_image returns the picture as an image the model can see', img && img.mimeType === 'image/png' && img.data === PNG, JSON.stringify(viewed.content).slice(0, 120));
  check('a file that is not a picture is refused', (await call(writer, 'upload_image', { scroll: sid, path: 'bad.png', data_base64: Buffer.from('MZ not an image at all').toString('base64') })).error);
  check('an unsupported ending is refused before upload', (await call(writer, 'upload_image', { scroll: sid, path: 'a.exe', data_base64: PNG })).error);
  check('exactly one source is required', (await call(writer, 'upload_image', { scroll: sid, path: 'a.png' })).error);
  const copied = await call(writer, 'move_image', { scroll: sid, from: 'figures/dot.png', to: 'figures/copy.png', copy: true });
  check('copying a picture is allowed in review mode', !copied.error && (await call(writer, 'list_images', { scroll: sid })).text.includes('figures/copy.png'), copied.text);
  const held = [
    await call(writer, 'upload_image', { scroll: sid, path: 'figures/dot.png', data_base64: PNG }),
    await call(writer, 'move_image', { scroll: sid, from: 'figures/copy.png', to: 'figures/moved.png' }),
    await call(writer, 'delete_image', { scroll: sid, path: 'figures/copy.png' }),
    await call(writer, 'delete_scroll', { scroll: sid, confirm_title: 'Renamed scroll' }),
  ];
  check('in review mode replacing, moving, deleting a picture and deleting the scroll are refused, with a way forward', held.every((r) => r.error && r.text.includes('for review')), held.map((r) => r.text.slice(0, 60)).join(' | '));
  check('the picture is still there after the refusals', (await call(writer, 'list_images', { scroll: sid })).text.includes('figures/copy.png'));
  // the owner switches the scroll to auto, then the full set works
  assert.equal((await person('PUT', `/api/scrolls/${sid}/ai-mode`, { mode: 'auto' })).status, 204);
  check('in auto mode a picture can be replaced', !(await call(writer, 'upload_image', { scroll: sid, path: 'figures/dot.png', data_base64: PNG })).error);
  check('in auto mode a picture can be moved', (await call(writer, 'move_image', { scroll: sid, from: 'figures/copy.png', to: 'moved.png' })).text.includes('Moved'));
  check('in auto mode a picture can be deleted', (await call(writer, 'delete_image', { scroll: sid, path: 'moved.png' })).text.includes('Deleted moved.png'));
  check('a missing picture is a clear error', (await call(writer, 'get_image', { scroll: sid, path: 'moved.png' })).error);
  const wrongTitle = await call(writer, 'delete_scroll', { scroll: sid, confirm_title: 'Something else' });
  check('delete_scroll refuses a wrong confirm_title', wrongTitle.error && wrongTitle.text.includes('Nothing was deleted'), wrongTitle.text);
  const gone = await call(writer, 'delete_scroll', { scroll: sid, confirm_title: 'renamed scroll ' });
  check('delete_scroll removes the scroll when confirmed (in auto mode)', !gone.error && !(await call(writer, 'list_scrolls')).text.includes(sid), gone.text);

  // a read-only token reads and compiles, and cannot change anything
  const reader = await connect(await makeToken('e2e reader', false));
  check('a read-only token can read', (await call(reader, 'read_file', { scroll, path: 'main.tex' })).text.includes('main.tex'));
  check('a read-only token cannot create a scroll', (await call(reader, 'create_scroll', { title: 'nope' })).error);
  const denied = await call(reader, 'write_file', { scroll, path: 'x.tex', content: 'x' });
  check('a read-only token cannot write, and the message says why', denied.error && denied.text.includes('read-only'), denied.text);
  // a bad token
  const bad = await connect('qq_nope');
  const nope = await call(bad, 'list_scrolls');
  check('a wrong token gives a clear message', nope.error && nope.text.includes('Access tokens'), nope.text);
  await Promise.all([writer.close(), reader.close(), bad.close()]);
} catch (e) {
  console.log('ERROR', e.stack || e);
  process.exitCode = 1;
}
console.log(`\n${passed} checks passed`);
