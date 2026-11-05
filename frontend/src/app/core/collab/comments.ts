/** Margin notes: pure helpers. The notes themselves live in the shared document (see comments.service.ts). */

export interface NoteMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  text: string;
  /** Epoch milliseconds. */
  at: number;
}

/** A thread's place in a file: two Yjs relative positions (JSON), so it follows edits around it. */
export interface NoteAnchor {
  start: unknown;
  end: unknown;
}

export interface NoteThread {
  id: string;
  file: string;
  anchor: NoteAnchor;
  /** What the anchor said when the note was written (shown when the text has moved or gone). */
  quote: string;
  resolved: boolean;
  resolvedBy: string | null;
  createdAt: number;
  messages: NoteMessage[];
}

export const MAX_NOTE_CHARS = 2000;
export const MAX_QUOTE_CHARS = 60;

/** 1-based line of a character index. */
export function lineOf(text: string, index: number): number {
  let line = 1;
  const end = Math.min(Math.max(0, index), text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** A short, single-line quote of `text.slice(from, to)`, or of the whole line when nothing is selected. */
export function quoteFor(text: string, from: number, to: number): string {
  let a = from;
  let b = to;
  if (a === b) {
    a = text.lastIndexOf('\n', Math.max(0, a - 1)) + 1;
    if (text[from] === '\n' && from > 0) a = text.lastIndexOf('\n', from - 1) + 1;
    b = text.indexOf('\n', from);
    if (b < 0) b = text.length;
  }
  const raw = text.slice(a, b).replace(/\s+/g, ' ').trim();
  return raw.length > MAX_QUOTE_CHARS ? raw.slice(0, MAX_QUOTE_CHARS - 1).trimEnd() + '…' : raw;
}

/** The range a new note attaches to: the selection, or the whole line the caret is on. */
export function noteRange(text: string, from: number, to: number = from): { from: number; to: number } {
  if (from !== to) return { from: Math.min(from, to), to: Math.max(from, to) };
  const start = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const lineStart = from > 0 && text[from - 1] === '\n' ? from : start;
  let end = text.indexOf('\n', from);
  if (end < 0) end = text.length;
  return { from: lineStart, to: end };
}

export interface Segment {
  text: string;
  mention: boolean;
  /** The mention is of the given person (e.g. you). */
  you?: boolean;
}

/** Split a note into plain text and `@Name` mentions of known scribes (longest names win, case-insensitive). */
export function splitMentions(text: string, names: readonly string[], me?: string): Segment[] {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  const out: Segment[] = [];
  let plain = '';
  const flush = () => {
    if (plain) out.push({ text: plain, mention: false });
    plain = '';
  };
  for (let i = 0; i < text.length; ) {
    if (text[i] === '@' && (i === 0 || /[\s([{]/.test(text[i - 1]))) {
      const hit = sorted.find((n) => text.slice(i + 1, i + 1 + n.length).toLowerCase() === n.toLowerCase() && !/[\w]/.test(text[i + 1 + n.length] ?? ' '));
      if (hit) {
        flush();
        out.push({ text: text.slice(i, i + 1 + hit.length), mention: true, you: !!me && hit.toLowerCase() === me.toLowerCase() });
        i += 1 + hit.length;
        continue;
      }
    }
    plain += text[i++];
  }
  flush();
  return out;
}

/** The `@partial` the caret is in, if any: where it starts and what has been typed after the `@`. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/[\s([{]/.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  return /^[^\n@]{0,30}$/.test(query) ? { start: at, query } : null;
}

export function suggestScribes(names: readonly string[], query: string, limit = 5): string[] {
  const q = query.trim().toLowerCase();
  const unique = [...new Set(names.filter(Boolean))];
  const starts = unique.filter((n) => n.toLowerCase().startsWith(q));
  const contains = unique.filter((n) => !starts.includes(n) && n.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}

/** Put a chosen name into the text where the `@partial` was; returns the new text and caret. */
export function insertMention(text: string, caret: number, start: number, name: string): { text: string; caret: number } {
  const inserted = `@${name} `;
  return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length };
}

export type NoteFilter = 'open' | 'resolved' | 'all';

export interface Located<T> {
  thread: T;
  /** 1-based line of the anchor's start in its file, or null when the file is gone. */
  line: number | null;
  /** The text the note was written about has been deleted. */
  lost: boolean;
  from: number | null;
  to: number | null;
}

/** Notes in reading order: by file (the open one first), then by position; unplaced notes last. */
export function sortLocated<T extends { file: string; createdAt: number }>(items: readonly Located<T>[], activeFile: string | null): Array<Located<T>> {
  return [...items].sort((a, b) => {
    const fa = a.thread.file === activeFile ? 0 : 1;
    const fb = b.thread.file === activeFile ? 0 : 1;
    if (fa !== fb) return fa - fb;
    if (a.thread.file !== b.thread.file) return a.thread.file.localeCompare(b.thread.file);
    const pa = a.from ?? Number.MAX_SAFE_INTEGER;
    const pb = b.from ?? Number.MAX_SAFE_INTEGER;
    return pa - pb || a.thread.createdAt - b.thread.createdAt;
  });
}

export const countOpen = (threads: readonly { resolved: boolean }[]): number => threads.filter((t) => !t.resolved).length;

/** Cleaned text of a note: trimmed, bounded. Returns null if there is nothing to post. */
export function cleanNote(raw: string): string | null {
  const t = raw.replace(/\r\n/g, '\n').trim();
  return t ? t.slice(0, MAX_NOTE_CHARS) : null;
}
