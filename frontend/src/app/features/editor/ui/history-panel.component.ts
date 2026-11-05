import { Component, DestroyRef, ElementRef, OnInit, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { VersionDetail, VersionInfo, VersionsService, ViewedVersion } from '../../../core/api/versions.service';
import { apiMessage } from '../../../core/auth/auth.service';
import { CollabService } from '../../../core/collab/collab.service';
import { SAFETY_LABEL, compareFiles, describeVersion, kindOf, totals, whenLabel } from '../../../core/collab/diff';

type Filter = 'all' | 'named' | 'mine';

/** "Time Travel": every snapshot of the scroll; pick one to read it against the present, restore it, or name it. */
@Component({
  selector: 'qq-history-panel',
  imports: [FormsModule],
  template: `
    <header>
      <span class="eyebrow-ink"><span aria-hidden="true">⟲</span> Time travel</span>
      <button class="x" type="button" aria-label="Close time travel" (click)="closed.emit()">✕</button>
    </header>

    <div class="chips" role="group" aria-label="Which snapshots">
      @for (f of filters; track f.key) {
        <button type="button" class="chip-f" [class.on]="filter() === f.key" [attr.aria-pressed]="filter() === f.key" (click)="filter.set(f.key)">{{ f.label }}</button>
      }
    </div>

    @if (notice(); as n) {
      <p class="notice" [class.bad]="n.kind === 'bad'" [attr.role]="n.kind === 'bad' ? 'alert' : 'status'">
        {{ n.text }}
        @if (n.undo) { <button type="button" class="link" (click)="undo(n.undo)">Undo</button> }
      </p>
    }

    <ol class="line" aria-label="Snapshots">
      <li>
        <button type="button" class="entry" [class.on]="selectedId() === null" [attr.aria-current]="selectedId() === null ? 'true' : null" (click)="select(null)">
          <i class="dot now"></i>
          <span class="when">Today · just now</span>
          <span class="desc">Current version</span>
          <span class="nowchip">Now</span>
        </button>
      </li>
      @for (v of shown(); track v.id) {
        <li>
          <button type="button" class="entry" [class.on]="selectedId() === v.id" [attr.aria-current]="selectedId() === v.id ? 'true' : null" (click)="select(v)">
            <i class="dot" [class]="kind(v)"></i>
            <span class="when">{{ when(v) }}</span>
            <span class="desc">{{ describe(v) }}</span>
          </button>
        </li>
      }
    </ol>
    @if (loading() && !versions().length) { <p class="hint" role="status">Turning back the clock…</p> }
    @else if (!shown().length) { <p class="hint">{{ filter() === 'all' ? 'No snapshots yet. They appear as the scroll changes.' : 'Nothing matches this filter.' }}</p> }

    <span class="grow"></span>
    @if (detailBusy()) { <p class="hint" role="status">Reading that version…</p> }
    @if (selected(); as v) {
      <p class="foot"><span aria-hidden="true">⇄</span> Showing changes against the current version@if (stats(); as s) { · {{ s.files }} {{ s.files === 1 ? 'file' : 'files' }}, <b class="a">+{{ s.add }}</b> <b class="d">−{{ s.del }}</b> }</p>
      @if (canEdit()) {
        <div class="actions">
          <button class="btn go" type="button" [disabled]="busy()" (click)="askRestore()">Restore this version</button>
          <button class="btn btn--ink" type="button" [disabled]="busy()" (click)="askName(v)">Name it</button>
        </div>
      } @else {
        <p class="hint">Readers can look back through time but not change it.</p>
      }
    } @else if (canEdit()) {
      <p class="foot"><span aria-hidden="true">⇄</span> This is the live scroll. Save a named version to find your way back to it later.</p>
      <div class="actions"><button class="btn go" type="button" [disabled]="busy()" (click)="askName(null)">Save a version</button></div>
    }

    <dialog class="modal" #nameDlg aria-labelledby="nvH">
      <form class="parchment dlg" (submit)="doName($event)">
        <h2 id="nvH">{{ naming() ? 'Name this snapshot' : 'Save a version' }}</h2>
        <p class="lede">{{ naming() ? 'A named snapshot is kept for good.' : 'Names the scroll as it is right now.' }}</p>
        <label class="field">
          <span>Name</span>
          <input name="label" maxlength="80" autocomplete="off" required placeholder="Draft v1 for review" [ngModel]="nameValue()" (ngModelChange)="nameValue.set($event)" />
        </label>
        @if (nameError(); as e) { <p class="alert" role="alert">{{ e }}</p> }
        <div class="row">
          <button class="btn btn--ink" type="button" (click)="nameDlg.close()">Cancel</button>
          <button class="btn" type="submit" [disabled]="busy()">{{ naming() ? 'Name it' : 'Save version' }}</button>
        </div>
      </form>
    </dialog>

    <dialog class="modal" #restoreDlg aria-labelledby="rvH">
      <div class="parchment dlg">
        <h2 id="rvH">Restore this version?</h2>
        <p class="lede">The scroll goes back to {{ selected() ? describeTime(selected()!) : 'that moment' }}. Everyone at the table sees it change. Your current version is saved first, so you can undo this.</p>
        @if (stats(); as s) { <p class="lede">{{ s.files }} {{ s.files === 1 ? 'file' : 'files' }} will change (+{{ s.add }} −{{ s.del }} lines). Pictures are not touched.</p> }
        <div class="row">
          <button class="btn btn--ink" type="button" (click)="restoreDlg.close()">Keep the present</button>
          <button class="btn" type="button" [disabled]="busy()" (click)="doRestore()">Restore</button>
        </div>
      </div>
    </dialog>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 10px; padding: 16px 18px; min-height: 0; overflow: auto; background: var(--wood-800); color: var(--text-1); }
    header { display: flex; align-items: center; justify-content: space-between; }
    .eyebrow-ink { font: 700 13px var(--font-heading); letter-spacing: 0.16em; text-transform: uppercase; color: var(--brass-500); }
    .x { background: none; border: 0; font-size: 16px; color: var(--text-3); cursor: pointer; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip-f { font: 700 11px var(--font-heading); padding: 3px 10px; border-radius: 3px; background: transparent; color: var(--text-1); border: 1px solid var(--brass-700); cursor: pointer; &.on { background: var(--brass-500); color: var(--ink-900); border-color: var(--brass-700); } }
    .notice { margin: 0; padding: 8px 12px; border-radius: 4px; background: rgb(111 143 78 / 0.2); border: 1px solid var(--ale-500); font-weight: 600; &.bad { background: rgb(155 48 48 / 0.25); border-color: var(--wine-500); } .link { margin-left: 8px; } }
    .link { background: none; border: 0; padding: 0; font: 700 15px var(--font-body); color: var(--candle-400); text-decoration: underline; cursor: pointer; }
    .line { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; overflow: auto; min-height: 120px; }
    .entry { position: relative; width: 100%; display: grid; grid-template-columns: 18px 1fr auto; column-gap: 8px; align-items: center; text-align: left; padding: 8px 10px; background: none; border: 2px solid transparent; border-radius: 4px; color: inherit; cursor: pointer;
      &:hover { background: rgb(var(--glow-rgb) / 0.06); } &.on { border-color: var(--candle-400); background: rgb(var(--brass-rgb) / 0.16); } }
    .dot { grid-row: span 2; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--wood-900); background: var(--brass-500); &.named { background: var(--candle-400); } &.safety { background: var(--ember-500); } &.now { background: var(--ale-500); } }
    .when { font: 700 12px var(--font-heading); letter-spacing: 0.06em; text-transform: uppercase; }
    .desc { grid-column: 2; font: italic 15px var(--font-body); color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nowchip { grid-column: 3; grid-row: 1 / span 2; font: 700 12px var(--font-heading); padding: 2px 10px; border-radius: 999px; background: #1f6b3a; color: #eaf6ee; }
    .hint { margin: 4px 2px; font: italic 15px var(--font-body); color: var(--text-3); }
    .grow { flex: 1; }
    .foot { margin: 0; font: italic 14px var(--font-body); color: var(--text-3); b { font-style: normal; } }
    .a { color: var(--diff-add); } .d { color: var(--diff-del); }
    .actions { display: flex; gap: 10px; .go { flex: 1; } .btn--ink { color: var(--text-1); border-color: var(--brass-500); } }
    dialog .dlg { width: min(440px, calc(100vw - 32px)); padding: 24px 28px; display: flex; flex-direction: column; gap: 12px; h2 { font-size: 24px; } .row { display: flex; justify-content: flex-end; gap: 10px; } }
  `,
})
export class HistoryPanelComponent implements OnInit {
  readonly scrollId = input.required<string>();
  readonly canEdit = input(false);
  readonly meId = input<string | null>(null);
  readonly closed = output<void>();
  /** A version to read against the present, or null to go back to the live scroll. */
  readonly view = output<ViewedVersion | null>();

  private readonly api = inject(VersionsService);
  private readonly collab = inject(CollabService);
  private readonly nameDlg = viewChild.required<ElementRef<HTMLDialogElement>>('nameDlg');
  private readonly restoreDlg = viewChild.required<ElementRef<HTMLDialogElement>>('restoreDlg');

  protected readonly filters: Array<{ key: Filter; label: string }> = [
    { key: 'all', label: 'All snapshots' },
    { key: 'named', label: 'Named' },
    { key: 'mine', label: 'Mine' },
  ];
  protected readonly filter = signal<Filter>('all');
  protected readonly versions = signal<VersionInfo[]>([]);
  protected readonly loading = signal(true);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly detail = signal<VersionDetail | null>(null);
  protected readonly detailBusy = signal(false);
  protected readonly busy = signal(false);
  protected readonly notice = signal<{ kind: 'ok' | 'bad'; text: string; undo?: string } | null>(null);
  protected readonly naming = signal<VersionInfo | null>(null);
  protected readonly nameValue = signal('');
  protected readonly nameError = signal<string | null>(null);
  private readonly cache = new Map<string, VersionDetail>();

  protected readonly shown = computed(() => {
    const f = this.filter();
    const me = this.meId();
    return this.versions().filter((v) => (f === 'named' ? !v.auto : f === 'mine' ? !!me && v.authorId === me : true));
  });
  protected readonly selected = computed(() => this.versions().find((v) => v.id === this.selectedId()) ?? null);
  /** What restoring the picked version would do, counted against the live text. */
  protected readonly stats = computed(() => {
    const d = this.detail();
    return d && d.id === this.selectedId() ? totals(compareFiles(this.collab.sources(), new Map(Object.entries(d.files)))) : null;
  });

  ngOnInit(): void {
    void this.load(); // inputs (the scroll id) are only set once the component exists
  }

  constructor() {
    // new automatic snapshots appear while the panel is open
    const timer = setInterval(() => void this.load(true), 20_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** The editor went back to the live scroll by itself ("Back to now"): drop the highlight too. */
  reset(): void {
    this.selectedId.set(null);
    this.detail.set(null);
  }

  protected kind = kindOf;
  protected describe = describeVersion;
  protected when = (v: VersionInfo): string => whenLabel(v.createdAt);
  protected describeTime(v: VersionInfo): string {
    return (v.label && !v.auto ? `“${v.label}”, ` : '') + whenLabel(v.createdAt).toLowerCase();
  }

  private async load(quiet = false): Promise<void> {
    try {
      this.versions.set(await this.api.list(this.scrollId()));
    } catch (e) {
      if (!quiet) this.notice.set({ kind: 'bad', text: apiMessage(e) });
    } finally {
      this.loading.set(false);
    }
  }

  protected async select(v: VersionInfo | null): Promise<void> {
    this.notice.set(null);
    this.selectedId.set(v?.id ?? null);
    if (!v) {
      this.detail.set(null);
      this.view.emit(null);
      return;
    }
    this.detailBusy.set(true);
    try {
      const d = this.cache.get(v.id) ?? (await this.api.get(this.scrollId(), v.id));
      this.cache.set(v.id, d);
      if (this.selectedId() !== v.id) return; // another entry was picked meanwhile
      this.detail.set(d);
      this.view.emit({ info: v, files: new Map(Object.entries(d.files)) });
    } catch (e) {
      this.selectedId.set(null);
      this.view.emit(null);
      this.notice.set({ kind: 'bad', text: apiMessage(e) });
    } finally {
      this.detailBusy.set(false);
    }
  }

  // ---- naming
  protected askName(v: VersionInfo | null): void {
    this.naming.set(v);
    this.nameValue.set(v?.label && !v.auto ? v.label : '');
    this.nameError.set(null);
    this.nameDlg().nativeElement.showModal();
  }
  protected async doName(e: Event): Promise<void> {
    e.preventDefault();
    const label = this.nameValue().trim();
    if (!label) return void this.nameError.set('Give it a name.');
    if (label === SAFETY_LABEL) return void this.nameError.set('Pick a name of your own.');
    this.busy.set(true);
    try {
      const target = this.naming();
      const info = target ? await this.api.rename(this.scrollId(), target.id, label) : await this.api.create(this.scrollId(), label);
      this.cache.delete(info.id);
      this.nameDlg().nativeElement.close();
      await this.load(true);
      this.notice.set({ kind: 'ok', text: target ? `Named “${info.label}”. It will be kept.` : `Saved “${info.label}”.` });
    } catch (err) {
      this.nameError.set(apiMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  // ---- restoring
  protected askRestore(): void {
    if (this.selected()) this.restoreDlg().nativeElement.showModal();
  }
  protected async doRestore(): Promise<void> {
    const v = this.selected();
    if (!v) return;
    this.busy.set(true);
    try {
      await this.api.restore(this.scrollId(), v.id);
      this.restoreDlg().nativeElement.close();
      await this.leave();
      // the safety copy of the present is the newest version made just now: offer to undo
      const safety = this.versions().find((x) => kindOf(x) === 'safety');
      this.notice.set({ kind: 'ok', text: `Restored ${this.describeTime(v)}.`, undo: safety?.id });
    } catch (err) {
      this.restoreDlg().nativeElement.close();
      this.notice.set({ kind: 'bad', text: apiMessage(err) });
    } finally {
      this.busy.set(false);
    }
  }
  protected async undo(safetyId: string): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.restore(this.scrollId(), safetyId);
      await this.leave();
      this.notice.set({ kind: 'ok', text: 'Undone. The scroll is back as it was before the restore.' });
    } catch (err) {
      this.notice.set({ kind: 'bad', text: apiMessage(err) });
    } finally {
      this.busy.set(false);
    }
  }
  /** Back to the live scroll and a fresh list (restoring adds a safety version). */
  private async leave(): Promise<void> {
    this.selectedId.set(null);
    this.detail.set(null);
    this.view.emit(null);
    await this.load(true);
  }
}
