#!/usr/bin/env node
// The Gilded Quill MCP server: lets an AI assistant work on the scrolls (LaTeX documents) of a Gilded Quill
// server, as the person whose access token it is given. It speaks MCP over stdio.
//
//   QUILL_URL    where the server is (default http://localhost:8080)
//   QUILL_TOKEN  a personal access token (Profile → Security → Access tokens in the app)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { QuillClient, enc } from './client.mjs';
import { VIEWABLE, decodeBase64, describeCompile, describeQueued, humanBytes, numberLines, pictureType, searchTexts, titleMatches } from './lib.mjs';

const client = new QuillClient(process.env.QUILL_URL || 'http://localhost:8080', process.env.QUILL_TOKEN || '');

const server = new McpServer(
  { name: 'gilded-quill', version: '0.1.0' },
  {
    instructions:
      'Tools for the scrolls (LaTeX documents) of a Gilded Quill server. Start with list_scrolls, then get_scroll to see a scroll\'s files. ' +
      'Scrolls can be created, renamed and deleted, and pictures (png, jpg, gif, webp, svg, pdf, eps) uploaded, viewed, moved and deleted; a picture is used from LaTeX with \\includegraphics{path}. Read a file before you change it, and change it with edit_file (an exact text replacement) rather than rewriting the whole file; use write_file for new files. ' +
      'Run compile after changes and fix the errors it reports. A scroll may be set to REVIEW: then edits are queued as proposals and a person must accept them in the app; the tool result says so. ' +
      'Other people may be editing the same scroll at the same moment, so re-read before editing again if something failed.',
  },
);

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] });
/** Wrap a tool body: any thrown message becomes a tool error the model can read and act on. */
const tool = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return fail(e);
  }
};

const scrollId = z.string().min(1).describe('The scroll id (from list_scrolls).');
const filePath = z.string().min(1).describe('File path inside the scroll, such as "main.tex" or "chapters/intro.tex".');
const picturePath = z.string().min(1).describe('Picture path inside the scroll, such as "figures/logo.png". The ending decides the type: png, jpg, jpeg, gif, webp, svg, pdf or eps.');
const note = z.string().max(300).optional().describe('Why you are making this change, in a sentence. Shown to the person who reviews it.');

server.registerTool(
  'list_scrolls',
  {
    title: 'List scrolls',
    description: 'List the scrolls (documents) you have access to, with your role in each and whether assistants\' edits wait for review.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const { body } = await client.ok('GET', '/api/scrolls', undefined, 'Listing scrolls');
    if (!body.length) return text('You have no scrolls yet.');
    return text(body.map((s) => `${s.id}  “${s.title}”  role: ${s.role}  edits by assistants: ${s.aiEditMode === 'auto' ? 'applied automatically' : 'held for review'}  (owner ${s.ownerName}, ${s.memberCount} scribes)`).join('\n'));
  }),
);

server.registerTool(
  'get_scroll',
  {
    title: 'Get a scroll',
    description: 'Show one scroll: its title, your role, how assistants\' edits are handled, the main file, every text file (with size) and every picture/PDF, and how many proposed edits are waiting.',
    inputSchema: { scroll: scrollId },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ scroll }) => {
    const [info, files, props] = await Promise.all([
      client.ok('GET', `/api/scrolls/${scroll}`, undefined, 'Reading the scroll'),
      client.ok('GET', `/api/scrolls/${scroll}/files`, undefined, 'Listing files'),
      client.ok('GET', `/api/scrolls/${scroll}/proposals`, undefined, 'Listing proposals'),
    ]);
    const s = info.body;
    const f = files.body;
    const lines = [
      `“${s.title}” (${scroll})`,
      `Your role: ${s.role}. Edits by assistants: ${s.aiEditMode === 'auto' ? 'applied automatically' : 'held for review by a person'}.`,
      `Main file: ${f.main}`,
      '',
      'Text files:',
      ...f.files.map((x) => `  ${x.path}  (${x.lines} lines, ${x.bytes} bytes)`),
    ];
    if (f.assets.length) lines.push('', 'Pictures and PDFs (not readable as text; usable with \\includegraphics):', ...f.assets.map((a) => `  ${a.path}  (${a.mime}, ${a.size} bytes)`));
    if (props.body.length) lines.push('', `${props.body.length} proposed edit(s) waiting for a person to accept.`);
    return text(lines.join('\n'));
  }),
);

