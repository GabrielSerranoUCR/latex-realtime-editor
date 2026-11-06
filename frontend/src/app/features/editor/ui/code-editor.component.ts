import { Component, DestroyRef, ElementRef, ViewEncapsulation, computed, effect, inject, input, output, untracked, viewChild } from '@angular/core';
import { autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab, selectAll } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { highlightSelectionMatches } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, Extension, Prec, StateEffect, StateField } from '@codemirror/state';
import { FormatKind, ListKind, applyFormat, makeList, sectionLine, toggleComment } from '../../../core/latex/format';
import { Decoration, EditorView, GutterMarker, drawSelection, gutter, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { ProjectSource, acceptCompletionWithTab, completionKeys, latexCompletions } from '../../../core/latex/completions';
import { FONT_STACKS } from '../../../core/prefs/prefs';
import { PreferencesService } from '../../../core/prefs/prefs.service';

const tavernTheme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--wood-900)', color: 'var(--text-1)' },
    '.cm-scroller': { fontFamily: 'var(--editor-font, var(--font-mono))', fontSize: 'var(--editor-size, 15px)', lineHeight: 'var(--editor-lh, 24px)' },
    '.cm-content': { caretColor: 'var(--candle-400)', padding: '16px 0' },
    '.cm-gutters': { backgroundColor: 'var(--wood-800)', color: 'var(--text-3)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgb(var(--glow-rgb) / 0.06)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgb(var(--glow-rgb) / 0.1)', color: 'var(--candle-400)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgb(var(--brass-rgb) / 0.3)' },
    '.cm-cursor': { borderLeftColor: 'var(--candle-400)' },
    '.cm-matchingBracket': { backgroundColor: 'rgb(var(--brass-rgb) / 0.3)', outline: '1px solid var(--brass-500)' },
    // autocomplete popup
    '.cm-tooltip': { backgroundColor: 'var(--wood-800)', border: '2px solid var(--brass-700)', borderRadius: '6px', boxShadow: '0 12px 24px rgb(0 0 0 / 0.55)' },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '13px', maxHeight: '260px', minWidth: '240px' },
    '.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px', color: 'var(--text-1)', display: 'flex', alignItems: 'center' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'rgb(var(--brass-rgb) / 0.28)', color: 'var(--candle-400)' },
    '.cm-completionLabel': { flex: '1' },
    '.cm-completionDetail': { color: 'var(--text-3)', fontStyle: 'italic', fontFamily: 'var(--font-body)', fontSize: '14px', marginLeft: '1.5em' },
    '.cm-completionMatchedText': { color: 'var(--candle-400)', textDecoration: 'none', fontWeight: '700' },
    '.cm-completionIcon': { color: 'var(--brass-500)', opacity: '0.9' },
    '.cm-tooltip.cm-completionInfo': { backgroundColor: 'var(--text-1)', color: 'var(--ink-900)', border: '2px solid var(--wood-900)', fontFamily: 'var(--font-body)', fontSize: '15px', padding: '6px 10px', maxWidth: '320px' },
    '.cm-snippetField': { backgroundColor: 'rgb(var(--glow-rgb) / 0.22)', outline: '1px solid var(--brass-500)' },
    // margin notes
    '.cm-note': { backgroundColor: 'rgb(var(--glow-rgb) / 0.10)', borderBottom: '1px dotted var(--brass-500)' },
    '.cm-note-sel': { backgroundColor: 'rgb(var(--glow-rgb) / 0.26)', borderBottom: '1px solid var(--candle-400)' },
    '.cm-search-match': { backgroundColor: 'rgb(var(--glow-rgb) / 0.4)', boxShadow: '0 0 0 2px var(--candle-400) inset' },
    '.cm-search-current': { backgroundColor: 'rgb(var(--glow-rgb) / 0.75)', boxShadow: '0 0 0 2px var(--candle-400)' },
    '.cm-error-line': { backgroundColor: 'rgb(155 48 48 / 0.28)', boxShadow: 'inset 3px 0 0 var(--wine-500)' },
    '.cm-note-resolved': { backgroundColor: 'transparent', borderBottom: '1px dashed rgb(var(--brass7-rgb) / 0.5)' },
    '.cm-notes-gutter': { width: '20px' },
    '.cm-notes-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
    '.note-dot': { position: 'relative', width: '12px', height: '9px', borderRadius: '3px', backgroundColor: 'var(--brass-500)', display: 'block' },
    '.note-dot::after': { content: '""', position: 'absolute', left: '2px', bottom: '-3px', borderWidth: '3px 3px 0 0', borderStyle: 'solid', borderColor: 'var(--brass-500) transparent transparent transparent' },
    '.note-dot.sel': { backgroundColor: 'var(--candle-400)', boxShadow: '0 0 6px var(--candle-400)' },
    '.note-dot.sel::after': { borderTopColor: 'var(--candle-400)' },
    '.note-dot.resolved': { backgroundColor: 'transparent', border: '1px solid var(--brass-700)', opacity: '0.7' },
    '.note-dot.resolved::after': { display: 'none' },
    // remote scribes (y-codemirror.next draws these)
    '.cm-ySelectionInfo': { fontFamily: 'var(--font-heading)', fontWeight: '700', fontSize: '11px', color: 'var(--ink-900)', padding: '1px 8px', top: '-1.7em', opacity: '1' },
  },
  { dark: true },
);

