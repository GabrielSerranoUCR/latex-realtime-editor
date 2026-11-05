import { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { extractBibEntries, extractBibItems, extractLabels, firstAuthorSurname, openEnvironments, stripComments } from './analysis';
import { ProjectSource, latexCompletions } from './completions';

/** Run every source at the `|` in `doc` and return the first non-null result. */
async function complete(docWithCursor: string, files: Record<string, string> = {}, more: Partial<ProjectSource> = {}): Promise<CompletionResult | null> {
  const pos = docWithCursor.indexOf('|');
  const doc = docWithCursor.replace('|', '');
  const state = EditorState.create({ doc });
  const project: ProjectSource = { paths: () => Object.keys(files), read: (p) => files[p] ?? '', ...more };
  for (const source of latexCompletions(project)) {
    const r = await source(new CompletionContext(state, pos, true));
    if (r) return r;
  }
  return null;
}
const labels = (r: CompletionResult | null) => (r?.options ?? []).map((o) => o.label);

describe('analysis', () => {
  it('strips comments but keeps escaped percent signs', () => {
    expect(stripComments('a % b\n50\\% sure % no')).toBe('a \n50\\% sure ');
  });

  it('tracks open environments, ignoring comments and closing out-of-order', () => {
    expect(openEnvironments('\\begin{document}\\begin{itemize}\\item x\\begin{center}')).toEqual(['document', 'itemize', 'center']);
    expect(openEnvironments('\\begin{a}\\begin{b}\\end{b}\\end{a}')).toEqual([]);
    expect(openEnvironments('% \\begin{ghost}\n\\begin{real}')).toEqual(['real']);
    expect(openEnvironments('\\begin{a}\\begin{b}\\end{a}')).toEqual([]);
  });

  it('finds labels with file and line', () => {
    expect(extractLabels('m.tex', 'x\n\\label{eq:one} \\label{fig:two}\n% \\label{no}')).toEqual([
      { label: 'eq:one', file: 'm.tex', line: 2 },
      { label: 'fig:two', file: 'm.tex', line: 2 },
    ]);
  });

  it('parses bib entries, skipping @comment/@string', () => {
    const bib = `@string{x = "y"}
@article{griffiths2018,
  author  = {Griffiths, D. J. and Schroeter, D. F.},
  title   = {Introduction to {Q}uantum
             Mechanics},
  year    = 2018
}
@book{shankar1994, author = "Shankar, R.", title = "Principles", year = {1994}}`;
    const e = extractBibEntries(bib);
    expect(e.map((x) => x.key)).toEqual(['griffiths2018', 'shankar1994']);
    expect(e[0]).toMatchObject({ type: 'article', year: '2018', title: 'Introduction to {Q}uantum Mechanics' });
    expect(firstAuthorSurname(e[0].author)).toBe('Griffiths');
    expect(firstAuthorSurname('Richard Feynman and Others')).toBe('Feynman');
    expect(e[1].title).toBe('Principles');
  });

  it('finds \\bibitem keys', () => {
    expect(extractBibItems('\\bibitem{a} x \\bibitem[Foo]{b}')).toEqual(['a', 'b']);
  });
});

describe('latex completion sources', () => {
  it('offers commands after a backslash, with snippet bodies', async () => {
    const r = await complete('Hello \\sec|');
    expect(r!.from).toBe(6);
    expect(labels(r)).toContain('\\section');
    expect(labels(r)).toContain('\\alpha');
  });

  it('does not complete inside comments or after a line break `\\\\`', async () => {
    expect(await complete('% todo \\sec|')).toBeNull();
    expect(await complete('a \\\\|')).toBeNull();
  });

  it('offers environments after \\begin{', async () => {
    const r = await complete('\\begin{eq|}');
    expect(labels(r)).toEqual(expect.arrayContaining(['equation', 'equation*', 'itemize']));
    expect(r!.from).toBe(7);
    expect(r!.to).toBeUndefined(); // range stays [from, cursor] so CodeMirror can filter by what was typed
  });

  it('suggests the innermost open environment first after \\end{', async () => {
    const r = await complete('\\begin{document}\n\\begin{itemize}\n\\item a\n\\end{|');
    expect(labels(r).slice(0, 2)).toEqual(['itemize', 'document']);
    expect(r!.options[0].detail).toMatch(/innermost/);
  });

  it('completes package names, including after commas and options', async () => {
    expect(labels(await complete('\\usepackage{amsm|'))).toContain('amsmath');
    const r = await complete('\\usepackage[utf8]{inputenc, graph|');
    expect(r!.from).toBe('\\usepackage[utf8]{inputenc, '.length);
    expect(labels(r)).toContain('graphicx');
  });

  it('completes document classes', async () => {
    expect(labels(await complete('\\documentclass[12pt]{art|'))).toContain('article');
  });

  it('completes \\ref/\\eqref/\\cref with labels from every file in the project', async () => {
    const files = { 'main.tex': '\\label{sec:intro}', 'chapters/b.tex': 'x\n\\label{eq:energy}', 'notes.txt': '\\label{ignored}' };
    const r = await complete('See \\cref{sec:intro, eq:|', files);
    expect(labels(r).sort()).toEqual(['eq:energy', 'sec:intro']);
    expect(r!.options.find((o) => o.label === 'eq:energy')!.detail).toBe('chapters/b.tex:2');
    expect(labels(await complete('\\eqref{|', files)).length).toBe(2);
  });

  it('completes \\cite keys from .bib files with author/year detail and title info', async () => {
    const files = { 'refs.bib': '@article{griffiths2018, author={Griffiths, D.}, title={Quantum Mechanics}, year=2018}' };
    const r = await complete('\\citep[p.~3]{grif|', files);
    expect(labels(r)).toEqual(['griffiths2018']);
    expect(r!.options[0]).toMatchObject({ detail: 'Griffiths 2018', info: 'Quantum Mechanics' });
  });

  it('completes file paths for \\input and \\includegraphics', async () => {
    const files = { 'main.tex': '', 'chapters/intro.tex': '', 'figures/orbit.png': '', 'refs.bib': '' };
    expect(labels(await complete('\\input{chap|', files)).sort()).toEqual(['chapters/intro', 'main']);
    expect(labels(await complete('\\includegraphics[width=5cm]{fig|', files))).toEqual(['figures/orbit.png']);
    expect(labels(await complete('\\bibliography{|', files))).toEqual(['refs']);
  });

  describe('pictures uploaded to the scroll', () => {
    const assets = [
      { path: 'figures/orbit.png', size: 84_000 },
      { path: 'figures/energy.JPG', size: 2048 },
      { path: 'plots/spectrum.pdf', size: 3 * 1024 * 1024 },
      { path: 'figures/flow.svg', size: 10 },
      { path: 'figures/cover.webp', size: 10 },
    ];
    const more = { assets: () => assets, assetUrl: (p: string) => `/api/scrolls/x/assets/${p}` };

    it('are suggested for \\includegraphics (they are not text files), and only the ones LaTeX can embed', async () => {
      const r = await complete('\\includegraphics[width=5cm]{|', { 'main.tex': '' }, more);
      expect(labels(r).sort()).toEqual(['figures/energy.JPG', 'figures/orbit.png', 'plots/spectrum.pdf']);
    });

    it('are narrowed by what has been typed and say how big they are', async () => {
      const r = await complete('\\includegraphics{fig|', {}, more);
      expect(labels(r).sort()).toEqual(['figures/energy.JPG', 'figures/orbit.png', 'plots/spectrum.pdf']); // CodeMirror narrows the list itself
      expect(r!.options.find((o) => o.label === 'figures/orbit.png')).toMatchObject({ detail: 'png · 82 KB' });
      expect(r!.options.find((o) => o.label === 'plots/spectrum.pdf')).toMatchObject({ detail: 'pdf · 3.0 MB' });
    });

    it('offer a small preview for pictures a browser can show, not for PDFs', async () => {
      const r = await complete('\\includegraphics{|', {}, more);
      const info = (label: string) => r!.options.find((o) => o.label === label)!.info as (() => HTMLImageElement) | undefined;
      expect(info('figures/orbit.png')!().getAttribute('src')).toBe('/api/scrolls/x/assets/figures/orbit.png');
      expect(info('plots/spectrum.pdf')).toBeUndefined();
    });

    it('also work for \\includepdf, with PDFs only', async () => {
      expect(labels(await complete('\\includepdf[pages=1]{|', {}, more))).toEqual(['plots/spectrum.pdf']);
    });

    it('are not listed twice when they also show up among the project paths', async () => {
      expect(labels(await complete('\\includegraphics{|', { 'figures/orbit.png': '' }, more)).filter((l) => l === 'figures/orbit.png')).toHaveLength(1);
    });

    it('show the whole list on the {path} placeholder of an inserted template, instead of filtering by the word "path"', async () => {
      const r = await complete('\\includegraphics[width=\\linewidth]{path|', {}, more);
      expect(r!.filter).toBe(false);
      expect(labels(r).length).toBe(3);
      expect((await complete('\\includegraphics{fig|', {}, more))!.filter).toBe(true);
    });
  });

  it('returns nothing for argument completions when the project has no matches', async () => {
    expect(await complete('\\ref{|', {})).toBeNull();
  });
});
