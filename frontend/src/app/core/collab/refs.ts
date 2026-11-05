import * as Y from 'yjs';
import { extOf } from '../latex/figure';

/**
 * When a file moves or is renamed, the sources that point at it must follow. LaTeX names files relative to
 * where the compiler runs (the project root), so a reference is just the file's path, with or without its
 * extension for the commands that allow leaving it out.
 */

/** Commands that name files, and the extensions LaTeX fills in when you leave the ending off. */
const COMMANDS: Record<string, { implicit: readonly string[]; list: boolean }> = {
  includegraphics: { implicit: ['png', 'jpg', 'jpeg', 'pdf', 'eps'], list: false },
  includesvg: { implicit: ['svg'], list: false },
  includepdf: { implicit: ['pdf'], list: false },
  input: { implicit: ['tex'], list: false },
  include: { implicit: ['tex'], list: false },
  subfile: { implicit: ['tex'], list: false },
  lstinputlisting: { implicit: [], list: false },
  verbatiminput: { implicit: [], list: false },
  bibliography: { implicit: ['bib'], list: true },
  addbibresource: { implicit: [], list: false },
  usepackage: { implicit: ['sty'], list: true },
  documentclass: { implicit: ['cls'], list: false },
};

export interface RefEdit {
  /** Offset of the old reference in the source, and its length. */
  at: number;
  length: number;
  /** What it becomes. */
  text: string;
}

const COMMAND = new RegExp(String.raw`\\(${Object.keys(COMMANDS).join('|')})\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}`, 'g');

const norm = (p: string): string => p.trim().replace(/^\.\//, '');
const stripExt = (p: string): string => p.replace(/\.[^./]+$/, '');

/** Is the character offset inside a `%` comment on its line? (An escaped `\%` does not start one.) */
function inComment(source: string, at: number): boolean {
  const lineStart = source.lastIndexOf('\n', at - 1) + 1;
  return /(^|[^\\])%/.test(source.slice(lineStart, at));
}

/**
 * Edits that point every reference to `from` at `to` instead. A reference that left off the ending keeps
 * leaving it off (as long as the ending is unchanged), so `\input{chapters/intro}` stays that way.
 */
export function findReferenceEdits(source: string, from: string, to: string): RefEdit[] {
  const edits: RefEdit[] = [];
  const fromExt = extOf(from);
  const sameExt = fromExt === extOf(to);
  COMMAND.lastIndex = 0;
  for (let m = COMMAND.exec(source); m; m = COMMAND.exec(source)) {
    if (inComment(source, m.index)) continue;
    const spec = COMMANDS[m[1]];
    const group = m[2];
    const groupAt = m.index + m[0].lastIndexOf('{') + 1;
    const parts = spec.list ? group.split(',') : [group];
    let offset = 0;
    for (const part of parts) {
      const lead = part.length - part.trimStart().length;
      const ref = norm(part);
      const start = groupAt + offset + lead;
      offset += part.length + 1;
      if (!ref) continue;
      const writtenInFull = ref === from;
      const leftEndingOff = !writtenInFull && ref === stripExt(from) && spec.implicit.includes(fromExt);
      if (!writtenInFull && !leftEndingOff) continue;
      const replacement = leftEndingOff && sameExt ? stripExt(to) : to;
      edits.push({ at: start, length: part.trim().length, text: replacement });
    }
  }
  return edits;
}

/** Apply edits to a string (last first, so earlier offsets stay true). */
export function applyEdits(source: string, edits: readonly RefEdit[]): string {
  return [...edits].sort((a, b) => b.at - a.at).reduce((s, e) => s.slice(0, e.at) + e.text + s.slice(e.at + e.length), source);
}

export interface RefUpdate {
  references: number;
  files: number;
}

/** Rewrite the references in every text file of the document, as small edits (everyone's cursors stay put). */
export function updateReferences(doc: Y.Doc, from: string, to: string): RefUpdate {
  const files = doc.getMap<Y.Text>('files');
  const planned: Array<[Y.Text, RefEdit[]]> = [];
  files.forEach((text) => {
    const edits = findReferenceEdits(text.toString(), from, to);
    if (edits.length) planned.push([text, edits]);
  });
  doc.transact(() => {
    for (const [text, edits] of planned) for (const e of [...edits].sort((a, b) => b.at - a.at)) {
      text.delete(e.at, e.length);
      text.insert(e.at, e.text);
    }
  });
  return { references: planned.reduce((n, [, e]) => n + e.length, 0), files: planned.length };
}
