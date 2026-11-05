/** Word-processor style text commands for LaTeX source: pure functions over strings, used by the editor's key bindings. */

export type FormatKind = 'bold' | 'italic' | 'emph' | 'underline' | 'mono' | 'sup' | 'sub';

/** A change to the document and where the selection goes afterwards (both as offsets in the *new* text from `from`). */
export interface FormatEdit {
  from: number;
  to: number;
  insert: string;
  /** Selection after the change, as offsets into `insert`. */
  selStart: number;
  selEnd: number;
}

const MATH_ENVS = ['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*', 'displaymath', 'math', 'flalign', 'flalign*', 'alignat', 'alignat*'];

/** Is the position inside math ($…$, $$…$$, \(…\), \[…\] or a math environment)? A close reading of the text before it. */
export function isInMath(doc: string, pos: number): boolean {
  const before = doc.slice(0, pos).replace(/(^|[^\\])%.*$/gm, '$1'); // comments hold no math
  let inline = false; // $ … $
  let display = false; // $$ … $$
  let paren = false; // \( … \)
  let bracket = false; // \[ … \]
  let env = 0;
  const re = /\\\\|\\\$|\$\$|\$|\\\(|\\\)|\\\[|\\\]|\\(begin|end)\{([^}]+)\}/g;
  for (let m = re.exec(before); m; m = re.exec(before)) {
    const t = m[0];
    if (t === '\\\\' || t === '\\$') continue;
    if (t === '$$') display = !display;
    else if (t === '$') inline = !inline;
    else if (t === '\\(') paren = true;
    else if (t === '\\)') paren = false;
    else if (t === '\\[') bracket = true;
    else if (t === '\\]') bracket = false;
    else if (m[1] && MATH_ENVS.includes(m[2])) env += m[1] === 'begin' ? 1 : -1;
  }
  return inline || display || paren || bracket || env > 0;
}

const TEXT_COMMAND: Record<Exclude<FormatKind, 'sup' | 'sub'>, string> = { bold: '\\textbf', italic: '\\textit', emph: '\\emph', underline: '\\underline', mono: '\\texttt' };
const MATH_COMMAND: Record<Exclude<FormatKind, 'sup' | 'sub'>, string> = { bold: '\\mathbf', italic: '\\mathit', emph: '\\mathit', underline: '\\underline', mono: '\\mathtt' };

/** Are the braces in `s` balanced (so that `{s}` is one group)? */
function balanced(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Wrap the selection in `\command{…}`; do it again and it is taken off. With nothing selected it
 * puts the braces in and the caret between them.
 */
export function wrapWith(doc: string, from: number, to: number, command: string): FormatEdit {
  const open = `${command}{`;
  const sel = doc.slice(from, to);
  // the selection is the whole command: take it off
  if (sel.startsWith(open) && sel.endsWith('}') && balanced(sel.slice(open.length, -1))) {
    const inner = sel.slice(open.length, -1);
    return { from, to, insert: inner, selStart: 0, selEnd: inner.length };
  }
  // the selection sits inside the command's braces: take the command off around it
  if (sel.length && doc.slice(from - open.length, from) === open && doc[to] === '}' && balanced(sel)) {
    return { from: from - open.length, to: to + 1, insert: sel, selStart: 0, selEnd: sel.length };
  }
  // nothing selected, caret inside an empty `\command{}`: take it away again
  if (!sel.length && doc.slice(from - open.length, from) === open && doc[from] === '}') {
    return { from: from - open.length, to: from + 1, insert: '', selStart: 0, selEnd: 0 };
  }
  return { from, to, insert: `${open}${sel}}`, selStart: open.length, selEnd: open.length + sel.length };
}

/** Bold, italic, underline, superscript … for the selection, using the right command for text or math. */
export function applyFormat(doc: string, from: number, to: number, kind: FormatKind): FormatEdit {
  const math = isInMath(doc, from);
  if (kind === 'sup' || kind === 'sub') {
    const mark = kind === 'sup' ? '^' : '_';
    if (!math) return wrapWith(doc, from, to, kind === 'sup' ? '\\textsuperscript' : '\\textsubscript');
    const sel = doc.slice(from, to);
    // in math the script goes after its base: `x^{|}`; a longer selection becomes the base in braces
    const base = sel.length > 1 && !(sel.startsWith('{') && sel.endsWith('}') && balanced(sel.slice(1, -1))) ? `{${sel}}` : sel;
    const insert = `${base}${mark}{}`;
    return { from, to, insert, selStart: insert.length - 1, selEnd: insert.length - 1 };
  }
  return wrapWith(doc, from, to, (math ? MATH_COMMAND : TEXT_COMMAND)[kind]);
}

// ---- comments

/** Comment out the lines, or (if all of them already are) bring them back. Returns the new lines. */
export function toggleComment(lines: readonly string[]): string[] {
  const content = lines.filter((l) => l.trim());
  const allCommented = content.length > 0 && content.every((l) => /^\s*%/.test(l));
  if (allCommented) return lines.map((l) => l.replace(/^(\s*)% ?/, '$1'));
  const indent = Math.min(...content.map((l) => l.length - l.trimStart().length), Infinity);
  return lines.map((l) => (l.trim() ? `${l.slice(0, indent)}% ${l.slice(indent)}` : l));
}

// ---- lists

export type ListKind = 'itemize' | 'enumerate';

/** A list around the selected lines (one item each), or an empty one with the caret on its first item. */
export function makeList(selected: string, kind: ListKind): { insert: string; caret: number } {
  const lines = selected.split('\n').filter((l) => l.trim());
  if (!lines.length) {
    const head = `\\begin{${kind}}\n  \\item `;
    return { insert: `${head}\n\\end{${kind}}`, caret: head.length };
  }
  const items = lines.map((l) => `  \\item ${l.trim().replace(/^\\item\s+/, '')}`).join('\n');
  const insert = `\\begin{${kind}}\n${items}\n\\end{${kind}}`;
  return { insert, caret: insert.length };
}

// ---- headings

export const SECTION_LEVELS = ['section', 'subsection', 'subsubsection'] as const;

/** Make a line a \section (level 0), \subsection (1) or \subsubsection (2); the same level again turns it back into text. */
export function sectionLine(line: string, level: 0 | 1 | 2): string {
  const name = SECTION_LEVELS[level];
  const m = /^(\s*)\\((?:sub){0,2}section)\*?\{(.*)\}\s*$/.exec(line);
  if (m) return m[2] === name ? `${m[1]}${m[3]}` : `${m[1]}\\${name}{${m[3]}}`;
  const indent = line.length - line.trimStart().length;
  return `${line.slice(0, indent)}\\${name}{${line.trim()}}`;
}
