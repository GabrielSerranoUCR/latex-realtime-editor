import { describe, expect, it } from 'vitest';
import { PREVIEW_LINES, applyEdit, reviewProposal, toHunks, viewProposal } from './proposal-view';
import { diffLines, splitLines } from './diff';
const fl = (t: string) => splitLines(t.endsWith('\n') ? t.slice(0, -1) : t);

const base = { oldText: null, newText: null, replaceAll: false, content: null, path: 'main.tex' } as const;

describe('viewProposal', () => {
  it('shows an edit as lines that go and lines that come', () => {
    const v = viewProposal({ ...base, kind: 'edit', oldText: 'alpha\nbeta', newText: 'alpha\ngamma' });
    expect(v.title).toBe('Changes a passage in main.tex');
    expect(v.lines.some((l) => l.type === 'same' && l.text === 'alpha')).toBe(true);
    expect(v.lines.find((l) => l.type === 'add')?.text).toBe('gamma');
    expect(v.lines.find((l) => l.type === 'del')?.text).toBe('beta');
  });

  it('says when it changes every match', () => {
    expect(viewProposal({ ...base, kind: 'edit', replaceAll: true, oldText: 'a', newText: 'b' }).title).toContain('every match');
  });

  it('shows a whole-file write as all new lines, and cuts a long one short', () => {
    const content = Array.from({ length: PREVIEW_LINES + 12 }, (_, i) => `line ${i}`).join('\n');
    const v = viewProposal({ ...base, kind: 'write', content });
    expect(v.title).toBe('Writes main.tex (the whole file)');
    expect(v.lines).toHaveLength(PREVIEW_LINES);
    expect(v.lines.every((l) => l.type === 'add')).toBe(true);
    expect(v.hidden).toBe(12);
  });

  it('a delete has nothing to show but its title', () => {
    const v = viewProposal({ ...base, kind: 'delete', path: 'old.tex' });
    expect(v.title).toBe('Deletes old.tex');
    expect(v.lines).toEqual([]);
  });
});

describe('reviewProposal (drawn like git diff)', () => {
  const file = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

  it('draws an edit against the file as it is, with line numbers and context', () => {
    const r = reviewProposal({ ...base, kind: 'edit', oldText: 'line 10', newText: 'TEN' }, file);
    expect(r.action).toBe('edit');
    expect([r.add, r.del]).toEqual([1, 1]);
    expect(r.hunks).toHaveLength(1);
    expect(r.hunks[0].header).toBe('@@ -7,7 +7,7 @@');
    const del = r.hunks[0].rows.find((x) => x.type === 'del');
    const add = r.hunks[0].rows.find((x) => x.type === 'add');
    expect([del?.text, del?.now, del?.next]).toEqual(['line 10', 10, undefined]);
    expect([add?.text, add?.now, add?.next]).toEqual(['TEN', undefined, 10]);
    expect(r.hunks[0].rows.filter((x) => x.type === 'same')).toHaveLength(6);
  });

  it('splits distant changes into separate hunks and merges near ones', () => {
    const far = reviewProposal({ ...base, kind: 'edit', replaceAll: true, oldText: 'line 2\n', newText: 'x\n' }, file);
    expect(far.hunks).toHaveLength(1);
    const lines = diffLines(fl(file), fl(file.replace('line 2\n', 'two\n').replace('line 18\n', 'eighteen\n')));
    const hunks = toHunks(lines);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].header).toBe('@@ -1,5 +1,5 @@');
    expect(hunks[1].header).toBe('@@ -15,6 +15,6 @@');
    expect(toHunks(diffLines(fl(file), fl(file.replace('line 2\n', 'two\n').replace('line 6\n', 'six\n'))))).toHaveLength(1);
  });

  it('a new file is all additions; a rewrite is a diff against the old text; a delete is all removals', () => {
    const made = reviewProposal({ ...base, kind: 'write', content: 'a\nb\n' }, null);
    expect([made.action, made.add, made.del, made.hunks[0].header]).toEqual(['create', 2, 0, '@@ -0,0 +1,2 @@']);
    const over = reviewProposal({ ...base, kind: 'write', content: 'a\nB\n' }, 'a\nb\n');
    expect([over.action, over.add, over.del]).toEqual(['rewrite', 1, 1]);
    const gone = reviewProposal({ ...base, kind: 'delete' }, 'a\nb\n');
    expect([gone.action, gone.add, gone.del, gone.hunks[0].header]).toEqual(['delete', 0, 2, '@@ -1,2 +0,0 @@']);
  });

  it('says so when the text moved on, and falls back to the snippet', () => {
    const r = reviewProposal({ ...base, kind: 'edit', oldText: 'alpha', newText: 'beta' }, 'nothing here\n');
    expect(r.stale).toContain('no longer in the file');
    expect(r.fallback?.lines.some((l) => l.type === 'add' && l.text === 'beta')).toBe(true);
    expect(reviewProposal({ ...base, kind: 'edit', oldText: 'a', newText: 'b' }, null).stale).toContain('not in the scroll');
    expect(reviewProposal({ ...base, kind: 'delete' }, null).stale).toContain('not in the scroll');
  });

  it('applyEdit mirrors the server: one match, or all of them on request', () => {
    expect(applyEdit('a b a', 'b', 'X', false)).toEqual({ text: 'a X a' });
    expect('error' in applyEdit('a b a', 'a', 'X', false)).toBe(true);
    expect(applyEdit('a b a', 'a', 'X', true)).toEqual({ text: 'X b X' });
    expect('error' in applyEdit('abc', 'zz', 'X', false)).toBe(true);
    expect(applyEdit('abc', 'b', '', false)).toEqual({ text: 'ac' });
  });
});

describe('sideBySide', () => {
  it('puts a removed run across from the added run that follows it', async () => {
    const { sideBySide } = await import('./proposal-view');
    const rows = sideBySide([
      { type: 'same', text: 'a', now: 1, next: 1 },
      { type: 'del', text: 'b', now: 2 },
      { type: 'add', text: 'B', next: 2 },
      { type: 'add', text: 'C', next: 3 },
    ]);
    expect(rows.length).toBe(3);
    expect(rows[1].left).toEqual({ no: 2, text: 'b', del: true });
    expect(rows[1].right).toEqual({ no: 2, text: 'B', add: true });
    expect(rows[2].left).toBeNull();
    expect(rows[2].right?.text).toBe('C');
  });
});
