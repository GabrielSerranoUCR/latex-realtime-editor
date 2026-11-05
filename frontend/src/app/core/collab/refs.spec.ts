import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { applyEdits, findReferenceEdits, updateReferences } from './refs';

const fix = (src: string, from: string, to: string) => applyEdits(src, findReferenceEdits(src, from, to));

describe('findReferenceEdits', () => {
  it('follows a picture, with or without options and its ending', () => {
    expect(fix('\\includegraphics[width=0.7\\textwidth]{figures/orbit.png}', 'figures/orbit.png', 'appendix/orbit.png')).toBe('\\includegraphics[width=0.7\\textwidth]{appendix/orbit.png}');
    expect(fix('\\includegraphics{figures/orbit}', 'figures/orbit.png', 'appendix/orbit.png')).toBe('\\includegraphics{appendix/orbit}');
    expect(fix('\\includegraphics[scale=.5] { figures/orbit.png }', 'figures/orbit.png', 'a/o.png')).toBe('\\includegraphics[scale=.5] { a/o.png }');
  });

  it('follows text files named for \\input, \\include and \\subfile, keeping the ending off', () => {
    expect(fix('\\input{chapters/intro}\n\\include{chapters/intro}\n\\subfile{chapters/intro.tex}', 'chapters/intro.tex', 'part1/intro.tex')).toBe('\\input{part1/intro}\n\\include{part1/intro}\n\\subfile{part1/intro.tex}');
  });

  it('writes the ending out when the ending itself changed', () => {
    expect(fix('\\input{notes}', 'notes.tex', 'notes.txt')).toBe('\\input{notes.txt}');
  });

  it('follows bibliographies (lists), \\addbibresource, packages and classes', () => {
    expect(fix('\\bibliography{refs, extra ,more}', 'extra.bib', 'bib/extra.bib')).toBe('\\bibliography{refs, bib/extra ,more}');
    expect(fix('\\addbibresource{refs.bib}', 'refs.bib', 'bib/refs.bib')).toBe('\\addbibresource{bib/refs.bib}');
    expect(fix('\\usepackage{amsmath,preamble}', 'preamble.sty', 'styles/preamble.sty')).toBe('\\usepackage{amsmath,styles/preamble}');
    expect(fix('\\documentclass[12pt]{thesis}', 'thesis.cls', 'cls/thesis.cls')).toBe('\\documentclass[12pt]{cls/thesis}');
  });

  it('leaves other files, other commands and look-alikes alone', () => {
    const src = '\\includegraphics{figures/other.png}\n\\input{chapters/intro2}\n\\section{figures/orbit.png}\n\\label{figures/orbit.png}\nfigures/orbit.png';
    expect(findReferenceEdits(src, 'figures/orbit.png', 'x.png')).toEqual([]);
    expect(findReferenceEdits('\\includegraphics{xfigures/orbit.png}', 'figures/orbit.png', 'x.png')).toEqual([]);
    expect(findReferenceEdits('\\bibliography{refs}', 'refs.txt', 'x.txt')).toEqual([]);
  });

  it('only fills in the ending LaTeX would actually guess', () => {
    expect(findReferenceEdits('\\input{figures/orbit}', 'figures/orbit.png', 'x.png')).toEqual([]);
    expect(findReferenceEdits('\\addbibresource{refs}', 'refs.bib', 'x.bib')).toEqual([]);
  });

  it('skips commented-out references but not escaped percent signs', () => {
    expect(fix('% \\includegraphics{a.png}\n\\includegraphics{a.png}', 'a.png', 'b.png')).toBe('% \\includegraphics{a.png}\n\\includegraphics{b.png}');
    expect(fix('50\\% \\includegraphics{a.png}', 'a.png', 'b.png')).toBe('50\\% \\includegraphics{b.png}');
  });

  it('accepts a leading ./ and updates several references at once', () => {
    expect(fix('\\includegraphics{./a.png} \\includegraphics{a.png}', 'a.png', 'img/a.png')).toBe('\\includegraphics{img/a.png} \\includegraphics{img/a.png}');
  });

  it('does not mistake \\includegraphics for \\include', () => {
    expect(fix('\\include{a}\\includegraphics{a}', 'a.tex', 'b.tex')).toBe('\\include{b}\\includegraphics{a}');
  });

  it('copes with spaces in paths and nested options', () => {
    expect(fix('\\includegraphics[width=\\linewidth]{my figs/Orbit 1.png}', 'my figs/Orbit 1.png', 'figs/Orbit 1.png')).toBe('\\includegraphics[width=\\linewidth]{figs/Orbit 1.png}');
  });
});

describe('updateReferences', () => {
  const docWith = (files: Record<string, string>) => {
    const doc = new Y.Doc();
    const map = doc.getMap<Y.Text>('files');
    for (const [name, text] of Object.entries(files)) map.set(name, new Y.Text(text));
    return doc;
  };
  const read = (doc: Y.Doc, name: string) => doc.getMap<Y.Text>('files').get(name)!.toString();

  it('rewrites every file that points at it and reports what it did', () => {
    const doc = docWith({
      'main.tex': 'a\n\\includegraphics{figures/o.png}\n\\input{chapters/one}\nz',
      'chapters/one.tex': 'see \\includegraphics[width=3cm]{figures/o.png} and \\includegraphics{figures/other.png}',
      'refs.bib': '@book{x}',
    });
    expect(updateReferences(doc, 'figures/o.png', 'appendix/o.png')).toEqual({ references: 2, files: 2 });
    expect(read(doc, 'main.tex')).toBe('a\n\\includegraphics{appendix/o.png}\n\\input{chapters/one}\nz');
    expect(read(doc, 'chapters/one.tex')).toBe('see \\includegraphics[width=3cm]{appendix/o.png} and \\includegraphics{figures/other.png}');
    expect(read(doc, 'refs.bib')).toBe('@book{x}');
  });

  it('does nothing, without a stray edit, when nothing points at it', () => {
    const doc = docWith({ 'main.tex': 'hello' });
    let updates = 0;
    doc.on('update', () => updates++);
    expect(updateReferences(doc, 'a.png', 'b.png')).toEqual({ references: 0, files: 0 });
    expect(updates).toBe(0);
  });

  it('makes small edits, so another scribe\'s cursor in the same line keeps its place', () => {
    const doc = docWith({ 'main.tex': 'x \\input{old} yz' });
    const text = doc.getMap<Y.Text>('files').get('main.tex')!;
    const cursor = Y.createRelativePositionFromTypeIndex(text, text.toString().indexOf('yz'));
    updateReferences(doc, 'old.tex', 'sub/new.tex');
    const abs = Y.createAbsolutePositionFromRelativePosition(cursor, doc)!;
    expect(text.toString().slice(abs.index)).toBe('yz');
  });
});