const tavernHighlight = HighlightStyle.define([
  { tag: [t.tagName, t.keyword, t.standard(t.variableName)], color: 'var(--candle-400)' },
  { tag: [t.bracket, t.paren, t.brace], color: 'var(--ember-500)' },
  { tag: [t.comment], color: 'var(--ale-500)', fontStyle: 'italic' },
  { tag: [t.string, t.atom, t.number], color: 'var(--code-string)' },
  { tag: [t.meta], color: 'var(--text-3)' },
  { tag: [t.invalid], color: 'var(--wine-500)' },
]);

/** A margin note's place in the open file (absolute positions; the editor keeps them in step with edits). */
export interface NoteMark {
  id: string;
  from: number;
  to: number;
  resolved: boolean;
  selected: boolean;
}

const setNotes = StateEffect.define<NoteMark[]>();

/** The notes' ranges, mapped through every edit so they stay on their words between two syncs with the document. */
const notesField = StateField.define<NoteMark[]>({
  create: () => [],
  update(marks, tr) {
    let next = tr.docChanged ? marks.map((m) => ({ ...m, from: tr.changes.mapPos(m.from, 1), to: tr.changes.mapPos(m.to, -1) })) : marks;
    for (const e of tr.effects) if (e.is(setNotes)) next = e.value;
    return next;
  },
  provide: (f) =>
    EditorView.decorations.compute([f], (state) =>
      Decoration.set(
        state
          .field(f)
          .filter((m) => m.to > m.from)
          .map((m) => Decoration.mark({ class: m.selected ? 'cm-note cm-note-sel' : m.resolved ? 'cm-note cm-note-resolved' : 'cm-note' }).range(m.from, m.to)),
        true,
      ),
    ),
});

/** Lines (as 1-based numbers) the last compile failed on. */
const setErrorLines = StateEffect.define<number[]>();

/** Where the failing lines start, mapped through every edit so the highlight stays with its line. */
const errorField = StateField.define<number[]>({
  create: () => [],
  update(starts, tr) {
    let next = tr.docChanged ? starts.map((p) => tr.changes.mapPos(p, -1)) : starts;
    for (const e of tr.effects) {
      if (e.is(setErrorLines)) {
        const doc = tr.state.doc;
        next = [...new Set(e.value.filter((n) => n >= 1 && n <= doc.lines).map((n) => doc.line(n).from))];
      }
    }
    return next;
  },
  provide: (f) =>
    EditorView.decorations.compute([f], (state) =>
      Decoration.set(
        [...new Set(state.field(f).map((p) => state.doc.lineAt(p).from))].sort((a, b) => a - b).map((p) => Decoration.line({ class: 'cm-error-line' }).range(p)),
      ),
    ),
});


/** Style the selection (bold, italic, …); the same key again takes it off. */
const formatCommand = (kind: FormatKind) => (view: EditorView): boolean => {
  if (view.state.readOnly) return true;
  const doc = view.state.doc.toString();
  view.dispatch(
    view.state.changeByRange((r) => {
      const e = applyFormat(doc, r.from, r.to, kind);
      return { changes: { from: e.from, to: e.to, insert: e.insert }, range: EditorSelection.range(e.from + e.selStart, e.from + e.selEnd) };
    }),
    { userEvent: 'input.format', scrollIntoView: true },
  );
  return true;
};

