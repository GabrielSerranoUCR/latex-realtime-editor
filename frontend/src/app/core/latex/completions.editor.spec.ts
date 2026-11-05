import { CompletionContext, acceptCompletion, autocompletion, completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import type { Completion } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS, ENVIRONMENTS, insertsFullTemplate, isInlineCommand } from './data';
import { ProjectSource, acceptCompletionWithTab, closer, latexCompletions } from './completions';

/**
 * Exercises the real CodeMirror completion UI (open -> accept -> next stage) in two stages:
 *   1. accepting a command inserts only the word and its first bracket;
 *   2. once an argument is complete, the first suggestion closes the bracket (and `\end{…}`).
 */
// jsdom has no layout engine; CodeMirror's measure loop needs these to exist.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function editor(docWithCursor: string, files: Record<string, string> = {}, more: Partial<ProjectSource> = {}): EditorView {
  const project: ProjectSource = { paths: () => Object.keys(files), read: (p) => files[p] ?? '', ...more };
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: docWithCursor.replace('|', ''),
      selection: { anchor: docWithCursor.indexOf('|') },
      extensions: [autocompletion({ override: latexCompletions(project) }), acceptCompletionWithTab, keymap.of([indentWithTab])],
    }),
  });
  views.push(view);
  return view;
}

/** Wait for the popup (explicitly opened, or re-opened by a previous accept). */
async function popup(view: EditorView, explicit = false): Promise<string[]> {
  if (explicit) startCompletion(view);
  for (let i = 0; i < 100 && completionStatus(view.state) !== 'active'; i++) await sleep(10);
  return currentCompletions(view.state).map((c) => c.label);
}

/** CodeMirror ignores accept for 75ms after the popup appears (anti-misclick); wait it out. */
async function accept(view: EditorView): Promise<void> {
  await sleep(120);
  expect(acceptCompletion(view)).toBe(true);
}

const pressTab = (view: EditorView): boolean => runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Tab' }), 'editor');
const text = (v: EditorView) => v.state.doc.toString();
const caret = (v: EditorView) => v.state.selection.main.head;

describe('multi-argument commands insert their whole template', () => {
  const selected = (v: EditorView) => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);

  it('\\frac -> \\frac{num}{den}, with Tab moving numerator -> denominator', async () => {
    const view = editor('\\frac|');
    expect((await popup(view, true))[0]).toBe('\\frac');
    await accept(view);
    expect(text(view)).toBe('\\frac{num}{den}');
    expect(selected(view)).toBe('num');
    pressTab(view);
    expect(selected(view)).toBe('den');
  });

  it('sub/superscript commands: \\sum, \\int, \\lim, \\binom', async () => {
    for (const [typed, expected] of [['\\sum', '\\sum_{i=1}^{n}'], ['\\int', '\\int_{a}^{b}  \\,dx'], ['\\binom', '\\binom{n}{k}'], ['\\lim', '\\lim_{x \\to 0}']] as const) {
      const view = editor(typed + '|');
      expect((await popup(view, true))[0], typed).toBe(typed); // an exact match ranks first
      await accept(view);
      expect(text(view), typed).toBe(expected);
    }
  });

  it('\\left( | \\right) puts the caret in the middle', async () => {
    const view = editor('\\lef|');
    await popup(view, true);
    await accept(view);
    expect(text(view)).toBe('\\left(  \\right)');
    expect(caret(view)).toBe(7);
  });

  it('\\begin is a container, not a template: it stays on the staged flow', async () => {
    const view = editor('\\beg|');
    await popup(view, true);
    await accept(view);
    expect(text(view)).toBe('\\begin{}'); // no \end, no environment chosen for you
  });
});

describe('stage 1: commands without a template complete to just the word', () => {
  it('commands without arguments insert just the word', async () => {
    const view = editor('\\alph|');
    await popup(view, true);
    await accept(view);
    expect(text(view)).toBe('\\alpha');
  });

  it('argument-less commands insert just the word; verbose ones insert a template', async () => {
    const a = editor('\\ri|');
    await popup(a, true);
    await accept(a);
    expect(text(a)).toBe('\\right'); // no arguments: just the word
    const b = editor('\\newth|');
    await popup(b, true);
    await accept(b);
    expect(text(b)).toBe('\\newtheorem{thm}{Theorem}'); // verbose: whole template
  });

  it('after \\begin{} the environment list opens by itself', async () => {
    const view = editor('\\begi|');
    await popup(view, true);
    await accept(view);
    expect(text(view)).toBe('\\begin{}'); // single-argument command: closed, caret inside
    expect(caret(view)).toBe(7);
    const labels = await popup(view); // not explicitly started: it chained
    expect(labels).toEqual(expect.arrayContaining(['equation', 'itemize', 'figure']));
  });
});

