import { pickColumn } from './word';

describe('pickColumn', () => {
  const line = 'Everyone at this table edits the same scroll, live.';

  it('finds the clicked word in the line', () => {
    expect(pickColumn(line, 'scroll')).toBe(line.indexOf('scroll'));
    expect(pickColumn(line, 'scroll,')).toBe(line.indexOf('scroll')); // punctuation the PDF glued on
    expect(pickColumn(line, 'EVERYONE')).toBe(0);
  });

  it('does not find a word inside another, or inside a command name', () => {
    expect(pickColumn('the other theory', 'the')).toBe(0);
    expect(pickColumn('\\textbf{the} then', 'the')).toBe('\\textbf{'.length);
    expect(pickColumn('\\section{Intro}', 'section')).toBeNull();
    expect(pickColumn(line, 'tab')).toBeNull();
  });

  it('tells equal words apart by what comes before them', () => {
    const l = 'the cat saw the dog and the bird';
    expect(pickColumn(l, 'the', 'cat saw ')).toBe(l.indexOf('the dog'));
    expect(pickColumn(l, 'the', 'dog and ')).toBe(l.lastIndexOf('the'));
    expect(pickColumn(l, 'the', '')).toBe(0); // nothing to go on: the first
  });

  it('reads past commands and ligatures', () => {
    expect(pickColumn('a \\emph{red} fish and a red hat', 'red', 'and a ')).toBe('a \\emph{red} fish and a '.length);
    expect(pickColumn('an office', 'ofﬁce')).toBe(3);
  });

  it('gives up on nothing useful', () => {
    expect(pickColumn(line, '')).toBeNull();
    expect(pickColumn(line, '  ,. ')).toBeNull();
  });
});
