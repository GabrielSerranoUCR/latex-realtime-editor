import { CompletionContext, CompletionResult, CompletionSource, acceptCompletion, snippet, startCompletion } from '@codemirror/autocomplete';
import { Prec, StateEffect, StateField } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { Completion } from '@codemirror/autocomplete';
import {
  BibEntry,
  extractBibEntries,
  extractBibItems,
  extractLabels,
  firstAuthorSurname,
  openEnvironments,
} from './analysis';
import { COMMANDS, DOCUMENT_CLASSES, commandOpening, insertsFullTemplate, isInlineCommand, ENVIRONMENTS, PACKAGES, TEX_EXTENSIONS } from './data';

/** What the completion sources need to know about the rest of the project. */
export interface ProjectSource {
  /** The project's text files. */
  paths(): string[];
  read(path: string): string;
  /** Pictures and PDFs uploaded to the scroll (they are not text files, so they are listed apart). */
  assets?(): Array<{ path: string; size: number }>;
  /** Where a picture can be fetched from, for the little preview next to a suggestion. */
  assetUrl?(path: string): string;
}

/** Pictures LaTeX can embed as they are (the engine cannot take .svg or .webp directly). */
export const LATEX_PICTURES = /\.(png|jpe?g|pdf|eps)$/i;
const PLACEHOLDER_PATH = 'path';

const REF_CMDS = 'ref|eqref|autoref|cref|Cref|pageref|nameref|vref';
const CITE_CMDS = 'cite|citep|citet|citeauthor|citeyear|parencite|textcite|autocite|nocite|footcite';

type Apply = (view: EditorView, completion: Completion, from: number, to: number) => void;

/**
 * Remembers closing braces that autocomplete inserted (`\\textbf{|}`), so typing `}` steps over
 * them instead of adding a second one. (CodeMirror's own closeBrackets only tracks braces it
 * inserted itself.)
 */
const markBrace = StateEffect.define<number>();
const insertedBraces = StateField.define<readonly number[]>({
  create: () => [],
  update(positions, tr) {
    let next = tr.docChanged ? positions.map((p) => tr.changes.mapPos(p, 1)) : [...positions];
    for (const e of tr.effects) if (e.is(markBrace)) next.push(e.value);
    const head = tr.state.selection.main.head;
    // forget a brace once the caret has moved past it or it was deleted
    next = next.filter((p) => head <= p && tr.state.sliceDoc(p, p + 1) === '}');
    return next;
  },
});
const typeOverInsertedBrace = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '}' || from !== to || !view.state.field(insertedBraces).includes(from)) return false;
  view.dispatch({ selection: { anchor: from + 1 }, userEvent: 'input.type' });
  return true;
});
/**
 * When Tab (or an insertion) lands the caret on the `path` placeholder of an `\\includegraphics{path}` template,
 * offer the project's pictures at once: nobody should have to type to find out what is there.
 */
const pathPrompt = EditorView.updateListener.of((update) => {
  if (!update.selectionSet) return;
  const sel = update.state.selection.main;
  if (sel.empty || update.state.sliceDoc(sel.from, sel.to) !== PLACEHOLDER_PATH) return;
  if (/\\(?:includegraphics|includepdf)\*?(?:\[[^\]]*\])*\{$/.test(update.state.sliceDoc(Math.max(0, sel.from - 200), sel.from))) reopen(update.view);
});
export const inlineBraceTracking = [insertedBraces, typeOverInsertedBrace, pathPrompt];

/** `\\cmd{}` with the caret between the braces (and the closing brace remembered). */
const insertInline =
  (text: string): Apply =>
  (view, _c, from, to) => {
    const caret = from + text.length - 1; // just before the closing `}`
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: caret }, effects: markBrace.of(caret), userEvent: 'input.complete' });
    reopen(view);
  };

/** After inserting text, re-open the popup so the next stage (argument, then closing) is offered. */
const reopen = (view: EditorView) => setTimeout(() => startCompletion(view), 0);