describe('single-argument commands close their bracket and keep the caret inside', () => {
  it('\\textbf -> \\textbf{|}', async () => {
    const view = editor('\\textb|');
    await popup(view, true);
    await accept(view);
    expect(text(view)).toBe('\\textbf{}');
    expect(caret(view)).toBe(8);
  });

  it('works for sectioning, emphasis, math wrappers and package loading', async () => {
    for (const [typed, expected] of [['\\subsec', '\\subsection{}'], ['\\emp', '\\emph{}'], ['\\mathb', '\\mathbb{}'], ['\\usepack', '\\usepackage{}'], ['\\foot', '\\footnote{}']] as const) {
      const view = editor(typed + '|');
      await popup(view, true);
      await accept(view);
      expect(text(view), typed).toBe(expected);
      expect(caret(view), typed).toBe(expected.length - 1);
    }
  });

  it('the argument popup then opens inside the braces: \\ref{|} -> pick label', async () => {
    const view = editor('\\re|', { 'main.tex': '\\label{sec:intro}' });
    await popup(view, true);
    // `\re` also matches \renewcommand etc.; narrow to \ref
    view.dispatch({ changes: { from: caret(view), insert: 'f' }, selection: { anchor: caret(view) + 1 } });
    await popup(view, true);
    expect(currentCompletions(view.state)[0].label).toBe('\\ref');
    await accept(view);
    expect(text(view)).toBe('\\ref{}');
    expect(await popup(view)).toEqual(['sec:intro']);
    await accept(view); // choose the label (existing `}` stays)
    expect(text(view)).toBe('\\ref{sec:intro}');
    await popup(view);
    await accept(view); // closer moves the caret past the brace
    expect(text(view)).toBe('\\ref{sec:intro}');
    expect(caret(view)).toBe(text(view).length);
  });

  it('multi-argument and verbose commands are not auto-closed', () => {
    const inline = (n: string) => isInlineCommand(COMMANDS.find((c) => c.name === n)!);
    for (const n of ['textbf', 'section', 'emph', 'ref', 'cite', 'usepackage', 'begin', 'end', 'label', 'footnote']) expect(inline(n), n).toBe(true);
    for (const n of ['frac', 'sum', 'int', 'left', 'item', 'alpha', 'includegraphics', 'newcommand', 'href', 'underbrace']) expect(inline(n), n).toBe(false);
    for (const n of ['frac', 'sum', 'int', 'left', 'binom', 'underbrace', 'includegraphics']) expect(insertsFullTemplate(COMMANDS.find((c) => c.name === n)!), n).toBe(true);
    for (const n of ['begin', 'textbf', 'alpha', 'right']) expect(insertsFullTemplate(COMMANDS.find((c) => c.name === n)!), n).toBe(false);
  });

  it('typing `}` steps over the brace autocomplete inserted instead of doubling it', async () => {
    const view = editor('\\textb|');
    await popup(view, true);
    await accept(view);
    view.dispatch({ changes: { from: caret(view), insert: 'hi' }, selection: { anchor: caret(view) + 2 } });
    expect(text(view)).toBe('\\textbf{hi}');
    const typeBrace = () => view.state.facet(EditorView.inputHandler).some((h) => h(view, caret(view), caret(view), '}', () => view.state.update({})));
    expect(typeBrace()).toBe(true); // handled: caret moves past the existing brace
    expect(text(view)).toBe('\\textbf{hi}');
    expect(caret(view)).toBe(text(view).length);
    expect(typeBrace()).toBe(false); // a later `}` is a normal keystroke again
  });
});