server.registerTool(
  'read_file',
  {
    title: 'Read a file',
    description: 'Read a text file of a scroll, or only some of its lines. By default every line is prefixed with its line number ("  12 | text"); the numbers are not part of the file, so never put them in old_text.',
    inputSchema: {
      scroll: scrollId,
      path: filePath,
      start_line: z.number().int().min(1).optional().describe('First line to read (1-based). Default: the start.'),
      end_line: z.number().int().min(1).optional().describe('Last line to read, inclusive. Default: the end.'),
      line_numbers: z.boolean().optional().describe('Prefix lines with their numbers (default true). Use false to get the raw text.'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ scroll, path, start_line, end_line, line_numbers = true }) => {
    const q = new URLSearchParams();
    if (start_line) q.set('start', String(start_line));
    if (end_line) q.set('end', String(end_line));
    const { body } = await client.ok('GET', `/api/scrolls/${scroll}/files/${enc(path)}${q.size ? `?${q}` : ''}`, undefined, 'Reading the file');
    const head = `${body.path}: lines ${body.startLine}-${body.endLine} of ${body.totalLines}`;
    return text(`${head}\n\n${line_numbers ? numberLines(body.content, body.startLine || 1) : body.content}`);
  }),
);

server.registerTool(
  'search',
  {
    title: 'Search a scroll',
    description: 'Find text in every file of a scroll. Returns file, line and column of each match with the line itself.',
    inputSchema: {
      scroll: scrollId,
      query: z.string().min(1).describe('What to look for.'),
      regex: z.boolean().optional().describe('Treat the query as a regular expression (default false).'),
      case_sensitive: z.boolean().optional(),
      whole_word: z.boolean().optional(),
      max_results: z.number().int().min(1).max(200).optional().describe('Most matches to list (default 50).'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ scroll, query, regex, case_sensitive, whole_word, max_results = 50 }) => {
    const listing = (await client.ok('GET', `/api/scrolls/${scroll}/files`, undefined, 'Listing files')).body;
    const files = await Promise.all(
      listing.files.map(async (f) => ({ path: f.path, text: (await client.ok('GET', `/api/scrolls/${scroll}/files/${enc(f.path)}`, undefined, 'Reading a file')).body.content })),
    );
    const r = searchTexts(files, query, { regex, caseSensitive: case_sensitive, wholeWord: whole_word }, max_results);
    if (r.error) return fail(new Error(r.error));
    if (!r.total) return text(`No matches for “${query}”.`);
    const lines = r.hits.map((h) => `${h.path}:${h.line}:${h.column}  ${h.text.trim()}`);
    return text(`${r.total} match(es)${r.truncated ? ` (showing the first ${r.hits.length})` : ''}:\n${lines.join('\n')}`);
  }),
);

server.registerTool(
  'edit_file',
  {
    title: 'Edit part of a file',
    description:
      'Replace an exact piece of text in a file with new text. old_text must match the file exactly (spaces, line breaks, backslashes) and appear exactly once, unless replace_all is true: include enough surrounding text to make it unique. ' +
      'Only that piece changes, so what other people are typing elsewhere in the file is untouched. Prefer this to write_file for changing existing files. Read the file first.',
    inputSchema: {
      scroll: scrollId,
      path: filePath,
      old_text: z.string().min(1).describe('The exact text to replace.'),
      new_text: z.string().describe('What to put there (may be empty to delete).'),
      replace_all: z.boolean().optional().describe('Replace every occurrence (default false).'),
      note,
    },
  },
  tool(async ({ scroll, path, old_text, new_text, replace_all, note }) => {
    const r = await client.ok('PATCH', `/api/scrolls/${scroll}/files/${enc(path)}`, { oldText: old_text, newText: new_text, replaceAll: !!replace_all, note: note ?? '' }, 'The edit');
    if (r.status === 202) return text(describeQueued(r.body));
    return text(`Edited ${r.body.path}: ${r.body.replacements} replacement(s). The file is now ${r.body.bytes} bytes.`);
  }),
);

