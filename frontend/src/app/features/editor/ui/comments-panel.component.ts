import { Component, computed, effect, input, output, signal, untracked, viewChild } from '@angular/core';
import { timeAgo } from '../../../core/api/scrolls.service';
import { Located, NoteFilter, NoteMessage, NoteThread, Segment, splitMentions } from '../../../core/collab/comments';
import { NoteInputComponent } from './note-input.component';

/** "Margin Notes": every thread in the scroll, newest conversation first in reading order, with a place to write more. */
@Component({
  selector: 'qq-comments-panel',
  imports: [NoteInputComponent],
  template: `
    <header>
      <span class="eyebrow-ink"><span aria-hidden="true">✎</span> Margin notes</span>
      <span class="chip chip--warn open-chip" [attr.aria-label]="openCount() + ' open'">{{ openCount() }} open</span>
      <button class="x" type="button" aria-label="Close margin notes" (click)="closed.emit()">✕</button>
    </header>

    <div class="chips" role="group" aria-label="Which notes">
      @for (f of filters; track f.key) {
        <button type="button" class="chip-f" [class.on]="filter() === f.key" [attr.aria-pressed]="filter() === f.key" (click)="filter.set(f.key)">{{ f.label }}</button>
      }
    </div>

    <ol class="threads" aria-label="Threads">
      @for (l of shown(); track l.thread.id) {
        <li>
          <article class="thread" [class.on]="selectedId() === l.thread.id" [class.resolved]="l.thread.resolved" [attr.data-thread]="l.thread.id">
            <button type="button" class="where" [attr.aria-label]="whereLabel(l)" (click)="select.emit(l.thread.id)">
              @if (l.thread.file !== activeFile()) { <b class="file">{{ l.thread.file }}</b> }
              <span class="ln">{{ l.line === null ? 'file removed' : 'line ' + l.line }}</span>
              @if (l.thread.quote) { <span class="quote">“{{ l.thread.quote }}”</span> }
              @if (l.lost && l.line !== null) { <em class="lost">the text was removed</em> }
            </button>

            @for (m of l.thread.messages; track m.id) {
              <div class="msg">
                <span class="av" [style.background]="m.authorColor" aria-hidden="true">{{ initials(m.authorName) }}</span>
                <div class="body">
                  <div class="who"><b>{{ m.authorName }}</b><time [attr.datetime]="iso(m.at)">{{ ago(m.at) }}</time>
                    @if (canRemove(m)) { <button type="button" class="del" [attr.aria-label]="'Delete your note from ' + ago(m.at)" title="Delete your note" (click)="removeMessage.emit({ id: l.thread.id, messageId: m.id })">✕</button> }
                  </div>
                  <p class="text">@for (s of segments(m); track $index) { @if (s.mention) { <span class="mention" [class.you]="s.you">{{ s.text }}</span> } @else { {{ s.text }} } }</p>
                </div>
              </div>
            }

            @if (l.thread.resolved) {
              <p class="done">Resolved@if (l.thread.resolvedBy) { by {{ l.thread.resolvedBy }} }</p>
            }
            @if (replying() === l.thread.id) {
              <qq-note-input #replyBox placeholder="Write a reply…" label="Write a reply" submitLabel="Reply" [names]="names()" [cancellable]="true" (submit)="doReply(l.thread.id, $event)" (cancel)="replying.set(null)" />
            } @else if (canWrite()) {
              <div class="actions">
                <button type="button" class="act" (click)="startReply(l.thread.id)">Reply</button>
                <button type="button" class="act" (click)="resolve.emit({ id: l.thread.id, resolved: !l.thread.resolved })"><span aria-hidden="true">{{ l.thread.resolved ? '↺' : '✓' }}</span> {{ l.thread.resolved ? 'Reopen' : 'Resolve' }}</button>
                @if (canDelete(l.thread)) { <button type="button" class="act danger" (click)="removeThread.emit(l.thread.id)">Delete thread</button> }
              </div>
            }
          </article>
        </li>
      } @empty {
        <li class="none">
          @if (all().length) { No {{ filter() === 'open' ? 'open' : 'resolved' }} notes. }
          @else { No margin notes yet. Select some text (or put the caret on a line) and write the first one below. }
        </li>
      }
    </ol>

    <div class="compose">
      @if (canWrite()) {
        <qq-note-input
          #composer
          [placeholder]="hint()"
          label="Write a margin note"
          submitLabel="Post note"
          [names]="names()"
          (submit)="post.emit($event)"
        />
      } @else {
        <p class="ro">Readers can read the margin notes but not write them.</p>
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 10px; padding: 16px 18px; min-height: 0; overflow: hidden; background: var(--wood-800); color: var(--text-1); }
    header { display: flex; align-items: center; gap: 10px; }
    .eyebrow-ink { flex: 1; font: 700 13px var(--font-heading); letter-spacing: 0.16em; text-transform: uppercase; color: var(--brass-500); }
    .open-chip { background: transparent; border-color: var(--candle-400); color: var(--candle-400); }
    .x { background: none; border: 0; font-size: 16px; color: var(--text-3); cursor: pointer; }
    .chips { display: flex; gap: 6px; }
    .chip-f { font: 700 11px var(--font-heading); padding: 3px 10px; border-radius: 3px; background: transparent; color: var(--text-1); border: 1px solid var(--brass-700); cursor: pointer; &.on { background: var(--brass-500); color: var(--ink-900); border-color: var(--brass-700); } }
    .threads { flex: 1; min-height: 80px; overflow: auto; list-style: none; margin: 0; padding: 0 2px 0 0; display: flex; flex-direction: column; gap: 10px; }
    .thread { padding: 10px 12px; border: 2px solid var(--wood-600); border-radius: 6px; background: rgb(var(--shade-rgb) / 0.5); display: flex; flex-direction: column; gap: 8px; &.on { border-color: var(--candle-400); background: rgb(var(--brass-rgb) / 0.1); } &.resolved { opacity: 0.8; } }
    .where { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; width: 100%; text-align: left; background: none; border: 0; padding: 0; cursor: pointer; color: inherit; font: 13px var(--font-mono); }
    .where .file { color: var(--text-1); } .where .ln { color: var(--candle-400); } .where .quote { color: var(--text-3); font-style: italic; font-family: var(--font-body); font-size: 15px; } .where .lost { color: var(--ember-500); font-size: 13px; }
    .msg { display: flex; gap: 10px; }
    .av { flex: none; width: 32px; height: 32px; border-radius: 50%; display: grid; place-content: center; font: 700 11px var(--font-heading); color: var(--ink-900); border: 2px solid var(--parchment-100); }
    .body { flex: 1; min-width: 0; }
    .who { display: flex; align-items: baseline; gap: 8px; b { font: 700 13px var(--font-heading); text-transform: uppercase; } time { font: italic 13px var(--font-body); color: var(--text-3); } .del { margin-left: auto; background: none; border: 0; color: var(--text-3); cursor: pointer; font-size: 12px; visibility: hidden; } }
    .msg:hover .del, .msg:focus-within .del { visibility: visible; }
    .text { margin: 2px 0 0; font: 17px/1.35 var(--font-body); white-space: pre-wrap; overflow-wrap: anywhere; }
    .mention { color: var(--candle-400); font-weight: 600; &.you { background: rgb(var(--glow-rgb) / 0.2); border-radius: 3px; padding: 0 3px; } }
    .done { margin: 0; font: italic 14px var(--font-body); color: var(--ale-500); }
    .actions { display: flex; gap: 14px; align-items: center; }
    .act { background: none; border: 0; padding: 0; font: 700 14px var(--font-body); color: var(--text-2); cursor: pointer; &:hover { color: var(--candle-400); } &.danger { margin-left: auto; color: var(--text-3); &:hover { color: var(--ember-500); } } span { color: var(--ale-500); } }
    .none { font: italic 16px var(--font-body); color: var(--text-3); padding: 6px 2px; }
    .compose { border-top: 1px solid var(--wood-600); padding-top: 10px; }
    .ro { margin: 0; font: italic 15px var(--font-body); color: var(--text-3); }
  `,
})
export class CommentsPanelComponent {
  readonly threads = input<Array<Located<NoteThread>>>([]);
  readonly activeFile = input<string | null>(null);
  readonly selectedId = input<string | null>(null);
  /** Where a new note would go: the caret's line, and whether text is selected. */
  readonly cursorLine = input(1);
  readonly hasSelection = input(false);
  readonly meId = input<string | null>(null);
  readonly meName = input('');
  readonly canWrite = input(false);
  readonly canManage = input(false);
  /** Display names of everyone with a seat at the table (for `@` suggestions and highlighting). */
  readonly names = input<string[]>([]);

