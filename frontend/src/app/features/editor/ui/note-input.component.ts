import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { MAX_NOTE_CHARS, insertMention, mentionQuery, suggestScribes } from '../../../core/collab/comments';

/** A small text box for a note or a reply, with `@` suggestions of the scribes at the table. Enter sends, Shift+Enter breaks the line. */
@Component({
  selector: 'qq-note-input',
  template: `
    <div class="box">
      <textarea
        #ta
        rows="2"
        [attr.maxlength]="max"
        [attr.aria-label]="label()"
        [placeholder]="placeholder()"
        [disabled]="disabled()"
        [attr.aria-expanded]="suggestions().length > 0"
        aria-autocomplete="list"
        [value]="text()"
        (input)="onInput($event)"
        (keydown)="onKey($event)"
        (click)="refresh()"
        (keyup)="onKeyUp($event)"
      ></textarea>
      @if (suggestions().length) {
        <ul class="pick" role="listbox" aria-label="Scribes to mention">
          @for (n of suggestions(); track n; let i = $index) {
            <li role="option" [attr.aria-selected]="i === active()"><button type="button" [class.on]="i === active()" (mousedown)="$event.preventDefault()" (click)="choose(n)">@{{ n }}</button></li>
          }
        </ul>
      }
    </div>
    <div class="row">
      <button type="button" class="at" [disabled]="disabled()" (click)="insertAt()" title="Mention a scribe"><span aria-hidden="true">@</span> Mention a scribe</button>
      <span class="sp"></span>
      @if (cancellable()) { <button type="button" class="btn btn--ink btn--sm" (click)="cancel.emit()">Cancel</button> }
      <button type="button" class="btn btn--sm" [disabled]="disabled() || !text().trim()" (click)="send()">{{ submitLabel() }}</button>
    </div>
  `,
  styles: `
    :host { display: block; }
    .box { position: relative; }
    textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 52px; max-height: 160px; padding: 8px 10px; font: italic 16px var(--font-body); color: var(--ink-900); background: var(--parchment-200); border: 2px solid var(--brass-700); border-radius: 4px; &::placeholder { color: var(--ink-600); } &:disabled { opacity: 0.6; } &:not(:placeholder-shown) { font-style: normal; } }
    .pick { position: absolute; z-index: 20; left: 0; right: 0; bottom: calc(100% + 4px); margin: 0; padding: 4px; list-style: none; background: var(--parchment-100); border: 2px solid var(--wood-900); border-radius: 6px; box-shadow: 0 10px 22px rgb(0 0 0 / 0.55);
      button { width: 100%; text-align: left; padding: 5px 10px; background: none; border: 0; border-radius: 3px; font: 600 15px var(--font-body); color: var(--ink-900); cursor: pointer; &.on, &:hover { background: var(--parchment-300); } } }
    .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    .sp { flex: 1; }
    .at { background: none; border: 0; padding: 2px 4px; font: italic 14px var(--font-body); color: var(--text-3); cursor: pointer; &:hover:not(:disabled) { color: var(--candle-400); } &:disabled { opacity: 0.5; cursor: default; } span { margin-right: 4px; color: var(--brass-500); font-style: normal; font-weight: 700; } }
  `,
})
export class NoteInputComponent {
  readonly placeholder = input('Write a note…');
  readonly label = input('Write a note');
  readonly submitLabel = input('Post note');
  /** Names of the scribes that `@` can suggest. */
  readonly names = input<string[]>([]);
  readonly disabled = input(false);
  readonly cancellable = input(false);
  readonly submit = output<string>();
  readonly cancel = output<void>();

  protected readonly max = MAX_NOTE_CHARS;
  private readonly ta = viewChild.required<ElementRef<HTMLTextAreaElement>>('ta');
  protected readonly text = signal('');
  private readonly caret = signal(0);
  protected readonly active = signal(0);
  private readonly dismissed = signal(false);

  protected readonly suggestions = computed(() => {
    if (this.disabled() || this.dismissed()) return [];
    const q = mentionQuery(this.text(), this.caret());
    if (!q) return [];
    // `@Marcus Reed ` is a finished mention, not a search for one
    const finished = /\s$/.test(q.query) && this.names().some((n) => n.toLowerCase() === q.query.trim().toLowerCase());
    return finished ? [] : suggestScribes(this.names(), q.query);
  });

  focus(): void {
    this.ta().nativeElement.focus();
  }

  clear(): void {
    this.text.set('');
    this.caret.set(0);
    this.dismissed.set(false);
    this.ta().nativeElement.value = ''; // the typed text is the DOM's own, so write it back directly
  }

  protected onInput(e: Event): void {
    const el = e.target as HTMLTextAreaElement;
    this.text.set(el.value);
    this.caret.set(el.selectionStart);
    this.active.set(0);
    this.dismissed.set(false);
  }

  protected refresh(): void {
    this.caret.set(this.ta().nativeElement.selectionStart);
  }

  protected onKeyUp(e: KeyboardEvent): void {
    if (e.key.startsWith('Arrow') && !this.suggestions().length) this.refresh();
  }

  protected onKey(e: KeyboardEvent): void {
    const list = this.suggestions();
    if (list.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.active.update((i) => (i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.choose(list[Math.min(this.active(), list.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.dismissed.set(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send();
    } else if (e.key === 'Escape' && this.cancellable()) {
      e.preventDefault();
      this.cancel.emit();
    }
  }

  protected choose(name: string): void {
    const q = mentionQuery(this.text(), this.caret());
    if (!q) return;
    const next = insertMention(this.text(), this.caret(), q.start, name);
    this.text.set(next.text);
    this.caret.set(next.caret);
    this.active.set(0);
    this.dismissed.set(true);
    const el = this.ta().nativeElement;
    el.value = next.text;
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  }

  protected insertAt(): void {
    const el = this.ta().nativeElement;
    const at = el.selectionStart;
    const before = this.text().slice(0, at);
    const lead = before && !/\s$/.test(before) ? ' @' : '@';
    const next = before + lead + this.text().slice(el.selectionEnd);
    this.text.set(next);
    el.value = next;
    this.dismissed.set(false);
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(before.length + lead.length, before.length + lead.length);
      this.caret.set(before.length + lead.length);
    });
  }

  protected send(): void {
    const t = this.text().trim();
    if (!t || this.disabled()) return;
    this.submit.emit(t);
  }
}
