/** Pure text analysis used by the completion sources (no CodeMirror dependency). */

export interface BibEntry {
  key: string;
  type: string;
  title?: string;
  author?: string;
  year?: string;
}

export interface LabelRef {
  label: string;
  file: string;
  line: number;
}

/** Remove `% comments` (but keep `\%`), preserving line structure and offsets loosely. */
export function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /(^|[^\\])%/.exec(line);
      return m ? line.slice(0, m.index + m[1].length) : line;
    })
    .join('\n');
}

/** Environments opened but not yet closed at the end of `text`, outermost first. */
export function openEnvironments(text: string): string[] {
  const stack: string[] = [];
  const re = /\\(begin|end)\{([^}\n]*)\}/g;
  let m: RegExpExecArray | null;
  const clean = stripComments(text);
  while ((m = re.exec(clean))) {
    const name = m[2];
    if (m[1] === 'begin') {
      stack.push(name);
    } else {
      const i = stack.lastIndexOf(name);
      if (i >= 0) stack.length = i; // closing also discards anything left open inside it
    }
  }
  return stack;
}

/** Every `\label{...}` in a file, with its 1-based line. */
export function extractLabels(file: string, text: string): LabelRef[] {
  const out: LabelRef[] = [];
  const lines = stripComments(text).split('\n');
  const re = /\\label\{([^}\s]+)\}/g;
  lines.forEach((line, i) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) out.push({ label: m[1], file, line: i + 1 });
  });
  return out;
}

/** Entries of a BibTeX file: `@article{key, author = {...}, title = {...}, year = 2020}`. */
export function extractBibEntries(text: string): BibEntry[] {
  const out: BibEntry[] = [];
  const head = /@(\w+)\s*[{(]\s*([^,\s]+)\s*,/g;
  const starts: Array<{ type: string; key: string; at: number; bodyAt: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = head.exec(text))) {
    const type = m[1].toLowerCase();
    if (['comment', 'string', 'preamble'].includes(type)) continue;
    starts.push({ type, key: m[2], at: m.index, bodyAt: head.lastIndex });
  }
  starts.forEach((s, i) => {
    const body = text.slice(s.bodyAt, starts[i + 1]?.at ?? text.length);
    const field = (name: string) => {
      const f = new RegExp(`\\b${name}\\s*=\\s*(?:\\{((?:[^{}]|\\{[^{}]*\\})*)\\}|"([^"]*)"|(\\w+))`, 'i').exec(body);
      return f ? (f[1] ?? f[2] ?? f[3])?.replace(/\s+/g, ' ').trim() : undefined;
    };
    out.push({ key: s.key, type: s.type, title: field('title'), author: field('author'), year: field('year') });
  });
  return out;
}

/** Keys declared with `\bibitem{key}` in a thebibliography environment. */
export function extractBibItems(text: string): string[] {
  return Array.from(stripComments(text).matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}\s]+)\}/g), (m) => m[1]);
}

/** "Griffiths and Schroeter" -> "Griffiths"; "Griffiths, D. J. and Others" -> "Griffiths". */
export function firstAuthorSurname(author?: string): string | undefined {
  if (!author) return undefined;
  const first = author.split(/\s+and\s+/i)[0].trim();
  if (first.includes(',')) return first.split(',')[0].trim();
  const parts = first.split(/\s+/);
  return parts[parts.length - 1];
}
