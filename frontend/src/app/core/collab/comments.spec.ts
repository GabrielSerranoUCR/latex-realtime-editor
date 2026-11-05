import { describe, expect, it } from 'vitest';
import { cleanNote, countOpen, insertMention, lineOf, mentionQuery, noteRange, quoteFor, sortLocated, splitMentions, suggestScribes } from './comments';

const text = 'first line\nsecond line is a bit longer\n\nfourth';

describe('lineOf', () => {
  it('counts lines from 1', () => {
    expect(lineOf(text, 0)).toBe(1);
    expect(lineOf(text, 11)).toBe(2);
    expect(lineOf(text, text.length)).toBe(4);
    expect(lineOf(text, 9999)).toBe(4);
    expect(lineOf(text, -3)).toBe(1);
  });
});

describe('noteRange', () => {
  it('keeps a selection (either direction)', () => {
    expect(noteRange(text, 2, 7)).toEqual({ from: 2, to: 7 });
    expect(noteRange(text, 7, 2)).toEqual({ from: 2, to: 7 });
  });
  it('widens a bare caret to its whole line', () => {
    expect(noteRange(text, 14)).toEqual({ from: 11, to: 38 });
    expect(noteRange(text, 0)).toEqual({ from: 0, to: 10 });
    expect(noteRange(text, 11)).toEqual({ from: 11, to: 38 });
    expect(noteRange(text, text.length)).toEqual({ from: 40, to: text.length });
    expect(noteRange(text, 39)).toEqual({ from: 39, to: 39 }); // an empty line
  });
});

describe('quoteFor', () => {
  it('quotes the selection on one line, or the caret line', () => {
    expect(quoteFor(text, 0, 5)).toBe('first');
    expect(quoteFor(text, 3, 3)).toBe('first line');
    expect(quoteFor(text, 14, 14)).toBe('second line is a bit longer');
    expect(quoteFor('a\n\n  b   c  ', 0, 12)).toBe('a b c');
  });
  it('shortens long quotes with an ellipsis', () => {
    const q = quoteFor('x'.repeat(200), 0, 200);
    expect(q.length).toBeLessThanOrEqual(60);
    expect(q.endsWith('…')).toBe(true);
  });
});

describe('mentions', () => {
  const names = ['Aelith', 'Marcus Reed', 'Marcus'];
  it('finds @mentions of known scribes, longest name first', () => {
    expect(splitMentions('hi @Marcus Reed and @aelith, see @nobody', names)).toEqual([
      { text: 'hi ', mention: false },
      { text: '@Marcus Reed', mention: true, you: false },
      { text: ' and ', mention: false },
      { text: '@aelith', mention: true, you: false },
      { text: ', see @nobody', mention: false },
    ]);
  });
  it('flags a mention of you and ignores e-mail-like text and longer words', () => {
    expect(splitMentions('@Aelith', names, 'Aelith')[0].you).toBe(true);
    expect(splitMentions('mail me@Aelith.test', names).every((s) => !s.mention)).toBe(true);
    expect(splitMentions('@Aelithia', names).every((s) => !s.mention)).toBe(true);
  });
  it('knows when the caret is inside an @mention being typed', () => {
    expect(mentionQuery('hello @Ma', 9)).toEqual({ start: 6, query: 'Ma' });
    expect(mentionQuery('hello @', 7)).toEqual({ start: 6, query: '' });
    expect(mentionQuery('@a', 2)).toEqual({ start: 0, query: 'a' });
    expect(mentionQuery('mail me@x', 9)).toBeNull();
    expect(mentionQuery('no mention', 10)).toBeNull();
    expect(mentionQuery('hello @Ma\nand more', 18)).toBeNull();
    // names may contain spaces, so a long tail still counts as a query (it just matches no scribe)
    expect(mentionQuery('hello @Ma and more', 18)?.query).toBe('Ma and more');
  });
  it('suggests names that start with, then contain, what was typed', () => {
    expect(suggestScribes(['Aelith', 'Marcus', 'Gabriel Marsh'], 'mar')).toEqual(['Marcus', 'Gabriel Marsh']);
    expect(suggestScribes(['A', 'B'], '')).toEqual(['A', 'B']);
    expect(suggestScribes(['A', 'A', 'B'], 'a')).toEqual(['A']);
    expect(suggestScribes(['Aelith'], 'z')).toEqual([]);
  });
  it('inserts the chosen name and moves the caret after it', () => {
    expect(insertMention('hello @Ma and', 9, 6, 'Marcus Reed')).toEqual({ text: 'hello @Marcus Reed  and', caret: 19 });
  });
});

describe('sorting and counting', () => {
  const at = (file: string, from: number | null, createdAt = 1) => ({ thread: { file, createdAt }, line: from === null ? null : 1, lost: from === null, from, to: from });
  it('puts the open file first, then by position, unplaced last', () => {
    const sorted = sortLocated([at('b.tex', 5), at('a.tex', 50), at('a.tex', null), at('a.tex', 10), at('c.tex', 1)], 'b.tex');
    expect(sorted.map((s) => `${s.thread.file}:${s.from}`)).toEqual(['b.tex:5', 'a.tex:10', 'a.tex:50', 'a.tex:null', 'c.tex:1']);
  });
  it('counts open threads', () => expect(countOpen([{ resolved: false }, { resolved: true }, { resolved: false }])).toBe(2));
});

describe('cleanNote', () => {
  it('trims, normalises and bounds', () => {
    expect(cleanNote('  hi\r\nthere  ')).toBe('hi\nthere');
    expect(cleanNote('   \n ')).toBeNull();
    expect(cleanNote('x'.repeat(5000))!.length).toBe(2000);
  });
});
