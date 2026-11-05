import { describe, expect, it } from 'vitest';
import { PREVIEW_LINES, viewProposal } from './proposal-view';

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