server.registerTool(
  'write_file',
  {
    title: 'Write a whole file',
    description: 'Create a new text file, or replace the whole text of an existing one (.tex, .bib, .sty, .cls, .def, .md, .txt; up to 1 MB). To change part of an existing file use edit_file instead.',
    inputSchema: { scroll: scrollId, path: filePath, content: z.string().describe('The complete text of the file.'), note },
  },
  tool(async ({ scroll, path, content, note }) => {
    const r = await client.ok('PUT', `/api/scrolls/${scroll}/files/${enc(path)}`, { content, note: note ?? '' }, 'The write');
    if (r.status === 202) return text(describeQueued(r.body));
    return text(`${r.body.created ? 'Created' : 'Replaced'} ${r.body.path} (${r.body.bytes} bytes).`);
  }),
);

server.registerTool(
  'delete_file',
  {
    title: 'Delete a file',
    description: 'Delete a text file from a scroll, the main file included (another source then becomes the main file, if there is one).',
    inputSchema: { scroll: scrollId, path: filePath },
    annotations: { destructiveHint: true },
  },
  tool(async ({ scroll, path }) => {
    const r = await client.ok('DELETE', `/api/scrolls/${scroll}/files/${enc(path)}`, undefined, 'The delete');
    if (r.status === 202) return text(describeQueued(r.body));
    return text(`Deleted ${r.body.path}.`);
  }),
);

server.registerTool(
  'compile',
  {
    title: 'Compile a scroll',
    description: 'Compile the scroll to a PDF with the Tectonic engine and report errors (with file and line), warnings and, on failure, the end of the log. Compiles the main file unless `file` is given. Changes still waiting for review are not in the document, so they are not compiled.',
    inputSchema: { scroll: scrollId, file: z.string().optional().describe('A .tex file to compile instead of the main file (for example a beamer presentation).') },
  },
  tool(async ({ scroll, file }) => {
    const { body } = await client.ok('POST', `/api/rooms/${scroll}/compile`, file ? { main: file } : {}, 'The compile');
    return text(describeCompile(body));
  }),
);

server.registerTool(
  'list_proposals',
  {
    title: 'List waiting edits',
    description: 'List edits that assistants proposed in this scroll and that still wait for a person to accept or reject them.',
    inputSchema: { scroll: scrollId },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ scroll }) => {
    const { body } = await client.ok('GET', `/api/scrolls/${scroll}/proposals`, undefined, 'Listing proposals');
    if (!body.length) return text('No edits are waiting.');
    return text(body.map((p) => `${p.id}  ${p.kind} ${p.path}  by ${p.by} (${p.tokenName || 'token'})${p.note ? `  — ${p.note}` : ''}`).join('\n'));
  }),
);

server.registerTool(
  'get_proposal_status',
  {
    title: 'Check a queued edit',
    description: 'Find out whether an edit that was queued for review has been accepted, rejected, or is still waiting.',
    inputSchema: { scroll: scrollId, proposal_id: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ scroll, proposal_id }) => {
    const { body } = await client.ok('GET', `/api/scrolls/${scroll}/proposals/${proposal_id}`, undefined, 'Reading the proposal');
    return text(`Proposal ${body.id} (${body.kind} ${body.path}): ${body.status}${body.decidedAt ? ` at ${body.decidedAt}` : ''}.`);
  }),
);

// ---- scrolls: create, rename, delete (list_scrolls and get_scroll are the read side) ----------------------------

