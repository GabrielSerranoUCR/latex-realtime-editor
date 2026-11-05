#!/usr/bin/env node
// The Gilded Quill MCP server: lets an AI assistant work on the scrolls (LaTeX documents) of a Gilded Quill
// server, as the person whose access token it is given. It speaks MCP over stdio.
//
//   QUILL_URL    where the server is (default http://localhost:8080)
//   QUILL_TOKEN  a personal access token (Profile → Security → Access tokens in the app)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { QuillClient, enc } from './client.mjs';
import { describeCompile, describeQueued, numberLines, searchTexts } from './lib.mjs';

const client = new QuillClient(process.env.QUILL_URL || 'http://localhost:8080', process.env.QUILL_TOKEN || '');

const server = new McpServer(
  { name: 'gilded-quill', version: '0.1.0' },
  {
    instructions:
      'Tools for the scrolls (LaTeX documents) of a Gilded Quill server. Start with list_scrolls, then get_scroll to see a scroll\'s files. ' +
      'Read a file before you change it, and change it with edit_file (an exact text replacement) rather than rewriting the whole file; use write_file for new files. ' +
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
    description: 'Delete a text file from a scroll. The main file cannot be deleted.',
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

await server.connect(new StdioServerTransport());
