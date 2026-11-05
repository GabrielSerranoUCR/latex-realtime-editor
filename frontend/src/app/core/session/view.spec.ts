import { describe, expect, it } from 'vitest';
import { windowLines } from './view';

const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');

describe('windowLines', () => {
  it('shows only a screenful around the focus, numbered from 1', () => {
    const w = windowLines(text, text.indexOf('line 50'), null, 20);
    expect(w.totalLines).toBe(100);
    expect(w.lines).toHaveLength(20);
    expect(w.lines.some((l) => l.n === 50)).toBe(true);
    expect(w.lines[0].n).toBeGreaterThan(30);
    expect(w.lines[0].segs).toEqual([{ text: `line ${w.lines[0].n}`, mark: false }]);
  });

  it('starts at the top and ends at the bottom without running off', () => {
    expect(windowLines(text, 0, null, 20).lines[0].n).toBe(1);
    const end = windowLines(text, text.length, null, 20);
    expect(end.lines.at(-1)?.n).toBe(100);
    expect(end.lines).toHaveLength(20);
  });

  it('marks the text just typed, inside its line', () => {
    const from = text.indexOf('line 3') + 2; // "ne 3" onwards
    const w = windowLines(text, from, { from, to: from + 4 }, 20);
    const l3 = w.lines.find((l) => l.n === 3)!;
    expect(l3.segs).toEqual([{ text: 'li', mark: false }, { text: 'ne 3', mark: true }]);
  });

  it('marks a passage that runs over several lines', () => {
    const from = text.indexOf('line 2') + 5;
    const to = text.indexOf('line 4') + 3;
    const w = windowLines(text, from, { from, to }, 20);
    expect(w.lines.find((l) => l.n === 2)!.segs.at(-1)).toEqual({ text: '2', mark: true });
    expect(w.lines.find((l) => l.n === 3)!.segs).toEqual([{ text: 'line 3', mark: true }]);
    expect(w.lines.find((l) => l.n === 4)!.segs[0]).toEqual({ text: 'lin', mark: true });
  });

  it('copes with an empty file', () => {
    const w = windowLines('', 0, null);
    expect(w.lines).toEqual([{ n: 1, segs: [{ text: '', mark: false }] }]);
  });
});
