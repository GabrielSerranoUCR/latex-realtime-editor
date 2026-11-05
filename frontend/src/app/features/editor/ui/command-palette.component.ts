import { Component, DestroyRef, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { PALETTE_FILTERS, PALETTE_SECTIONS, PaletteItem, filterPalette, shortcutLabel } from '../../../core/palette/palette';

/** The command menu (⌘K / Ctrl+K): type to find an action, a file or a bit of help, then press Enter. */
@Component({
  selector: 'qq-command-palette',
  template: `
    <dialog class="palette" #dlg aria-label="Command menu" (close)="shown.set(false)" (cancel)="shown.set(false)" (click)="backdrop($event)">
      <div class="box" (keydown)="key($event)">
        <div class="query">
          <span class="mag" aria-hidden="true">⌕</span>
          <input
            #q
            type="text"
            role="combobox"
            aria-label="Search commands, files and help"
            aria-controls="palette-list"
            aria-autocomplete="list"
            [attr.aria-expanded]="true"
            [attr.aria-activedescendant]="results().length ? 'pal-' + active() : null"
            placeholder="Type a command, a file name, or a question…"
            autocomplete="off"
            spellcheck="false"
            [value]="query()"
            (input)="query.set(q.value); active.set(0)"
          />
          <kbd>esc</kbd>
        </div>
        <div class="kinds" role="tablist" aria-label="Show">
          @for (f of filters; track f.key) {
            <button type="button" role="tab" [class.on]="kind() === f.key" [attr.aria-selected]="kind() === f.key" tabindex="-1" (click)="setKind(f.key)">
              {{ f.label }}<kbd>{{ f.keys }}</kbd>
            </button>
          }
        </div>
        <ul id="palette-list" role="listbox" aria-label="Results">
          @for (section of sections(); track section.name) {
            <li class="sec" role="presentation">{{ section.name }}</li>
            @for (r of section.rows; track r.item.id) {
              <li
                role="option"
                [id]="'pal-' + r.index"
                [class.on]="r.index === active()"
                [attr.aria-selected]="r.index === active()"
                (mousemove)="active.set(r.index)"
                (click)="choose(r.item, !($event.metaKey || $event.ctrlKey))"
              >
                <i class="bar" aria-hidden="true"></i>
                <span class="ico" aria-hidden="true">{{ r.item.icon }}</span>
                <span class="txt"><b>{{ r.item.title }}</b><em>{{ r.item.hint }}</em></span>
                @if (r.item.keys) { <kbd>{{ r.item.keys }}</kbd> }
              </li>
            }
          } @empty {
            <li class="none" role="presentation">{{ query() ? 'Nothing in the tavern matches “' + query() + '”.' : 'Nothing of this kind yet.' }}</li>
          }
        </ul>
        <div class="hints" aria-hidden="true">
          <span><b>↑↓</b><em>navigate</em></span>
          <span><b>↵</b><em>open</em></span>
          <span><b>{{ mod }}↵</b><em>run and keep open</em></span>
          <span><b>{{ alt }}1–4</b><em>show one kind</em></span>
          <span><b>esc</b><em>close</em></span>
        </div>
      </div>
    </dialog>
  `,
  styleUrl: './command-palette.component.scss',
})
export class CommandPaletteComponent {
  readonly items = input.required<PaletteItem[]>();

  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('q');

  protected readonly shown = signal(false);
  protected readonly query = signal('');
  protected readonly active = signal(0);
  protected readonly filters = PALETTE_FILTERS.map((f) => ({ ...f, keys: shortcutLabel('⌥' + f.key) }));
  protected readonly mod = shortcutLabel('⌘');
  protected readonly alt = shortcutLabel('⌥');
  /** Which kind is showing: the key of the filter (1 = all). */
  protected readonly kind = signal('1');
  protected readonly results = computed(() => filterPalette(this.items(), this.query(), PALETTE_FILTERS.find((f) => f.key === this.kind())?.only ?? null));
  /** The results grouped under their headings, each with its place in the whole list (for the arrow keys). */
  protected readonly sections = computed(() => {
    const all = this.results();
    return PALETTE_SECTIONS.map((name) => ({ name, rows: all.map((item, index) => ({ item, index })).filter((r) => r.item.section === name) })).filter((s) => s.rows.length);
  });

  constructor() {
    // ⌘1 to ⌘4 (Ctrl on Windows and Linux) are the browser's own "go to tab" keys. Listening first (capture) and
    // calling preventDefault lets the page keep them while the menu is open. Matched by the physical key, so they
    // also work on keyboards where the digits need Shift (French) and with the number pad.
    const onKey = (e: KeyboardEvent): void => {
      // ⌘1–4 / Ctrl+1–4, or ⌥1–4 (Alt): Safari keeps ⌘1–9 for its own tabs and no page can take them back, so Option works everywhere
      const mod = e.metaKey || e.ctrlKey;
      if (!this.shown() || e.shiftKey || (mod ? e.altKey : !e.altKey)) return;
      const digit = /^(?:Digit|Numpad)([1-4])$/.exec(e.code)?.[1] ?? (PALETTE_FILTERS.some((f) => f.key === e.key) ? e.key : null);
      if (!digit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.setKind(digit);
    };
    window.addEventListener('keydown', onKey, true);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('keydown', onKey, true));
  }

  get isOpen(): boolean {
    return this.shown();
  }

  open(query = ''): void {
    this.query.set(query);
    this.kind.set('1');
    this.active.set(0);
    this.shown.set(true);
    this.field().nativeElement.value = query; // now, not at the next render: fast typing must not land after the old text
    const el = this.dlg().nativeElement;
    if (!el.open) el.showModal();
    this.field().nativeElement.focus();
  }

  close(): void {
    const el = this.dlg().nativeElement;
    if (el.open) el.close();
    this.shown.set(false);
  }

  /** Ctrl/⌘+K: open it, or close it when it is already open. */
  toggle(): void {
    if (this.shown()) this.close();
    else this.open();
  }

  protected setKind(key: string): void {
    this.kind.set(key);
    this.active.set(0);
    this.field().nativeElement.focus();
  }

  protected choose(item: PaletteItem, close = true): void {
    if (close) this.close();
    item.run();
  }

  protected backdrop(e: MouseEvent): void {
    if (e.target === this.dlg().nativeElement) this.close(); // a click on the dim area around the box
  }

  protected key(e: KeyboardEvent): void {
    const n = this.results().length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) this.active.set((this.active() + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
      this.scrollToActive();
    } else if (e.key === 'Home' || e.key === 'End') {
      if (!n) return;
      e.preventDefault();
      this.active.set(e.key === 'Home' ? 0 : n - 1);
      this.scrollToActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation(); // ⌘↵ here must not also compile the scroll
      const item = this.results()[this.active()];
      if (item) this.choose(item, !(e.metaKey || e.ctrlKey));
    }
  }

  /** Keep the highlighted row in view. It is found by its id (the row exists already; the highlight class only follows after the next render). */
  private scrollToActive(): void {
    const list = this.dlg().nativeElement.querySelector<HTMLElement>('#palette-list');
    const row = list?.querySelector<HTMLElement>('#pal-' + this.active());
    if (!list || !row) return;
    if (this.active() === 0) list.scrollTop = 0; // the first row: show its heading too
    else row.scrollIntoView?.({ block: 'nearest' });
  }
}