/** Comment out the selected lines, or bring them back. */
const commentCommand = (view: EditorView): boolean => {
  if (view.state.readOnly) return true;
  const { doc } = view.state;
  const changes = view.state.selection.ranges.map((r) => {
    const first = doc.lineAt(r.from);
    const last = doc.lineAt(r.to > r.from && doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to);
    const lines: string[] = [];
    for (let n = first.number; n <= last.number; n++) lines.push(doc.line(n).text);
    return { from: first.from, to: last.to, insert: toggleComment(lines).join('\n') };
  });
  view.dispatch({ changes, userEvent: 'input.comment', scrollIntoView: true });
  return true;
};

/** A bulleted or numbered list around the selected lines (or an empty one at the caret). */
const listCommand = (kind: ListKind) => (view: EditorView): boolean => {
  if (view.state.readOnly) return true;
  view.dispatch(
    view.state.changeByRange((r) => {
      const { insert, caret } = makeList(view.state.sliceDoc(r.from, r.to), kind);
      return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + caret) };
    }),
    { userEvent: 'input.list', scrollIntoView: true },
  );
  return true;
};

/** Make the current line a \section, \subsection or \subsubsection (again: back to plain text). */
const sectionCommand = (level: 0 | 1 | 2) => (view: EditorView): boolean => {
  if (view.state.readOnly) return true;
  const changes = view.state.selection.ranges.map((r) => {
    const line = view.state.doc.lineAt(r.head);
    return { from: line.from, to: line.to, insert: sectionLine(line.text, level) };
  });
  view.dispatch({ changes, userEvent: 'input.heading', scrollIntoView: true });
  return true;
};

/** The text shortcuts, the same as in a word processor where there is one. They beat CodeMirror's own keys (⌘I, ⌘/). */
const textKeymap = keymap.of([
  { key: 'Mod-b', run: formatCommand('bold'), preventDefault: true },
  { key: 'Mod-i', run: formatCommand('italic'), preventDefault: true },
  { key: 'Mod-u', run: formatCommand('underline'), preventDefault: true },
  { key: 'Mod-Shift-e', run: formatCommand('emph'), preventDefault: true },
  { key: 'Mod-e', run: formatCommand('mono'), preventDefault: true },
  { key: 'Mod-.', run: formatCommand('sup'), preventDefault: true },
  { key: 'Mod-,', run: formatCommand('sub'), preventDefault: true },
  // Safari keeps ⌘, (Settings) for itself, so the same two with Option as well
  { key: 'Mod-Alt-.', run: formatCommand('sup'), preventDefault: true },
  { key: 'Mod-Alt-,', run: formatCommand('sub'), preventDefault: true },
  { key: 'Mod-/', run: commentCommand, preventDefault: true },
  { key: 'Mod-Shift-8', run: listCommand('itemize'), preventDefault: true },
  { key: 'Mod-Shift-7', run: listCommand('enumerate'), preventDefault: true },
  { key: 'Mod-Alt-1', run: sectionCommand(0), preventDefault: true },
  { key: 'Mod-Alt-2', run: sectionCommand(1), preventDefault: true },
  { key: 'Mod-Alt-3', run: sectionCommand(2), preventDefault: true },
]);

/** What the search panel found in this file: every match, and which one it is on. Positions follow edits. */
export interface SearchMarkSet {
  ranges: Array<{ from: number; to: number }>;
  current: { from: number; to: number } | null;
}
const setSearchMarks = StateEffect.define<SearchMarkSet>();

const searchField = StateField.define<SearchMarkSet>({
  create: () => ({ ranges: [], current: null }),
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      const map = (r: { from: number; to: number }) => ({ from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) });
      next = { ranges: value.ranges.map(map).filter((r) => r.to > r.from), current: value.current ? map(value.current) : null };
    }
    for (const e of tr.effects) if (e.is(setSearchMarks)) next = e.value;
    return next;
  },
  provide: (f) =>
    EditorView.decorations.compute([f], (state) => {
      const { ranges, current } = state.field(f);
      const len = state.doc.length;
      return Decoration.set(
        ranges
          .filter((r) => r.to > r.from && r.to <= len)
          .sort((a, b) => a.from - b.from)
          .map((r) => Decoration.mark({ class: current && current.from === r.from && current.to === r.to ? 'cm-search-match cm-search-current' : 'cm-search-match' }).range(r.from, r.to)),
        true,
      );
    }),
});