/** Replace the typed token with `text`, put the caret after it, and chain the next completion. */
const insert =
  (text: string): Apply =>
  (view, _c, from, to) => {
    // a selected placeholder (`path` in a fresh template) is replaced, as typing over it would
    const end = Math.max(to, view.state.selection.main.to);
    view.dispatch({ changes: { from, to: end, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.complete' });
    reopen(view);
  };

/**
 * The second stage: an option labelled exactly like what was typed (so it passes CodeMirror's
 * filter and ranks first) that completes the token *and* closes the bracket. For `\begin{name`
 * it also writes the `\end{name}` block. An already-present `}` (from auto-closing) is absorbed.
 */
/** Default body of a closed environment: one empty indented line to type in. */
const DEFAULT_BODY = '\n\t${}\n';

export function closer(typed: string, block?: { args?: string; body?: string }): Completion {
  const apply: Apply = (view, c, from, to) => {
    const end = view.state.sliceDoc(to, to + 1) === '}' ? to + 1 : to;
    if (block) {
      snippet(`${typed}}${block.args ?? ''}${block.body ?? DEFAULT_BODY}\\end{${typed}}`)(view, c, from, end);
    } else {
      view.dispatch({ changes: { from, to: end, insert: typed + '}' }, selection: { anchor: from + typed.length + 1 }, userEvent: 'input.complete' });
    }
  };
  return {
    label: typed,
    displayLabel: block ? `${typed}}  + ${block.body ? 'template' : '\\end{' + typed + '}'}` : `${typed}}`,
    detail: block ? (block.body ? 'insert template' : 'close & finish') : 'close',
    type: 'keyword',
    boost: 200, // must outrank every plain option (the open-environment list uses up to 100)
    apply,
  };
}

const commandOptions: Completion[] = COMMANDS.map((d) => ({
  label: '\\' + d.name,
  type: 'keyword',
  detail: d.detail,
  // templates (\frac{num}{den}) are inserted whole; tab through the placeholders
  apply: insertsFullTemplate(d) ? snippet('\\' + d.snippet!) : isInlineCommand(d) ? insertInline('\\' + d.name + '{}') : insert('\\' + commandOpening(d)),
}));

const inComment = (ctx: CompletionContext): boolean => {
  const line = ctx.state.doc.lineAt(ctx.pos);
  return /(^|[^\\])%/.test(line.text.slice(0, ctx.pos - line.from));
};

/** `\comm…` -> command names. */
const commandSource: CompletionSource = (ctx) => {
  const m = ctx.matchBefore(/\\[a-zA-Z@*]*/);
  if (!m || inComment(ctx)) return null;
  if (m.from > 0 && ctx.state.sliceDoc(m.from - 1, m.from) === '\\') return null; // `\\` line break
  return { from: m.from, options: commandOptions, validFor: /^\\[a-zA-Z@*]*$/ };
};

/**
 * `\begin{…` / `\end{…`. Accepting a name inserts only the name; once the name is complete the
 * first suggestion closes the bracket (and, for `\begin`, writes the matching `\end`).
 */
const environmentSource: CompletionSource = (ctx) => {
  const m = ctx.matchBefore(/\\(begin|end)\{[a-zA-Z*]*/);
  if (!m || inComment(ctx)) return null;
  const isBegin = m.text.startsWith('\\begin');
  const from = m.from + m.text.indexOf('{') + 1;
  const typed = ctx.state.sliceDoc(from, ctx.pos);

  if (isBegin) {
    const options: Completion[] = ENVIRONMENTS.map((d) => ({ label: d.name, type: 'class', detail: d.detail, apply: insert(d.name) }));
    const exact = ENVIRONMENTS.find((d) => d.name === typed);
    if (exact) options.unshift(closer(typed, { args: exact.args, body: exact.body }));
    return { from, options };
  }

  const open = openEnvironments(ctx.state.sliceDoc(0, m.from)).reverse();
  const options: Completion[] = open.map((name, i) => ({ label: name, type: 'class', detail: i === 0 ? 'close innermost' : 'open', boost: 100 - i, apply: insert(name) }));
  for (const d of ENVIRONMENTS) if (!open.includes(d.name)) options.push({ label: d.name, type: 'class', apply: insert(d.name) });
  if (typed && (open.includes(typed) || ENVIRONMENTS.some((d) => d.name === typed))) options.unshift(closer(typed));
  return { from, options };
};

/** Generic `\cmd[opt]{a,b,tok|` completion for a set of commands. */
function argumentSource(commands: string, options: () => Completion[]): CompletionSource {
  const re = new RegExp(`\\\\(?:${commands})\\*?(?:\\[[^\\]]*\\])*\\{(?:[^}]*,)?[^},]*$`);
  return (ctx): CompletionResult | null => {
    const m = ctx.matchBefore(re);
    if (!m || inComment(ctx)) return null;
    let start = Math.max(m.text.lastIndexOf('{'), m.text.lastIndexOf(',')) + 1;
    while (m.text[start] === ' ') start++; // `{a, b|`: keep the space the user typed after the comma
    const from = m.from + start;
    const typed = ctx.state.sliceDoc(from, ctx.pos);
    const opts: Completion[] = options().map((o) => ({ ...o, apply: insert(o.label) }));
    if (!opts.length) return null;
    if (opts.some((o) => o.label === typed)) opts.unshift(closer(typed));
    // a freshly inserted template's `path` placeholder is a prompt, not something the user typed: show everything
    return { from, options: opts, filter: typed !== PLACEHOLDER_PATH };
  };
}

export function latexCompletions(project?: ProjectSource): CompletionSource[] {
  const paths = () => project?.paths() ?? [];
  const read = (p: string) => project?.read(p) ?? '';

  const labels = (): Completion[] => {
    const seen = new Set<string>();
    const out: Completion[] = [];
    for (const p of paths().filter((x) => TEX_EXTENSIONS.test(x))) {
      for (const l of extractLabels(p, read(p))) {
        if (seen.has(l.label)) continue;
        seen.add(l.label);
        out.push({ label: l.label, type: 'variable', detail: `${l.file}:${l.line}` });
      }
    }
    return out;
  };

  const citations = (): Completion[] => {
    const out = new Map<string, Completion>();
    const describe = (b: BibEntry): Completion => ({
      label: b.key,
      type: 'constant',
      detail: [firstAuthorSurname(b.author), b.year].filter(Boolean).join(' ') || b.type,
      info: b.title,
    });
    for (const p of paths()) {
      if (/\.bib$/i.test(p)) for (const b of extractBibEntries(read(p))) out.set(b.key, describe(b));
      else if (TEX_EXTENSIONS.test(p)) for (const k of extractBibItems(read(p))) if (!out.has(k)) out.set(k, { label: k, type: 'constant', detail: 'bibitem' });
    }
    return [...out.values()];
  };

  const files = (pattern: RegExp, stripExt: boolean) => (): Completion[] =>
    paths().filter((p) => pattern.test(p)).map((p) => ({ label: stripExt ? p.replace(/\.[^.]+$/, '') : p, type: 'text', detail: stripExt ? p.split('.').pop() : undefined }));

  const bytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const pictures = (pattern: RegExp) => (): Completion[] => {
    const seen = new Set<string>();
    const out: Completion[] = [];
    const add = (path: string, size?: number) => {
      if (seen.has(path) || !pattern.test(path)) return;
      seen.add(path);
      const ext = path.split('.').pop()!.toLowerCase();
      const previewable = /^(png|jpe?g)$/.test(ext) && project?.assetUrl;
      out.push({
        label: path,
        type: 'text',
        detail: [ext, size !== undefined ? bytes(size) : ''].filter(Boolean).join(' · '),
        // a small thumbnail beside the suggestion, so you can tell the pictures apart
        info: previewable
          ? () => {
              const img = document.createElement('img');
              img.src = project!.assetUrl!(path);
              img.alt = '';
              img.style.cssText = 'display:block;max-width:220px;max-height:160px;background:#fff';
              return img;
            }
          : undefined,
      });
    };
    for (const a of project?.assets?.() ?? []) add(a.path, a.size);
    for (const p of paths()) add(p);
    return out;
  };

  return [
    environmentSource,
    argumentSource(REF_CMDS, labels),
    argumentSource(CITE_CMDS, citations),
    argumentSource('usepackage|RequirePackage', () => PACKAGES.map((label) => ({ label, type: 'namespace' }))),
    argumentSource('documentclass', () => DOCUMENT_CLASSES.map((label) => ({ label, type: 'namespace' }))),
    argumentSource('input|include|subfile', files(TEX_EXTENSIONS, true)),
    argumentSource('includegraphics', pictures(LATEX_PICTURES)),
    argumentSource('includepdf', pictures(/\.pdf$/i)),
    argumentSource('bibliography', files(/\.bib$/i, true)),
    argumentSource('addbibresource', files(/\.bib$/i, false)),
    commandSource,
  ];
}

/**
 * Tab accepts the highlighted suggestion while the popup is open. `acceptCompletion` returns
 * false when there is no popup, so Tab falls through to snippet-field navigation and then to
 * indentation. Highest precedence keeps it ahead of the editor's generic Tab binding.
 */
export const acceptCompletionWithTab = [Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])), ...inlineBraceTracking];