  readonly closed = output<void>();
  readonly select = output<string>();
  readonly post = output<string>();
  readonly reply = output<{ id: string; text: string }>();
  readonly resolve = output<{ id: string; resolved: boolean }>();
  readonly removeMessage = output<{ id: string; messageId: string }>();
  readonly removeThread = output<string>();

  private readonly composer = viewChild<NoteInputComponent>('composer');
  private readonly replyBox = viewChild<NoteInputComponent>('replyBox');

  protected readonly filters: Array<{ key: NoteFilter; label: string }> = [
    { key: 'open', label: 'Open' },
    { key: 'resolved', label: 'Resolved' },
    { key: 'all', label: 'All' },
  ];
  protected readonly filter = signal<NoteFilter>('open');
  protected readonly replying = signal<string | null>(null);

  protected readonly all = computed(() => this.threads());
  protected readonly openCount = computed(() => this.threads().filter((l) => !l.thread.resolved).length);
  protected readonly shown = computed(() => this.threads().filter((l) => (this.filter() === 'all' ? true : this.filter() === 'open' ? !l.thread.resolved : l.thread.resolved)));
  protected readonly hint = computed(() => `Write a note about ${this.hasSelection() ? 'the selection' : 'line ' + this.cursorLine()}… use @ to mention`);

