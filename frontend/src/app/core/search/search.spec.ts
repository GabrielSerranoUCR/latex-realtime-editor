import { describe, expect, it } from 'vitest';
import { DEFAULT_SEARCH, MAX_MATCHES, buildMatcher, editsOf, expandTemplate, findMatches, flatHits, searchFiles, stepIndex, summary } from './search';

const files = [
  { path: 'chapters/main.tex', text: 'line one\noscillator with Hamiltonian $H = \\frac{p^2}{2m}$ here\nthree' },
  { path: 'chapters/methods.tex', text: 'x\nthe Hamiltonian is diagonalised in the basis\ny\nz\nSubstituting the Hamiltonian into (3) gives' },
  { path: 'refs.bib', text: 'nothing relevant' },
];

describe('buildMatcher', () => {
  it('has no pattern for an empty query, and treats plain text literally', () => {
    expect(buildMatcher('', DEFAULT_SEARCH)).toEqual({ re: null, error: null });
    const { re } = buildMatcher('a.b(c)', DEFAULT_SEARCH);
    expect('a.b(c) axb(c)'.match(re!)).toEqual(['a.b(c)']);
  });
  it('ignores case unless asked not to', () => {
    expect('Hamiltonian hamiltonian'.match(buildMatcher('HAMILTONIAN', DEFAULT_SEARCH).re!)).toHaveLength(2);
    expect('Hamiltonian hamiltonian'.match(buildMatcher('hamiltonian', { ...DEFAULT_SEARCH, caseSensitive: true }).re!)).toEqual(['hamiltonian']);
  });
  it('whole word does not match inside longer words', () => {
    const re = buildMatcher('cat', { ...DEFAULT_SEARCH, wholeWord: true }).re!;
    expect('cat concat cats cat_x (cat)'.match(re)).toHaveLength(2);
  });
  it('regular expressions work, and a broken one is reported instead of thrown', () => {
    expect('a1 b22'.match(buildMatcher('[a-z]\\d+', { ...DEFAULT_SEARCH, regex: true }).re!)).toEqual(['a1', 'b22']);
    expect(buildMatcher('(', { ...DEFAULT_SEARCH, regex: true })).toEqual({ re: null, error: 'That regular expression is not valid.' });
  });
});

describe('findMatches', () => {
  it('lists matches in order and skips empty ones', () => {
    const re = buildMatcher('a*', { ...DEFAULT_SEARCH, regex: true }).re!;
    expect(findMatches('baab a', re).map((m) => [m.from, m.to])).toEqual([[1, 3], [5, 6]]);
  });
  it('stops at the limit', () => {
    expect(findMatches('x'.repeat(50), buildMatcher('x', DEFAULT_SEARCH).re!, 10)).toHaveLength(10);
  });
});

describe('searchFiles', () => {
  const r = searchFiles(files, 'Hamiltonian', DEFAULT_SEARCH, 'operator');

  it('groups hits by file, in file order, with 1-based lines and columns', () => {
    expect(r.files.map((f) => [f.path, f.hits.length])).toEqual([['chapters/main.tex', 1], ['chapters/methods.tex', 2]]);
    expect(r.total).toBe(3);
    const h = r.files[1].hits;
    expect([h[0].line, h[1].line]).toEqual([2, 5]);
    expect(h[0].col).toBe(5);
    expect(summary(r, false)).toBe('3 matches in 2 files');
  });

  it('shows the match with the words around it, cut with … when the line is long', () => {
    const first = r.files[0].hits[0];
    expect(first.before).toBe('oscillator with ');
    expect(first.match).toBe('Hamiltonian');
    expect(first.after.startsWith(' $H = ')).toBe(true);
    const long = searchFiles([{ path: 'a', text: `${'word '.repeat(30)}NEEDLE${' tail'.repeat(30)}` }], 'needle', DEFAULT_SEARCH).files[0].hits[0];
    expect(long.before.startsWith('…')).toBe(true);
    expect(long.after.endsWith('…')).toBe(true);
    expect(long.before.length).toBeLessThan(40);
  });

  it('keeps what each match would become', () => {
    expect(r.files[0].hits[0].insert).toBe('operator');
  });

  it('one file only when asked, and says "in this file"', () => {
    const one = searchFiles([files[1]], 'Hamiltonian', DEFAULT_SEARCH);
    expect(summary(one, true)).toBe('2 matches in this file');
  });

  it('reports no matches, a single match, and a broken pattern', () => {
    expect(summary(searchFiles(files, 'zzz', DEFAULT_SEARCH), false)).toBe('No matches');
    expect(summary(searchFiles(files, 'relevant', DEFAULT_SEARCH), false)).toBe('1 match in 1 file');
    expect(searchFiles(files, '(', { ...DEFAULT_SEARCH, regex: true }).error).toBe('That regular expression is not valid.');
    expect(searchFiles(files, '', DEFAULT_SEARCH).total).toBe(0);
  });

  it('caps a search that matches everything', () => {
    const big = [{ path: 'a', text: 'e '.repeat(MAX_MATCHES * 2) }, { path: 'b', text: 'e' }];
    const res = searchFiles(big, 'e', DEFAULT_SEARCH);
    expect(res.total).toBe(MAX_MATCHES);
    expect(res.truncated).toBe(true);
    expect(summary(res, false)).toContain('500+');
  });

  it('flatHits lists them in the order shown', () => {
    expect(flatHits(r).map((h) => h.line)).toEqual([2, 2, 5]);
  });
});

describe('replacements', () => {
  it('expand $1, $& and $$ in regular-expression mode only', () => {
    const opts = { ...DEFAULT_SEARCH, regex: true };
    const res = searchFiles([{ path: 'a', text: 'foo=1 bar=2' }], '(\\w+)=(\\d)', opts, '$2:$1 [$&] $$');
    expect(res.files[0].hits.map((h) => h.insert)).toEqual(['1:foo [foo=1] $', '2:bar [bar=2] $']);
    const plain = searchFiles([{ path: 'a', text: 'cost' }], 'cost', DEFAULT_SEARCH, '$1 price');
    expect(plain.files[0].hits[0].insert).toBe('$1 price'); // literal
  });

  it('expandTemplate leaves unknown groups alone and fills named ones', () => {
    const re = /(?<k>a)(b)/;
    const m = re.exec('ab')!;
    expect(expandTemplate(m, '$<k>-$2-$9')).toBe('a-b-$9');
  });

  it('editsOf orders edits from the end, so applying them one by one never shifts the next', () => {
    const res = searchFiles([{ path: 'a', text: 'one two one' }], 'one', DEFAULT_SEARCH, 'ONE!');
    const edits = editsOf(res.files[0].hits);
    expect(edits.map((e) => e.from)).toEqual([8, 0]);
    let text = 'one two one';
    for (const e of edits) text = text.slice(0, e.from) + e.insert + text.slice(e.to);
    expect(text).toBe('ONE! two ONE!');
  });
});

describe('stepIndex', () => {
  it('wraps round both ways and copes with nothing', () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
});