describe('stage 2: choose the argument, then autocomplete again to close', () => {
  it('full chain: \\beg -> \\begin{ -> equation -> } + \\end{equation}', async () => {
    const view = editor('\\beg|');
    await popup(view, true);
    await accept(view); // \begin{
    await popup(view);
    view.dispatch({ changes: { from: caret(view), insert: 'equati' }, selection: { anchor: caret(view) + 6 }, userEvent: 'input.type' });
    expect((await popup(view, true))[0]).toBe('equation');
    await accept(view); // choose the environment: name only
    expect(text(view)).toBe('\\begin{equation}');
    const next = await popup(view); // re-opened: first option is the closer
    expect(next[0]).toBe('equation');
    expect(currentCompletions(view.state)[0].displayLabel).toBe('equation}  + \\end{equation}');
    await accept(view);
    expect(text(view)).toBe('\\begin{equation}\n  \n\\end{equation}');
    // caret lands inside the new block
    expect(view.state.doc.lineAt(caret(view)).number).toBe(2);
  });

  it('absorbs a `}` that was already there instead of duplicating it', async () => {
    const view = editor('\\begin{equation|}');
    await popup(view, true);
    expect(currentCompletions(view.state)[0].displayLabel).toMatch(/equation}/);
    await accept(view);
    expect(text(view)).toBe('\\begin{equation}\n  \n\\end{equation}');
  });

  it('passes environment arguments when closing, e.g. tabular asks for columns', async () => {
    const view = editor('\\begin{tabular|}');
    await popup(view, true);
    await accept(view);
    expect(text(view)).toContain('\\begin{tabular}{ll}');
    expect(text(view)).toContain('\\end{tabular}');
  });

  it('\\end{ offers the innermost open environment, then closes with just `}`', async () => {
    const view = editor('\\begin{itemize}\n  \\item hi\n\\end{|}');
    expect((await popup(view, true))[0]).toBe('itemize');
    await accept(view);
    expect(text(view)).toBe('\\begin{itemize}\n  \\item hi\n\\end{itemize}');
    await popup(view);
    await accept(view); // closer
    expect(text(view)).toBe('\\begin{itemize}\n  \\item hi\n\\end{itemize}');
    expect(caret(view)).toBe(text(view).length); // caret moved past the brace
  });

  it('\\ref{ -> pick a project label -> `}` closes it', async () => {
    const view = editor('See \\ref{sec:|', { 'main.tex': '\\section{A}\\label{sec:intro}' });
    expect(await popup(view, true)).toEqual(['sec:intro']);
    await accept(view);
    expect(text(view)).toBe('See \\ref{sec:intro');
    expect((await popup(view))[0]).toBe('sec:intro');
    expect(currentCompletions(view.state)[0].displayLabel).toBe('sec:intro}');
    await accept(view);
    expect(text(view)).toBe('See \\ref{sec:intro}');
  });

  it('\\cite{a, gri -> key keeps the typed space and can then be closed', async () => {
    const view = editor('\\cite{a, gri|', { 'refs.bib': '@article{a, title={A}}\n@book{griffiths2018, title={B}}' });
    await popup(view, true);
    await accept(view);
    expect(text(view)).toBe('\\cite{a, griffiths2018');
    await popup(view);
    await accept(view);
    expect(text(view)).toBe('\\cite{a, griffiths2018}');
  });
});

describe('Tab key', () => {
  it('accepts the highlighted suggestion, then Tab again finishes the environment', async () => {
    const view = editor('\\begin{itemi|}');
    await popup(view, true);
    await sleep(120);
    expect(pressTab(view)).toBe(true); // choose `itemize`
    expect(text(view)).toBe('\\begin{itemize}');
    await popup(view);
    await sleep(120);
    expect(pressTab(view)).toBe(true); // closer: add the template
    expect(text(view)).toBe('\\begin{itemize}\n  \\item \n\\end{itemize}');
  });

  it('still indents when no popup is open', () => {
    const view = editor('hello|');
    expect(completionStatus(view.state)).toBeNull();
    pressTab(view);
    expect(text(view).length).toBeGreaterThan(5);
  });
});

