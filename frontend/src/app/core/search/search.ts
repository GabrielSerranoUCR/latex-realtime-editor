/** Search and replace across the files of a scroll: pure functions over strings. */

export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
}

export const DEFAULT_SEARCH: SearchOptions = { caseSensitive: false, regex: false, wholeWord: false };

/** Most matches collected in one search (a stray "e" would otherwise list the whole scroll). */
export const MAX_MATCHES = 500;
/** Characters of the line shown before and after a match in the results. */
const CONTEXT_BEFORE = 28;
const CONTEXT_AFTER = 44;
const MAX_SHOWN_MATCH = 80;

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Matcher {
  re: RegExp | null;
  /** Why the query cannot be used (a regular expression that does not parse). */
  error: string | null;
}

/** The pattern for what was typed; null `re` for an empty query. */
export function buildMatcher(query: string, opts: SearchOptions): Matcher {
  if (!query) return { re: null, error: null };
  let source = opts.regex ? query : escapeRegex(query);
  if (opts.wholeWord) source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`;
  try {
    return { re: new RegExp(source, `gm${opts.caseSensitive ? '' : 'i'}`), error: null };
  } catch {
    return { re: null, error: 'That regular expression is not valid.' };
  }
}

export interface Hit {
  path: string;
  from: number;
  to: number;
  /** 1-based line and column of the start. */
  line: number;
  col: number;
  /** The line around the match, cut to a readable length: text before, the match, text after. */
  before: string;
  match: string;
  after: string;
  /** What this match becomes when replaced. */
  insert: string;
}

/** `$&`, `$1`… `$<name>` and `$$` in a replacement, for regular-expression searches. */
export function expandTemplate(m: RegExpExecArray, template: string): string {
  return template.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g, (whole, what: string) => {
    if (what === '$') return '$';
    if (what === '&') return m[0];
    if (what.startsWith('<')) return m.groups?.[what.slice(1, -1)] ?? '';
    const n = Number(what);
    return n >= 1 && n < m.length ? (m[n] ?? '') : whole;
  });
}

/** Every match of `re` in `text`, in order (empty matches are skipped). */
export function findMatches(text: string, re: RegExp, limit = MAX_MATCHES): Array<{ from: number; to: number; m: RegExpExecArray }> {
  const out: Array<{ from: number; to: number; m: RegExpExecArray }> = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push({ from: m.index, to: m.index + m[0].length, m });
  }
  re.lastIndex = 0;
  return out;
}

/** Where each line of `text` starts, for turning a position into a line number. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo; // 0-based
}

export interface FileHits {
  path: string;
  hits: Hit[];
}

export interface SearchResult {
  error: string | null;
  files: FileHits[];
  total: number;
  /** True if there were more matches than `MAX_MATCHES`. */
  truncated: boolean;
}

export const NO_RESULT: SearchResult = { error: null, files: [], total: 0, truncated: false };

/**
 * Search the given files. `replacement` is what each match would become (shown nowhere, but kept on the
 * hit so "Replace" and "Replace all" do exactly what the list promised).
 */
export function searchFiles(files: ReadonlyArray<{ path: string; text: string }>, query: string, opts: SearchOptions, replacement = ''): SearchResult {
  const { re, error } = buildMatcher(query, opts);
  if (!re) return { ...NO_RESULT, error };
  const out: FileHits[] = [];
  let total = 0;
  let truncated = false;
  for (const f of files) {
    if (total >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    const found = findMatches(f.text, re, MAX_MATCHES - total + 1);
    if (!found.length) continue;
    const starts = lineStarts(f.text);
    const hits: Hit[] = [];
    for (const { from, to, m } of found) {
      if (total >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      const li = lineOf(starts, from);
      const lineStart = starts[li];
      const lineEnd = li + 1 < starts.length ? starts[li + 1] - 1 : f.text.length;
      const col = from - lineStart;
      const b0 = Math.max(lineStart, from - CONTEXT_BEFORE);
      const a1 = Math.min(lineEnd, to + CONTEXT_AFTER);
      const shown = f.text.slice(from, Math.min(to, lineEnd));
      hits.push({
        path: f.path,
        from,
        to,
        line: li + 1,
        col: col + 1,
        before: (b0 > lineStart ? '…' : '') + f.text.slice(b0, from).replace(/^\s+/, b0 === lineStart ? '' : ' '),
        match: shown.length > MAX_SHOWN_MATCH ? shown.slice(0, MAX_SHOWN_MATCH) + '…' : shown,
        after: f.text.slice(Math.min(to, lineEnd), a1) + (a1 < lineEnd ? '…' : ''),
        insert: opts.regex ? expandTemplate(m, replacement) : replacement,
      });
      total++;
    }
    out.push({ path: f.path, hits });
  }
  return { error: null, files: out, total, truncated };
}

/** All hits of a result in the order they are listed. */
export const flatHits = (r: SearchResult): Hit[] => r.files.flatMap((f) => f.hits);

/** "3 matches in 2 files", "No matches", "500+ matches in 4 files". */
export function summary(r: SearchResult, thisFileOnly: boolean): string {
  if (!r.total) return 'No matches';
  const n = r.truncated ? `${r.total}+` : String(r.total);
  const matches = `${n} ${r.total === 1 && !r.truncated ? 'match' : 'matches'}`;
  return thisFileOnly ? `${matches} in this file` : `${matches} in ${r.files.length} ${r.files.length === 1 ? 'file' : 'files'}`;
}

/** The text with every hit replaced: the edits to apply from the end towards the start. */
export const editsOf = (hits: readonly Hit[]): Array<{ from: number; to: number; insert: string }> => hits.map((h) => ({ from: h.from, to: h.to, insert: h.insert })).sort((a, b) => b.from - a.from);

/** Move through the hits, wrapping round at either end. */
export function stepIndex(current: number, count: number, dir: 1 | -1): number {
  if (!count) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}
