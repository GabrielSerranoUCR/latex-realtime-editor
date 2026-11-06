/** From a double-click on the PDF to a place inside a source line: which occurrence of the clicked word. */

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;

/** The words one can read in some LaTeX: command names and braces are not words. */
function wordsOf(text: string): string[] {
  const plain = text.replace(/\\[a-zA-Z@]+\*?/g, ' ').replace(/\\./g, ' ');
  return (plain.match(WORD) ?? []).map((w) => w.toLowerCase());
}

/** A PDF puts "ﬁ" and friends where the source has "fi", and soft hyphens where it has none. */
const clean = (s: string): string => s.normalize('NFKC').replace(/­/g, '').trim();

/**
 * 0-based column in `line` of the word the reader double-clicked, or null when it cannot be found.
 * `word` is the clicked word as the PDF has it; `before` is the text just before it on the PDF's line, used to tell
 * apart several occurrences of the same word ("the" … "the"): the one whose own neighbours match wins.
 */
export function pickColumn(line: string, word: string, before = ''): number | null {
  const w = clean(word).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!w || w.length > 60) return null;
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}\\\\])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
  const hits = [...line.matchAll(re)].map((m) => m.index!);
  if (hits.length <= 1) return hits[0] ?? null;

  const wanted = wordsOf(clean(before)).slice(-3);
  if (!wanted.length) return hits[0];
  let best = hits[0];
  let bestScore = -1;
  for (const at of hits) {
    const seen = wordsOf(line.slice(0, at)).slice(-3);
    let score = 0;
    for (let i = 1; i <= Math.min(wanted.length, seen.length); i++) {
      if (wanted[wanted.length - i] !== seen[seen.length - i]) break;
      score++;
    }
    if (score > bestScore) {
      best = at;
      bestScore = score;
    }
  }
  return best;
}

/** 1-based column on `line` (1-based) of `source`, for the word under a double-click, or null to land at the line's start. */
export function columnIn(source: string, line: number, p: { word?: string; before?: string }): number | null {
  if (!p.word) return null;
  const text = source.split('\n')[line - 1];
  if (text === undefined) return null;
  const at = pickColumn(text, p.word, p.before ?? '');
  return at === null ? null : at + 1;
}