server.registerTool(
  'create_scroll',
  {
    title: 'Create a scroll',
    description: 'Create a new, empty-but-compilable scroll with the given title. You become its owner (it appears under your name). Returns its id; then use write_file to fill it.',
    inputSchema: { title: z.string().min(1).max(120).describe('The scroll\'s title (1-120 characters).') },
  },
  tool(async ({ title }) => {
    const { body } = await client.ok('POST', '/api/scrolls', { title }, 'Creating the scroll');
    return text(`Created “${body.title}” (${body.id}). You are its owner. Edits by assistants: ${body.aiEditMode === 'auto' ? 'applied automatically' : 'held for review'}.`);
  }),
);

server.registerTool(
  'rename_scroll',
  {
    title: 'Rename a scroll',
    description: 'Change a scroll\'s title. Only the scroll\'s owner may.',
    inputSchema: { scroll: scrollId, title: z.string().min(1).max(120).describe('The new title (1-120 characters).') },
  },
  tool(async ({ scroll, title }) => {
    await client.ok('PATCH', `/api/scrolls/${scroll}`, { title }, 'The rename');
    return text(`Renamed the scroll to “${title.trim()}”.`);
  }),
);

server.registerTool(
  'delete_scroll',
  {
    title: 'Delete a scroll',
    description:
      'Delete a whole scroll (it leaves everyone\'s list, and the app has no way to bring it back). Only the owner may, and only after a person asked for exactly this: ' +
      'confirm_title must be the scroll\'s current title, typed as the person gave it. If the scroll holds assistants\' edits for review, this is refused: a person deletes it in the app, or the owner sets it to apply edits automatically.',
    inputSchema: { scroll: scrollId, confirm_title: z.string().min(1).describe('The scroll\'s exact current title, as proof it is the right one.') },
    annotations: { destructiveHint: true },
  },
  tool(async ({ scroll, confirm_title }) => {
    const info = (await client.ok('GET', `/api/scrolls/${scroll}`, undefined, 'Reading the scroll')).body;
    if (!titleMatches(info.title, confirm_title)) throw new Error(`confirm_title does not match this scroll, whose title is “${info.title}”. Nothing was deleted.`);
    await client.ok('DELETE', `/api/scrolls/${scroll}`, undefined, 'The delete');
    return text(`Deleted the scroll “${info.title}”.`);
  }),
);

// ---- pictures: list, upload, view, move, delete -------------------------------------------------------------

server.registerTool(
  'list_images',
  {
    title: 'List pictures',
    description: 'List the pictures and PDFs of a scroll with their type, size and checksum.',
    inputSchema: { scroll: scrollId },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ scroll }) => {
    const { body } = await client.ok('GET', `/api/scrolls/${scroll}/assets`, undefined, 'Listing pictures');
    if (!body.length) return text('This scroll has no pictures.');
    return text(body.map((a) => `${a.path}  (${a.mime}, ${humanBytes(a.size)})`).join('\n'));
  }),
);

