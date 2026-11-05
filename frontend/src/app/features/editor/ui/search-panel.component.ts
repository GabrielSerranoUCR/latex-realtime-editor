import { Component, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { CollabService } from '../../../core/collab/collab.service';
import { DEFAULT_SEARCH, Hit, NO_RESULT, SearchOptions, SearchResult, editsOf, flatHits, searchFiles, stepIndex, summary } from '../../../core/search/search';

/** What the editor should light up: every match, per file, and the one the panel is on. */
export interface SearchMarks {
  ranges: Record<string, Array<{ from: number; to: number }>>;
  current: Hit | null;
}

/** "Search the Tavern": find (and replace) across every file of the scroll, results grouped by file. */
@Component({
  selector: 'qq-search-panel',
  template: `
    <section class="panel-box" role="search" aria-label="Search and replace in this scroll" (keydown.escape)="closed.emit()">
      <header>
        <span class="mag" aria-hidden="true">⌕</span>
        <h2>Search the Tavern</h2>
        <span class="sp"></span>
        <span class="count" role="status" aria-live="polite">{{ status() }}</span>
        <button class="x" type="button" aria-label="Close search" (click)="closed.emit()">✕</button>
      </header>

      <input
        #find
        class="field"
        type="text"
        aria-label="Find"
        placeholder="Find in every file…"
        autocomplete="off"
        spellcheck="false"
        [value]="query()"
        (input)="query.set(find.value); cur.set(0); confirm.set(false)"
        (keydown.enter)="$event.preventDefault(); step(1)"
        (keydown.shift.enter)="$event.preventDefault(); step(-1)"
      />
      @if (canEdit()) {
        <input
          #repl
          class="field"
          type="text"
          aria-label="Replace with"
          placeholder="Replace with…"
          autocomplete="off"
          spellcheck="false"
          [value]="replacement()"
          (input)="replacement.set(repl.value); confirm.set(false)"
          (keydown.enter)="$event.preventDefault(); replaceCurrent()"
        />
      }
      @if (result().error; as e) { <p class="bad" role="alert">{{ e }}</p> }

      <div class="chips" role="group" aria-label="Search options">
        <button type="button" class="chip" [class.on]="opts().caseSensitive" [attr.aria-pressed]="opts().caseSensitive" title="Match case" (click)="toggle('caseSensitive')">Aa</button>
        <button type="button" class="chip" [class.on]="opts().regex" [attr.aria-pressed]="opts().regex" title="Regular expression" (click)="toggle('regex')">.*</button>
        <button type="button" class="chip" [class.on]="opts().wholeWord" [attr.aria-pressed]="opts().wholeWord" title="Whole words only" (click)="toggle('wholeWord')">whole word</button>
        <button type="button" class="chip" [class.on]="thisFile()" [attr.aria-pressed]="thisFile()" title="Only the file you have open" (click)="thisFile.set(!thisFile()); cur.set(0); confirm.set(false)">this file</button>
      </div>

      @if (canEdit()) {
        <div class="acts">
          <button type="button" class="btn" [disabled]="!result().total || result().truncated" (click)="replaceAll()">{{ confirm() ? 'Replace ' + result().total + '? Click again' : 'Replace all' }}</button>
          <button type="button" class="btn btn--ghost" [disabled]="!result().total" (click)="replaceCurrent()">Replace</button>
        </div>
        @if (result().truncated) { <p class="note">Too many matches to replace at once. Narrow the search first.</p> }
        @if (done(); as d) { <p class="note ok" role="status">{{ d }}</p> }
      }

      <hr />
      <div class="results" aria-label="Matches">
        @for (g of result().files; track g.path) {
          <div class="group">
            <button type="button" class="ghead" [attr.aria-expanded]="!collapsed().has(g.path)" (click)="fold(g.path)">
              <span class="chev" aria-hidden="true">{{ collapsed().has(g.path) ? '›' : '⌄' }}</span>
              <span class="doc" aria-hidden="true">▤</span>
              <b>{{ g.path }}</b>
              <em>{{ g.hits.length }}</em>
            </button>
            @if (!collapsed().has(g.path)) {
              @for (h of g.hits; track h.from) {
                <button type="button" class="hit" [class.on]="h === current()" [attr.aria-label]="g.path + ' line ' + h.line + ': ' + h.match" (click)="pick(h)">
                  <span class="ln">{{ h.line }}</span>
                  <span class="txt">{{ h.before }}<mark>{{ h.match }}</mark>{{ h.after }}</span>
                </button>
              }
            }
          </div>
        } @empty {
          @if (query() && !result().error) { <p class="none">Nothing in the tavern matches “{{ query() }}”.</p> }
        }
      </div>
    </section>
  `,
  styleUrl: './search-panel.component.scss',
})
export class SearchPanelComponent {
  readonly canEdit = input(false);
  /** Text to start with (the selected words), applied each time `focusKey` changes. */
  readonly prefill = input('');
  readonly focusKey = input(0);

  /** The panel wants this match shown in the editor. */
  readonly jump = output<Hit>();
  readonly closed = output<void>();

  private readonly collab = inject(CollabService);
  private readonly findEl = viewChild<ElementRef<HTMLInputElement>>('find');

  protected readonly query = signal('');
  protected readonly replacement = signal('');
  protected readonly opts = signal<SearchOptions>({ ...DEFAULT_SEARCH });
  protected readonly thisFile = signal(false);
  protected readonly cur = signal(0);
  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());
  protected readonly confirm = signal(false);
  protected readonly done = signal<string | null>(null);
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly result = computed<SearchResult>(() => {
    this.collab.docVersion(); // look again whenever anybody changes a file
    const q = this.query();
    if (!q) return NO_RESULT;
    const only = this.thisFile() ? this.collab.activeFile() : null;
    const files = this.collab
      .files()
      .filter((p) => !only || p === only)
      .map((path) => ({ path, text: this.collab.fileText(path) ?? '' }));
    return searchFiles(files, q, this.opts(), this.replacement());
  });
  private readonly hits = computed(() => flatHits(this.result()));
  protected readonly current = computed<Hit | null>(() => this.hits()[Math.min(this.cur(), this.hits().length - 1)] ?? null);
  protected readonly status = computed(() => (this.query() && !this.result().error ? summary(this.result(), this.thisFile()) : ''));

  /** For the editor: every match per file, and the current one. */
  readonly marks = computed<SearchMarks | null>(() => {
    const r = this.result();
    if (!this.query() || !r.total) return null;
    const ranges: SearchMarks['ranges'] = {};
    for (const g of r.files) ranges[g.path] = g.hits.map((h) => ({ from: h.from, to: h.to }));
    return { ranges, current: this.current() };
  });

  constructor() {
    // opened, or asked for again (Ctrl/⌘+F once more): take the selected words and put the caret in the field
    effect(() => {
      this.focusKey();
      const pre = untracked(() => this.prefill());
      untracked(() => {
        if (pre) {
          this.query.set(pre);
          this.cur.set(0);
        }
        queueMicrotask(() => {
          const el = this.findEl()?.nativeElement;
          if (!el) return;
          el.value = this.query();
          el.focus();
          el.select();
        });
      });
    });
  }

  protected toggle(key: keyof SearchOptions): void {
    this.opts.update((o) => ({ ...o, [key]: !o[key] }));
    this.cur.set(0);
    this.confirm.set(false);
  }

  protected fold(path: string): void {
    this.collapsed.update((c) => {
      const next = new Set(c);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  /** Go to the next or the previous match and show it in the editor. */
  step(dir: 1 | -1): void {
    const n = this.hits().length;
    if (!n) return;
    this.cur.set(stepIndex(Math.min(this.cur(), n - 1), n, dir));
    const h = this.current();
    if (h) this.jump.emit(h);
  }

  protected pick(h: Hit): void {
    this.cur.set(Math.max(0, this.hits().indexOf(h)));
    this.jump.emit(h);
  }

  /** Replace the match the panel is on, then move on to the next (which has slid into its place). */
  protected replaceCurrent(): void {
    const h = this.current();
    if (!h || !this.canEdit()) return;
    this.done.set(null);
    if (!this.collab.applyEdits(h.path, [{ from: h.from, to: h.to, insert: h.insert }])) return;
    const next = this.current();
    if (next) this.jump.emit(next);
  }

  /** Two clicks: the first only asks "really?", so a stray click never rewrites the whole scroll. */
  protected replaceAll(): void {
    const r = this.result();
    if (!r.total || r.truncated || !this.canEdit()) return;
    if (!this.confirm()) {
      this.confirm.set(true);
      clearTimeout(this.confirmTimer);
      this.confirmTimer = setTimeout(() => this.confirm.set(false), 5000);
      return;
    }
    clearTimeout(this.confirmTimer);
    this.confirm.set(false);
    let n = 0;
    let files = 0;
    for (const g of r.files) {
      if (this.collab.applyEdits(g.path, editsOf(g.hits))) {
        n += g.hits.length;
        files++;
      }
    }
    this.done.set(`Replaced ${n} ${n === 1 ? 'match' : 'matches'} in ${files} ${files === 1 ? 'file' : 'files'}.`);
  }
}