class NoteDot extends GutterMarker {
  constructor(readonly selected: boolean, readonly resolved: boolean, readonly count: number) {
    super();
  }
  override eq(other: NoteDot): boolean {
    return other.selected === this.selected && other.resolved === this.resolved && other.count === this.count;
  }
  override toDOM(): HTMLElement {
    const dot = document.createElement('span');
    dot.className = 'note-dot' + (this.selected ? ' sel' : '') + (this.resolved ? ' resolved' : '');
    dot.title = this.count > 1 ? `${this.count} margin notes on this line` : 'Margin note on this line';
    return dot;
  }
}

/** CodeMirror 6 bound to a Y.Text: edits and remote cursors flow through Yjs. */
@Component({
  selector: 'qq-code-editor',
  template: '<div #host class="cm-host"></div>',
  styles: `
    qq-code-editor { display: block; height: 100%; min-height: 0; }
    qq-code-editor .cm-host { height: 100%; }
    qq-code-editor.hide-cursors .cm-ySelectionCaret { display: none; }
    qq-code-editor.hide-cursors .cm-ySelection { background: transparent !important; }
    qq-code-editor.hide-flags .cm-ySelectionInfo { display: none; }
  `,
  encapsulation: ViewEncapsulation.None,
  host: {
    '[style.--editor-font]': 'fontStack()',
    '[style.--editor-size]': 'sizePx()',
    '[style.--editor-lh]': 'lineHeightPx()',
    '[class.hide-cursors]': '!prefs.prefs().showOthersCursors',
    '[class.hide-flags]': '!prefs.prefs().showNameFlags',
  },
})
export class CodeEditorComponent {
  readonly ytext = input.required<Y.Text>();
  readonly awareness = input.required<Awareness>();
  readonly readonly = input(false);
  /** Lets completions see labels, bib keys and file names across the whole project. */
  readonly project = input<ProjectSource>();
  readonly cursor = output<{ line: number; col: number; sel: number }>();
  /** Margin notes in this file, as absolute ranges. */
  readonly notes = input<NoteMark[]>([]);
  /** Lines of this file that the last compile reported errors on (warnings are not passed in). */
  readonly errorLines = input<number[]>([]);
  /** The search panel's matches in this file (lit up in the text). */
  readonly searchMarks = input<SearchMarkSet | null>(null);
  /** Ctrl/⌘+F: open the search panel (with the selected words, if any). */
  readonly searchRequest = output<string>();
  /** Ctrl/⌘+G (Shift for backwards) or F3: go to the next match. */
  readonly searchStep = output<1 | -1>();
  /** A margin-note marker in the gutter was clicked. */
  readonly noteClick = output<string>();
  /** The scribe pressed the shortcut for a new margin note (Ctrl/⌘+Alt+M). */
  readonly noteShortcut = output<void>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private view?: EditorView;
  protected readonly prefs = inject(PreferencesService);
  protected readonly fontStack = computed(() => FONT_STACKS[this.prefs.prefs().fontFamily]);
  protected readonly sizePx = computed(() => `${this.prefs.prefs().fontSize}px`);
  protected readonly lineHeightPx = computed(() => `${this.prefs.prefs().lineHeight}px`);
  // pieces of the editor that follow the scribe's preferences while it is open
  private readonly gutterC = new Compartment();
  private readonly wrapC = new Compartment();
  private readonly closeC = new Compartment();
  private readonly spellC = new Compartment();

  constructor() {
    effect(() => {
      const text = this.ytext();
      const awareness = this.awareness();
      const readonly = this.readonly();
      untracked(() => this.mount(text, awareness, readonly, this.project()));
    });
    effect(() => {
      const marks = this.notes();
      untracked(() => this.view?.dispatch({ effects: setNotes.of(marks) }));
    });
    effect(() => {
      const marks = this.searchMarks() ?? { ranges: [], current: null };
      untracked(() => this.view?.dispatch({ effects: setSearchMarks.of(marks) }));
    });
    effect(() => {
      const lines = this.errorLines();
      untracked(() => this.view?.dispatch({ effects: setErrorLines.of(lines) }));
    });
    effect(() => {
      const p = this.prefs.prefs();
      untracked(() =>
        this.view?.dispatch({
          effects: [this.gutterC.reconfigure(this.gutterExt()), this.wrapC.reconfigure(this.wrapExt()), this.closeC.reconfigure(this.closeExt()), this.spellC.reconfigure(this.spellExt())],
        }),
      );
      // switching "show my cursor" off takes it down straight away; switching it on shows it at the next move
      if (!p.showMyCursor) untracked(() => this.awareness().setLocalStateField('cursor', null));
    });
    inject(DestroyRef).onDestroy(() => this.view?.destroy());
  }