  constructor() {
    // when a note is picked in the editor, bring its card into view
    effect(() => {
      const id = this.selectedId();
      if (!id) return;
      untracked(() => queueMicrotask(() => document.querySelector(`qq-comments-panel [data-thread="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })));
    });
  }

  focusComposer(): void {
    this.composer()?.focus();
  }

  /** The note was posted: empty the box. */
  clearComposer(): void {
    this.composer()?.clear();
  }

  protected startReply(id: string): void {
    this.replying.set(id);
    queueMicrotask(() => this.replyBox()?.focus());
  }

  protected doReply(id: string, text: string): void {
    this.reply.emit({ id, text });
    this.replying.set(null);
  }

  protected segments(m: NoteMessage): Segment[] {
    return splitMentions(m.text, this.names(), this.meName());
  }

  protected initials(name: string): string {
    return name.replace(/^(Sir|Dame|Lady|Brother)\s+/i, '').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  }

  protected ago(at: number): string {
    return timeAgo(new Date(at).toISOString());
  }
  protected iso(at: number): string {
    return new Date(at).toISOString();
  }

  protected canRemove(m: NoteMessage): boolean {
    return this.canWrite() && !!this.meId() && m.authorId === this.meId();
  }

  protected canDelete(t: NoteThread): boolean {
    return this.canManage() || (!!this.meId() && t.messages[0]?.authorId === this.meId());
  }

  protected whereLabel(l: Located<NoteThread>): string {
    return `Show the note on ${l.thread.file}${l.line ? ', line ' + l.line : ''}`;
  }
}