server.registerTool(
  'upload_image',
  {
    title: 'Add or replace a picture',
    description:
      'Put a picture or PDF into a scroll, from exactly one of: file_path (a file on the machine this server runs on), data_base64 (the bytes, base64 or a data: URL) or url (an http/https address to download). ' +
      'Uploading to a path that exists replaces it. Types: png, jpg, jpeg, gif, webp, svg, pdf, eps; the contents must match the ending; the server limits the size (25 MB by default) and the space per scroll. ' +
      'Pictures apply at once, not through the review queue; replacing one is refused while the scroll holds assistants\' edits for review. Afterwards reference it with \\includegraphics{path} (edit_file / write_file).',
    inputSchema: {
      scroll: scrollId,
      path: picturePath,
      file_path: z.string().optional().describe('A local file to upload.'),
      data_base64: z.string().optional().describe('The picture\'s bytes as base64 (or a data: URL).'),
      url: z.string().optional().describe('An http(s) address to download the picture from.'),
    },
  },
  tool(async ({ scroll, path, file_path, data_base64, url }) => {
    if ([file_path, data_base64, url].filter((x) => x !== undefined).length !== 1) throw new Error('Give exactly one of file_path, data_base64 or url.');
    if (!pictureType(path)) throw new Error('That file ending is not supported. Use png, jpg, jpeg, gif, webp, svg, pdf or eps in the path.');
    let bytes;
    if (file_path !== undefined) {
      try {
        bytes = await readFile(file_path);
      } catch (e) {
        throw new Error(`Could not read ${file_path}: ${e.code || e.message}`);
      }
    } else if (data_base64 !== undefined) {
      bytes = decodeBase64(data_base64);
      if (!bytes) throw new Error('data_base64 is not valid base64.');
    } else {
      let u;
      try {
        u = new URL(url);
      } catch {
        throw new Error('url is not a valid address.');
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https addresses can be downloaded.');
      let res;
      try {
        res = await fetch(u, { redirect: 'follow' });
      } catch (e) {
        throw new Error(`Could not download the picture: ${e?.cause?.code ?? e?.message ?? e}`);
      }
      if (!res.ok) throw new Error(`Downloading the picture failed (HTTP ${res.status}).`);
      bytes = Buffer.from(await res.arrayBuffer());
    }
    if (!bytes.length) throw new Error('That picture is empty.');
    const { body } = await client.okBinary('PUT', `/api/scrolls/${scroll}/assets/${enc(path)}`, bytes, 'The upload');
    return text(`Saved ${body.path} (${body.mime}, ${humanBytes(body.size)}). Use it with \\includegraphics{${body.path}}.`);
  }),
);

server.registerTool(
  'get_image',
  {
    title: 'View a picture',
    description: 'Fetch a picture of a scroll so you can look at it (png, jpg, gif, webp come back as an image; svg as its markup; a pdf or eps only as details, since it cannot be shown).',
    inputSchema: { scroll: scrollId, path: picturePath },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ scroll, path }) => {
    const r = await client.okBinary('GET', `/api/scrolls/${scroll}/assets/${enc(path)}`, undefined, 'Reading the picture');
    const mime = (r.mime || pictureType(path) || '').split(';')[0];
    const head = `${path}  (${mime}, ${humanBytes(r.bytes.length)})`;
    if (VIEWABLE.has(mime)) return { content: [{ type: 'text', text: head }, { type: 'image', data: r.bytes.toString('base64'), mimeType: mime }] };
    if (mime === 'image/svg+xml') return text(`${head}\n\n${r.bytes.toString('utf8')}`);
    return text(`${head}\n\nThis type cannot be shown here; it can still be used with \\includegraphics{${path}}.`);
  }),
);

server.registerTool(
  'move_image',
  {
    title: 'Rename, move or copy a picture',
    description:
      'Give a picture a new path (rename or move to another folder), or with copy=true keep the original and make a copy. The ending cannot change. ' +
      'References inside .tex files are NOT rewritten: afterwards fix \\includegraphics lines with edit_file (search finds them). Moving or renaming is refused while the scroll holds assistants\' edits for review; copying is allowed.',
    inputSchema: { scroll: scrollId, from: picturePath, to: picturePath, copy: z.boolean().optional().describe('Keep the original (default false: move).') },
  },
  tool(async ({ scroll, from, to, copy }) => {
    const { body } = await client.ok('POST', `/api/scrolls/${scroll}/asset-moves`, { from, to, copy: !!copy }, 'The move');
    return text(`${copy ? 'Copied' : 'Moved'} ${from} to ${body.path}. Update any \\includegraphics{${from}} in the sources.`);
  }),
);

server.registerTool(
  'delete_image',
  {
    title: 'Delete a picture',
    description: 'Delete a picture or PDF from a scroll. Refused while the scroll holds assistants\' edits for review (a person can delete it in the app). Sources that still \\includegraphics it will stop compiling.',
    inputSchema: { scroll: scrollId, path: picturePath },
    annotations: { destructiveHint: true },
  },
  tool(async ({ scroll, path }) => {
    await client.ok('DELETE', `/api/scrolls/${scroll}/assets/${enc(path)}`, undefined, 'The delete');
    return text(`Deleted ${path}.`);
  }),
);

await server.connect(new StdioServerTransport());
