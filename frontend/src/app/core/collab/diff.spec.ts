import { describe, expect, it } from 'vitest';
import { SAFETY_LABEL, compareFiles, countChanges, describeVersion, diffLines, foldContext, kindOf, splitLines, totals, whenLabel } from './diff';

const d = (cur: string, old: string, maxEdits?: number) => diffLines(splitLines(cur), splitLines(old), maxEdits);
const shape = (lines: ReturnType<typeof diffLines>) => lines.map((l) => `${l.type === 'same' ? ' ' : l.type === 'add' ? '+' : '-'}${l.text}`);

describe('diffLines', () => {
  it('is all "same" for equal text', () => {
    expect(shape(d('a\nb', 'a\nb'))).toEqual([' a', ' b']);
  });
  it('marks what restoring would bring back (+) and drop (-)', () => {
    // current has "new", the old version had "old": restoring removes "new" and adds "old"
    expect(shape(d('a\nnew\nz', 'a\nold\nz'))).toEqual([' a', '-new', '+old', ' z']);
  });
  it('handles pure additions, pure deletions and empty sides', () => {
    expect(shape(d('a\nc', 'a\nb\nc'))).toEqual([' a', '+b', ' c']);
    expect(shape(d('a\nb\nc', 'a\nc'))).toEqual([' a', '-b', ' c']);
    expect(shape(d('', 'x\ny'))).toEqual(['+x', '+y']);
    expect(shape(d('x\ny', ''))).toEqual(['-x', '-y']);
    expect(d('', '')).toEqual([]);
  });
  it('finds a minimal diff, not just the trimmed ends', () => {
    expect(countChanges(d('a\nb\nc\nd\ne', 'a\nc\nd\nx\ne'))).toEqual({ add: 1, del: 1 });
    expect(countChanges(d('1\n2\n3\n4\n5\n6', '2\n3\n5\n6\n7'))).toEqual({ add: 1, del: 2 });
  });
  it('numbers lines from each side', () => {
    const lines = d('a\nnew\nz', 'a\nold\nz');
    expect(lines.map((l) => [l.old, l.now])).toEqual([[1, 1], [undefined, 2], [2, undefined], [3, 3]]);
  });
  it('falls back to one replaced block when too many lines changed', () => {
    const lines = d('a\nx1\nx2\nz', 'a\ny1\ny2\nz', 1);
    expect(shape(lines)).toEqual([' a', '-x1', '-x2', '+y1', '+y2', ' z']);
  });
  it('copes with repeated lines and reconstructs both sides exactly', () => {
    const cur = 'a\na\nb\na\nc\nc'.split('\n');
    const old = 'a\nb\nb\na\nc\nd'.split('\n');
    const lines = diffLines(cur, old);
    expect(lines.filter((l) => l.type !== 'add').map((l) => l.text)).toEqual(cur);
    expect(lines.filter((l) => l.type !== 'del').map((l) => l.text)).toEqual(old);
  });
  it('handles a few thousand lines quickly', () => {
    const cur = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const old = cur.filter((_, i) => i % 50 !== 0).concat(['tail']);
    const t = Date.now();
    const lines = diffLines(cur, old);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(countChanges(lines)).toEqual({ add: 1, del: 60 });
  });
});

describe('compareFiles', () => {
  const now = new Map([['main.tex', 'a\nb'], ['same.tex', 'x'], ['new.tex', 'n1\nn2\nn3']]);
  const old = new Map([['main.tex', 'a\nc\nd'], ['same.tex', 'x'], ['gone.tex', 'g1\ng2']]);
  it('says what restoring would do to every file', () => {
    expect(compareFiles(now, old)).toEqual([
      { path: 'gone.tex', status: 'added', add: 2, del: 0 },
      { path: 'main.tex', status: 'changed', add: 2, del: 1 },
      { path: 'new.tex', status: 'removed', add: 0, del: 3 },
      { path: 'same.tex', status: 'same', add: 0, del: 0 },
    ]);
  });
  it('totals changed files and lines', () => expect(totals(compareFiles(now, old))).toEqual({ files: 3, add: 4, del: 4 }));
});

describe('foldContext', () => {
  const lines = (spec: string) => spec.split('').map((c, i) => ({ type: c === '+' ? 'add' : c === '-' ? 'del' : 'same', text: String(i), now: i + 1, old: i + 1 }) as const);
  it('keeps context around changes and folds the long stretches between', () => {
    const rows = foldContext(lines('.'.repeat(20) + '+' + '.'.repeat(20)));
    expect(rows.filter((r) => r.kind === 'fold').map((r) => (r.kind === 'fold' ? r.lines.length : 0))).toEqual([17, 17]);
    expect(rows.filter((r) => r.kind === 'line')).toHaveLength(3 + 1 + 3);
  });
  it('does not fold short runs', () => expect(foldContext(lines('..+..')).every((r) => r.kind === 'line')).toBe(true));
  it('leaves a file without changes in one piece when short, folds it when long', () => {
    expect(foldContext(lines('...')).map((r) => r.kind)).toEqual(['line', 'line', 'line']);
    expect(foldContext(lines('.'.repeat(30))).map((r) => r.kind)).toEqual(['fold']);
  });
});

describe('timeline text', () => {
  const now = new Date(2026, 10, 5, 15, 0); // Thu 5 Nov 2026
  it('labels times relative to today', () => {
    expect(whenLabel(new Date(2026, 10, 5, 14, 32).toISOString(), now)).toBe('Today · 14:32');
    expect(whenLabel(new Date(2026, 10, 4, 18, 4).toISOString(), now)).toBe('Yesterday · 18:04');
    expect(whenLabel(new Date(2026, 10, 2, 16, 45).toISOString(), now)).toBe('Mon · 16:45');
    expect(whenLabel(new Date(2026, 9, 12, 9, 20).toISOString(), now)).toBe('12 Oct · 09:20');
    expect(whenLabel(new Date(2025, 11, 1, 9, 5).toISOString(), now)).toBe('1 Dec 2025 · 09:05');
  });
  it('describes who and what kind', () => {
    expect(describeVersion({ label: 'Draft 1', auto: false, authorName: 'Aelith' })).toBe('Aelith · “Draft 1”');
    expect(describeVersion({ label: null, auto: true, authorName: 'Marcus' })).toBe('Marcus · auto-saved');
    expect(describeVersion({ label: null, auto: true, authorName: null })).toBe('Auto-saved');
    expect(describeVersion({ label: SAFETY_LABEL, auto: false, authorName: 'Aelith' })).toBe('Aelith · saved before a restore');
    expect(kindOf({ label: SAFETY_LABEL, auto: false, authorName: null })).toBe('safety');
  });
});
