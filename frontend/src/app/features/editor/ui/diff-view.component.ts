import { Component, computed, effect, input, output, signal, untracked } from '@angular/core';
import { ViewedVersion } from '../../../core/api/versions.service';
import { FileChange, FileStatus, Row, compareFiles, diffLines, foldContext, splitLines, totals, whenLabel } from '../../../core/collab/diff';

/** A read-only look at an older version, drawn as what restoring it would change in the live scroll. */
@Component({
  selector: 'qq-diff-view',
  template: `
    <div class="bar">
      <span class="pill" role="status">
        <span aria-hidden="true">⟲</span>
        Viewing {{ when() }} · read-only
      </span>
      <span class="sp"></span>
      <button type="button" class="link" (click)="refresh.emit()" title="Compare with the live scroll again">Compare again</button>
      <button type="button" class="back" (click)="back.emit()">Back to now</button>
    </div>

    <div class="tabs" role="tablist" aria-label="Files">
      @for (c of changes(); track c.path) {
        <button type="button" role="tab" class="tab" [class.on]="c.path === active()" [attr.aria-selected]="c.path === active()" (click)="open(c.path)">
          <span class="nm">{{ c.path }}</span>
          @switch (c.status) {
            @case ('changed') { <span class="bd"><b class="a">+{{ c.add }}</b> <b class="d">−{{ c.del }}</b></span> }
            @case ('added') { <span class="bd"><b class="a">comes back</b></span> }
            @case ('removed') { <span class="bd"><b class="d">goes away</b></span> }
          }
        </button>
      }
    </div>

    <p class="legend">
      @if (sum().files) { <b>Restoring would change {{ sum().files }} {{ sum().files === 1 ? 'file' : 'files' }}</b> (<span class="a">+{{ sum().add }}</span> <span class="d">−{{ sum().del }}</span> lines). Green lines would come back, red lines would go away. Pictures are not part of snapshots. }
      @else { <b>This version matches the live scroll.</b> }
    </p>

    <div class="code" role="region" [attr.aria-label]="'Changes in ' + active()" tabindex="0">
      @for (r of rows(); track $index) {
        @if (r.kind === 'fold') {
          <button type="button" class="fold" (click)="unfold(r.id)">⋯ {{ r.lines.length }} unchanged {{ r.lines.length === 1 ? 'line' : 'lines' }}</button>
        } @else {
          <div class="ln" [class.add]="r.type === 'add'" [class.del]="r.type === 'del'">
            <span class="no" aria-hidden="true">{{ r.old ?? '' }}</span>
            <span class="mk" aria-hidden="true">{{ r.type === 'add' ? '+' : r.type === 'del' ? '−' : '' }}</span>
            @if (r.type !== 'same') { <span class="sr">{{ r.type === 'add' ? 'comes back: ' : 'goes away: ' }}</span> }
            <span class="tx">{{ r.text || ' ' }}</span>
          </div>
        }
      } @empty {
        <p class="none">This file is empty in both versions.</p>
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 0; flex: 1; background: var(--wood-900); }
    .bar { display: flex; align-items: center; gap: 12px; padding: 6px 12px; background: rgb(var(--shade-rgb) / 0.6); border-bottom: 1px solid var(--wood-600); }
    .sp { flex: 1; }
    .pill { font: 700 13px var(--font-heading); padding: 4px 12px; border: 2px solid var(--brass-500); border-radius: 4px; color: var(--candle-400); background: rgb(var(--brass-rgb) / 0.14); }
    .link { background: none; border: 0; color: var(--text-3); font: italic 14px var(--font-body); text-decoration: underline; cursor: pointer; &:hover { color: var(--candle-400); } }
    .back { font: 700 12px var(--font-heading); padding: 5px 12px; border-radius: 4px; background: transparent; color: var(--text-1); border: 1px solid var(--brass-500); cursor: pointer; &:hover { background: rgb(var(--glow-rgb) / 0.12); } }
    .tabs { display: flex; gap: 2px; overflow-x: auto; padding: 4px 8px 0; background: rgb(var(--shade-rgb) / 0.6); border-bottom: 1px solid var(--wood-600); }
    .tab { display: flex; align-items: center; gap: 8px; white-space: nowrap; padding: 6px 10px; font: 13px var(--font-mono); color: var(--text-3); background: none; border: 0; border-bottom: 2px solid transparent; cursor: pointer; &.on { color: var(--text-1); border-bottom-color: var(--brass-500); } &:hover:not(.on) { color: var(--text-1); } }
    .bd { font: 700 11px var(--font-mono); } .a { color: var(--diff-add); font-weight: 700; } .d { color: var(--diff-del); font-weight: 700; }
    .legend { margin: 0; padding: 8px 14px; font: italic 15px var(--font-body); color: var(--text-2); border-bottom: 1px solid var(--wood-600); b { font-style: normal; color: var(--text-1); } }
    .code { flex: 1; min-height: 0; overflow: auto; padding: 6px 0 16px; font: 14px/22px var(--font-mono); color: var(--text-1); outline: none; &:focus-visible { box-shadow: inset 0 0 0 2px var(--candle-400); } }
    .ln { display: flex; min-width: max-content; padding-right: 16px; &.add { background: rgb(111 143 78 / 0.28); } &.del { background: rgb(155 48 48 / 0.38); } }
    .no { flex: none; width: 52px; padding-right: 10px; text-align: right; color: var(--text-3); opacity: 0.7; user-select: none; }
    .mk { flex: none; width: 22px; text-align: center; font-weight: 700; user-select: none; } .add .mk { color: var(--diff-add); } .del .mk { color: var(--diff-del); }
    .tx { white-space: pre; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    .fold { display: block; width: 100%; padding: 2px 0 2px 76px; text-align: left; background: rgb(var(--glow-rgb) / 0.06); border: 0; border-block: 1px solid var(--wood-600); color: var(--text-3); font: italic 13px var(--font-body); cursor: pointer; &:hover { color: var(--candle-400); } }
    .none { margin: 16px; font-style: italic; color: var(--text-3); }
  `,
})
export class DiffViewComponent {
  readonly viewed = input.required<ViewedVersion>();
  /** The live scroll's text files at the moment of comparing. */
  readonly now = input.required<ReadonlyMap<string, string>>();
  readonly back = output<void>();
  readonly refresh = output<void>();

