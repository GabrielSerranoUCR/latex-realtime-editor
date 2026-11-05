import { describe, expect, it } from 'vitest';
import { applyFormat, isInMath, makeList, sectionLine, toggleComment, wrapWith } from './format';

/** Apply an edit the way the editor does, returning the new text and the selected part. */
function run(doc: string, from: number, to: number, kind: Parameters<typeof applyFormat>[3]) {
  const e = applyFormat(doc, from, to, kind);
  const text = doc.slice(0, e.from) + e.insert + doc.slice(e.to);
  return { text, sel: text.slice(e.from + e.selStart, e.from + e.selEnd), caret: e.from + e.selStart };
}
const at = (doc: string, word: string) => [doc.indexOf(word), doc.indexOf(word) + word.length] as const;

describe('isInMath', () => {
  it('knows inline, display and environment math', () => {
    expect(isInMath('a $x', 4)).toBe(true);
    expect(isInMath('a $x$ b', 7)).toBe(false);
    expect(isInMath('a $$x', 5)).toBe(true);
    expect(isInMath('\\[ x', 4)).toBe(true);
    expect(isInMath('\\[ x \\] y', 9)).toBe(false);
    expect(isInMath('\\(x', 3)).toBe(true);
    expect(isInMath('\\begin{equation}\nE', 18)).toBe(true);
    expect(isInMath('\\begin{equation}\nE\n\\end{equation}\nafter', 36)).toBe(false);
  });

  it('is not fooled by other environments, escaped dollars or comments', () => {
    expect(isInMath('\\begin{itemize}\n x', 18)).toBe(false);
    expect(isInMath('costs \\$5 and \\$6', 17)).toBe(false);
    expect(isInMath('% a $ in a comment\nplain', 24)).toBe(false);
    expect(isInMath('\\begin{align*} a \\\\ b', 22)).toBe(true);
  });
});

describe('bold, italic, underline, mono in text', () => {
  const doc = 'Hello brave world';
  it('wraps the selection and keeps it selected', () => {
    const r = run(doc, ...at(doc, 'brave'), 'bold');
    expect(r.text).toBe('Hello \\textbf{brave} world');
    expect(r.sel).toBe('brave');
  });
  it('puts the caret between the braces when nothing is selected', () => {
    const r = run(doc, 6, 6, 'italic');
    expect(r.text).toBe('Hello \\textit{}brave world');
    expect(r.caret).toBe(6 + '\\textit{'.length);
  });
  it('does the other styles', () => {
    expect(run(doc, ...at(doc, 'brave'), 'underline').text).toBe('Hello \\underline{brave} world');
    expect(run(doc, ...at(doc, 'brave'), 'mono').text).toBe('Hello \\texttt{brave} world');
    expect(run(doc, ...at(doc, 'brave'), 'emph').text).toBe('Hello \\emph{brave} world');
  });
  it('again takes it off: selection inside the braces, or the whole command selected', () => {
    const wrapped = 'Hello \\textbf{brave} world';
    expect(run(wrapped, ...at(wrapped, 'brave'), 'bold').text).toBe(doc);
    const whole = at(wrapped, '\\textbf{brave}');
    expect(run(wrapped, ...whole, 'bold').text).toBe(doc);
    expect(run('a \\textbf{}b', 10, 10, 'bold').text).toBe('a b'); // an empty pair is taken away
  });
  it('a different style nests instead of undoing', () => {
    const wrapped = 'Hello \\textbf{brave} world';
    expect(run(wrapped, ...at(wrapped, 'brave'), 'italic').text).toBe('Hello \\textbf{\\textit{brave}} world');
  });
  it('does not mistake an unbalanced selection for a whole command', () => {
    const t = '\\textbf{a} and \\textbf{b}';
    const r = run(t, 0, t.length, 'bold');
    expect(r.text).toBe('\\textbf{\\textbf{a} and \\textbf{b}}');
  });
});

describe('in math the math commands are used', () => {
  const doc = 'Energy $E_0 = mc$ here';
  it('bold, italic and mono become \\mathbf, \\mathit, \\mathtt', () => {
    expect(run(doc, ...at(doc, 'mc'), 'bold').text).toBe('Energy $E_0 = \\mathbf{mc}$ here');
    expect(run(doc, ...at(doc, 'mc'), 'italic').text).toContain('\\mathit{mc}');
    expect(run(doc, ...at(doc, 'mc'), 'mono').text).toContain('\\mathtt{mc}');
    expect(run(doc, ...at(doc, 'mc'), 'underline').text).toContain('\\underline{mc}');
  });
});

describe('superscript and subscript', () => {
  it('in text they are \\textsuperscript and \\textsubscript', () => {
    const doc = 'H2O is water';
    expect(run(doc, 1, 2, 'sub').text).toBe('H\\textsubscript{2}O is water');
    expect(run(doc, 1, 2, 'sup').text).toBe('H\\textsuperscript{2}O is water');
  });
  it('in math they are ^{} and _{} after the base, with the caret inside', () => {
    const doc = 'Let $x$ be';
    const r = run(doc, 6, 6, 'sup');
    expect(r.text).toBe('Let $x^{}$ be'); // the caret was after the x
    expect(r.caret).toBe(6 + 2);
    const base = run(doc, 5, 6, 'sub'); // the selected x is the base
    expect(base.text).toBe('Let $x_{}$ be');
    expect(base.caret).toBe(5 + 'x_{'.length);
  });
  it('a longer selection becomes the base in braces', () => {
    const doc = '$ab + c$';
    expect(run(doc, 1, 3, 'sup').text).toBe('${ab}^{} + c$');
  });
});

describe('comments', () => {
  it('comments out lines at their indentation, and brings them back', () => {
    const lines = ['  a', '', '    b'];
    const on = toggleComment(lines);
    expect(on).toEqual(['  % a', '', '  %   b']);
    expect(toggleComment(on)).toEqual(lines);
  });
  it('comments the rest if only some are commented', () => {
    expect(toggleComment(['% a', 'b'])).toEqual(['% % a', '% b']);
  });
});

describe('lists and headings', () => {
  it('makes an empty list with the caret on the first item', () => {
    const r = makeList('', 'itemize');
    expect(r.insert).toBe('\\begin{itemize}\n  \\item \n\\end{itemize}');
    expect(r.insert.slice(0, r.caret)).toBe('\\begin{itemize}\n  \\item ');
  });
  it('turns selected lines into items', () => {
    expect(makeList('one\n\ntwo', 'enumerate').insert).toBe('\\begin{enumerate}\n  \\item one\n  \\item two\n\\end{enumerate}');
  });
  it('makes a line a section, changes the level, and undoes it', () => {
    expect(sectionLine('Introduction', 0)).toBe('\\section{Introduction}');
    expect(sectionLine('\\section{Introduction}', 1)).toBe('\\subsection{Introduction}');
    expect(sectionLine('\\subsection{Introduction}', 1)).toBe('Introduction');
    expect(sectionLine('  Intro', 2)).toBe('  \\subsubsection{Intro}');
    expect(sectionLine('\\section*{Intro}', 0)).toBe('Intro');
  });
});

describe('wrapWith', () => {
  it('works with any command', () => {
    const e = wrapWith('x', 0, 1, '\\textsc');
    expect(e.insert).toBe('\\textsc{x}');
  });
});