  /** Run one of the text commands (the command menu uses these; the keys call the same code). */
  textCommand(name: 'bold' | 'italic' | 'underline' | 'emph' | 'mono' | 'sup' | 'sub' | 'comment' | 'itemize' | 'enumerate' | 'section' | 'subsection' | 'subsubsection' | 'undo' | 'redo' | 'selectAll'): void {
    const view = this.view;
    if (!view) return;
    const undoKey = (key: string) => yUndoManagerKeymap.find((k) => k.key === key)?.run;
    const run =
      name === 'undo' ? undoKey('Mod-z') ?? (() => false)
      : name === 'redo' ? undoKey('Mod-y') ?? (() => false)
      : name === 'selectAll' ? selectAll
      : name === 'comment' ? commentCommand
      : name === 'itemize' || name === 'enumerate' ? listCommand(name)
      : name === 'section' ? sectionCommand(0)
      : name === 'subsection' ? sectionCommand(1)
      : name === 'subsubsection' ? sectionCommand(2)
      : formatCommand(name);
    run(view);
    view.focus();
  }

  /** The selected words if they are a short single line (what Ctrl/⌘+F starts a search with). */
  private selectedWords(): string {
    const view = this.view;
    if (!view) return '';
    const { from, to } = view.state.selection.main;
    const text = view.state.sliceDoc(from, to);
    return from < to && text.length <= 120 && !text.includes('\n') ? text : '';
  }

  /** Give the keyboard back to the text (the search panel was closed). */
  focusText(): void {
    this.view?.focus();
  }

  /** Select a range and scroll it into view, without taking the keyboard from the search panel. */
  selectRange(from: number, to: number): void {
    const view = this.view;
    if (!view) return;
    const len = view.state.doc.length;
    const a = Math.min(from, len);
    const b = Math.min(to, len);
    view.dispatch({ selection: { anchor: a, head: b }, effects: EditorView.scrollIntoView(a, { y: 'center' }) });
  }

  /** Move the caret to a 1-based line (used when jumping to a compile error), and to a 1-based column when one is given. */
  revealLine(line: number, column?: number | null): void {
    const view = this.view;
    if (!view) return;
    const n = Math.min(Math.max(1, line), view.state.doc.lines);
    const at = view.state.doc.line(n);
    const pos = at.from + (column ? Math.min(Math.max(0, column - 1), at.length) : 0);
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    view.focus();
  }