  protected readonly active = signal('');
  private readonly unfolded = signal<ReadonlySet<number>>(new Set());

  protected readonly when = computed(() => (this.viewed().info.label && !this.viewed().info.auto ? `“${this.viewed().info.label}”, ` : '') + whenLabel(this.viewed().info.createdAt).toLowerCase().replace('·', '·'));
  protected readonly changes = computed<FileChange[]>(() => compareFiles(this.now(), this.viewed().files));
  protected readonly sum = computed(() => totals(this.changes()));
  protected readonly rows = computed<Row[]>(() => {
    const path = this.active();
    const status: FileStatus | undefined = this.changes().find((c) => c.path === path)?.status;
    if (!status) return [];
    const lines = diffLines(splitLines(this.now().get(path) ?? ''), splitLines(this.viewed().files.get(path) ?? ''));
    const open = this.unfolded();
    return foldContext(lines).flatMap((r) => (r.kind === 'fold' && open.has(r.id) ? r.lines.map((l) => ({ kind: 'line' as const, ...l })) : [r]));
  });

  constructor() {
    // land on the first file that differs (or the first file at all), and keep the choice while it still exists
    effect(() => {
      const list = this.changes();
      untracked(() => {
        if (!list.some((c) => c.path === this.active())) this.active.set((list.find((c) => c.status !== 'same') ?? list[0])?.path ?? '');
      });
    });
  }

  protected open(path: string): void {
    this.active.set(path);
    this.unfolded.set(new Set());
  }
  protected unfold(id: number): void {
    this.unfolded.update((s) => new Set(s).add(id));
  }
}