describe('templates for verbose commands and environments', () => {
  const selected = (v: EditorView) => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);

  it('figure: closing writes a full figure with tab-able placeholders', async () => {
    const view = editor('\\begin{figure|}');
    await popup(view, true);
    expect(currentCompletions(view.state)[0].displayLabel).toBe('figure}  + template');
    await accept(view);
    expect(text(view)).toBe(
      [
        '\\begin{figure}[htbp]',
        '  \\centering',
        '  \\includegraphics[width=0.8\\linewidth]{path}',
        '  \\caption{caption}',
        '  \\label{fig:label}',
        '\\end{figure}',
      ].join('\n'),
    );
    // Tab walks through the fields in order
    const seen = [selected(view)];
    for (let i = 0; i < 4; i++) {
      pressTab(view);
      seen.push(selected(view));
    }
    expect(seen).toEqual(['htbp', '0.8\\linewidth', 'path', 'caption', 'label']);
  });

  it('table: caption, label and a booktabs tabular skeleton', async () => {
    const view = editor('\\begin{table|}');
    await popup(view, true);
    await accept(view);
    const t = text(view);
    expect(t).toContain('\\begin{table}[htbp]');
    expect(t).toContain('\\label{tab:label}');
    expect(t).toContain('\\begin{tabular}{ll}');
    expect(t).toContain('\\toprule');
    expect(t).toContain('A & B \\\\');
    expect(t).toContain('\\bottomrule');
    expect(t.endsWith('\\end{table}')).toBe(true);
  });

  it('itemize starts with an \\item; plain environments still get an empty line', async () => {
    const a = editor('\\begin{enumerate|}');
    await popup(a, true);
    await accept(a);
    expect(text(a)).toBe('\\begin{enumerate}\n  \\item \n\\end{enumerate}');
    const b = editor('\\begin{center|}');
    await popup(b, true);
    await accept(b);
    expect(text(b)).toBe('\\begin{center}\n  \n\\end{center}');
  });

  it('verbose commands insert every argument: \\includegraphics, \\href, \\newcommand', async () => {
    const g = editor('\\includegr|');
    await popup(g, true);
    await accept(g);
    expect(text(g)).toBe('\\includegraphics[width=0.8\\linewidth]{path}');
    expect(selected(g)).toBe('0.8\\linewidth');
    pressTab(g);
    expect(selected(g)).toBe('path');

    const h = editor('\\hre|');
    await popup(h, true);
    await accept(h);
    expect(text(h)).toBe('\\href{url}{text}');

    const n = editor('\\newcomm|');
    await popup(n, true);
    await accept(n);
    expect(text(n)).toBe('\\newcommand{\\name}{definition}');
  });

  it('every environment template applies cleanly (balanced begin/end, no stray placeholders)', () => {
    for (const env of ENVIRONMENTS) {
      const doc = `\\begin{${env.name}}`;
      const view = editor(doc + '|');
      const apply = closer(env.name, { args: env.args, body: env.body }).apply as (v: EditorView, c: Completion, f: number, t: number) => void;
      apply(view, {} as Completion, 7, doc.length - 1); // token = the env name, followed by the existing `}`
      const out = text(view);
      expect(out.startsWith(`\\begin{${env.name}}`), env.name).toBe(true);
      expect(out.endsWith(`\\end{${env.name}}`), env.name).toBe(true);
      expect(out, env.name).not.toMatch(/\$\{|#\{/);
      expect((out.match(/{/g) ?? []).length, `${env.name} braces`).toBe((out.match(/}/g) ?? []).length);
    }
  });

  it('every templated command applies cleanly', async () => {
    for (const d of COMMANDS.filter((x) => insertsFullTemplate(x))) {
      const view = editor('\\' + d.name + '|');
      const sources = latexCompletions();
      const res = await sources[sources.length - 1](new CompletionContext(view.state, view.state.doc.length, true));
      const entry = res!.options.find((o) => o.label === '\\' + d.name)!;
      (entry.apply as (v: EditorView, c: Completion, f: number, t: number) => void)(view, entry, 0, view.state.doc.length);
      const out = text(view);
      expect(out, d.name).not.toMatch(/\$\{|#\{/);
      expect((out.match(/{/g) ?? []).length, `${d.name} braces`).toBe((out.match(/}/g) ?? []).length);
    }
  });
});

describe('picture paths', () => {
  const more = { assets: () => [{ path: 'figures/orbit.png', size: 1000 }, { path: 'figures/energy.png', size: 2000 }] };
  const selected = (v: EditorView) => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);

  it('open the picture list by themselves when Tab brings the caret to the {path} placeholder', async () => {
    const view = editor('\\includegraphics|', {}, more);
    expect((await popup(view, true))[0]).toBe('\\includegraphics');
    await accept(view);
    expect(text(view)).toBe('\\includegraphics[width=0.8\\linewidth]{path}');
    expect(selected(view)).toBe('0.8\\linewidth'); // first the width…
    pressTab(view);
    expect(selected(view)).toBe('path'); // …then the path
    expect((await popup(view)).sort()).toEqual(['figures/energy.png', 'figures/orbit.png']); // nothing typed, nothing filtered out
  });

  it('and choosing one replaces the placeholder with the picture\'s path', async () => {
    const view = editor('\\includegraphics|', {}, more);
    await popup(view, true);
    await accept(view);
    pressTab(view);
    await popup(view);
    await accept(view);
    expect(text(view)).toMatch(/^\\includegraphics\[width=0\.8\\linewidth\]\{figures\/(energy|orbit)\.png\}$/);
  });

  it('also while typing a path by hand', async () => {
    const view = editor('\\includegraphics{fig|', {}, more);
    expect((await popup(view, true)).sort()).toEqual(['figures/energy.png', 'figures/orbit.png']);
  });

  it('do not pop up for other selections of the word "path"', async () => {
    const view = editor('\\label{path}|', {}, more);
    view.dispatch({ selection: { anchor: 7, head: 11 } });
    await sleep(120);
    expect(completionStatus(view.state)).not.toBe('active');
  });
});