  /** Insert at the caret (replacing any selection), on its own lines; flows to everyone through Yjs. */
  insertAtCursor(snippet: string): void {
    const view = this.view;
    if (!view || view.state.readOnly) return;
    const { from, to } = view.state.selection.main;
    const before = from > 0 && view.state.doc.sliceString(from - 1, from) !== '\n' ? '\n' : '';
    const text = before + snippet;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true });
    view.focus();
  }

  private gutterExt(): Extension {
    return this.prefs.prefs().lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [];
  }
  private wrapExt(): Extension {
    return this.prefs.prefs().wrapLines ? EditorView.lineWrapping : [];
  }
  private closeExt(): Extension {
    return this.prefs.prefs().autoClose ? closeBrackets() : [];
  }
  private spellExt(): Extension {
    return EditorView.contentAttributes.of({ spellcheck: this.prefs.prefs().spellcheck ? 'true' : 'false', autocorrect: 'off', autocapitalize: 'off' });
  }

  /** What `yCollab` sees as the awareness: the same, except that your own cursor is only published if you let it be. */
  private cursorGate(awareness: Awareness): Awareness {
    return new Proxy(awareness, {
      get: (target, key) => {
        if (key === 'setLocalStateField') return (field: string, value: unknown) => target.setLocalStateField(field, field === 'cursor' && !this.prefs.prefs().showMyCursor ? null : value);
        const v = Reflect.get(target, key) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }

  /** The selection (or the caret twice) in absolute positions, for starting a note. */
  selectionRange(): { from: number; to: number } {
    const sel = this.view?.state.selection.main;
    return sel ? { from: sel.from, to: sel.to } : { from: 0, to: 0 };
  }

  /** Put the caret where a drop landed (screen coordinates), so what is inserted goes there. */
  placeCaretAt(x: number, y: number): void {
    const view = this.view;
    if (!view) return;
    const pos = view.posAtCoords({ x, y }, false);
    if (pos !== null) view.dispatch({ selection: { anchor: pos } });
  }

  /** Scroll a range into view and select it, without taking the keyboard away from wherever it is. */
  revealRange(from: number, to: number): void {
    const view = this.view;
    if (!view) return;
    const len = view.state.doc.length;
    const a = Math.min(Math.max(0, from), len);
    const b = Math.min(Math.max(a, to), len);
    view.dispatch({ selection: { anchor: a, head: b }, effects: EditorView.scrollIntoView(a, { y: 'center' }) });
  }

  /** 1-based line of the caret. */
  cursorLine(): number {
    const view = this.view;
    return view ? view.state.doc.lineAt(view.state.selection.main.head).number : 1;
  }

  private mount(text: Y.Text, awareness: Awareness, readonly: boolean, project?: ProjectSource): void {
    this.view?.destroy();
    const undoManager = new Y.UndoManager(text);
    const view = new EditorView({
      parent: this.host().nativeElement,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          notesField,
          errorField,
          searchField,
          gutter({
            class: 'cm-notes-gutter',
            lineMarker: (view, line) => {
              const here = view.state.field(notesField).filter((m) => m.from >= line.from && m.from <= line.to);
              if (!here.length) return null;
              const open = here.filter((m) => !m.resolved);
              const shown = open.length ? open : here;
              return new NoteDot(shown.some((m) => m.selected), !open.length, here.length);
            },
            lineMarkerChange: (u) => u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(setNotes))),
            initialSpacer: () => new NoteDot(false, false, 1),
            domEventHandlers: {
              mousedown: (view, line) => {
                const hit = view.state.field(notesField).filter((m) => m.from >= line.from && m.from <= line.to);
                const pick = hit.find((m) => !m.resolved) ?? hit[0];
                if (!pick) return false;
                this.noteClick.emit(pick.id);
                return true;
              },
            },
          }),
          this.gutterC.of(this.gutterExt()),
          highlightActiveLine(),
          drawSelection(),
          bracketMatching(),
          this.closeC.of(this.closeExt()),
          autocompletion({ override: latexCompletions(project), icons: true, maxRenderedOptions: 80, defaultKeymap: false }),
          completionKeys,
          acceptCompletionWithTab,
          highlightSelectionMatches(),
          StreamLanguage.define(stex),
          this.wrapC.of(this.wrapExt()),
          this.spellC.of(this.spellExt()),
          tavernTheme,
          syntaxHighlighting(tavernHighlight),
          Prec.highest(textKeymap),
          Prec.highest(
            keymap.of([
              { key: 'Mod-f', run: () => (this.searchRequest.emit(this.selectedWords()), true), preventDefault: true },
              { key: 'Mod-Shift-f', run: () => (this.searchRequest.emit(this.selectedWords()), true), preventDefault: true },
              { key: 'Mod-g', run: () => (this.searchStep.emit(1), true), preventDefault: true },
              { key: 'Mod-Shift-g', run: () => (this.searchStep.emit(-1), true), preventDefault: true },
              { key: 'F3', run: () => (this.searchStep.emit(1), true), preventDefault: true },
              { key: 'Shift-F3', run: () => (this.searchStep.emit(-1), true), preventDefault: true },
            ]),
          ),
          keymap.of([{ key: 'Mod-Alt-m', preventDefault: true, run: () => (this.noteShortcut.emit(), true) }, ...yUndoManagerKeymap, ...defaultKeymap, indentWithTab]),
          yCollab(text, this.cursorGate(awareness), { undoManager }),
          EditorState.readOnly.of(readonly),
          EditorView.updateListener.of((u) => {
            if (u.selectionSet || u.docChanged) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              const sel = u.state.selection.main;
              this.cursor.emit({ line: line.number, col: head - line.from + 1, sel: sel.to - sel.from });
            }
          }),
        ],
      }),
    });
    this.view = view;
    view.dispatch({ effects: [setNotes.of(this.notes()), setErrorLines.of(this.errorLines()), setSearchMarks.of(this.searchMarks() ?? { ranges: [], current: null })] });
  }
}
