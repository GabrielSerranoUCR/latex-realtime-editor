import { Component, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { AssetsService } from '../../core/api/assets.service';
import { apiMessage } from '../../core/auth/auth.service';
import { CollabService } from '../../core/collab/collab.service';
import { IMPORT_LIMITS, ImportItem, Skipped, decodeText, extractZip, listZip, planImport } from '../../core/collab/zip-import';
import { tableLabel } from '../../core/collab/tavern';

type RowState = 'pending' | 'active' | 'done' | 'failed';
interface Row {
  item: ImportItem;
  state: RowState;
  note?: string;
}
type Phase = 'reading' | 'seating' | 'done' | 'cancelled' | 'error';

export interface ImportSummary {
  seated: number;
  failed: number;
  skipped: Skipped[];
  renamed: number;
  /** A path to show once it is over (the last file seated). */
  last: string | null;
}

const CONCURRENCY = 3;

/** "Importing thesis-final.zip": unpack in the browser, seat every file at its table, report what was skipped. */
@Component({
  selector: 'qq-import-dialog',
  template: `
    <dialog class="modal" #dlg aria-labelledby="impH" (cancel)="$event.preventDefault(); close()">
      <div class="parchment box">
        <header>
          <span class="seal" aria-hidden="true">▤</span>
          <div class="ttl">
            <h2 id="impH">{{ phase() === 'done' || phase() === 'cancelled' ? 'Imported' : 'Importing' }} “{{ name() }}”</h2>
            <p class="lede" role="status">{{ subtitle() }}</p>
          </div>
          <button class="x" type="button" [attr.aria-label]="finished() ? 'Close' : 'Cancel import'" (click)="close()">✕</button>
        </header>

        @if (phase() === 'error') {
          <p class="alert" role="alert">{{ error() }}</p>
        } @else {
          <div class="overall">
            <span class="cap">Overall</span>
            <span class="count">{{ percent() }}% · {{ settled() }} of {{ rows().length }} files</span>
          </div>
          <div class="bar" role="progressbar" aria-label="Import progress" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="percent()"><i [style.width.%]="percent()"></i></div>

          <ul class="rows" aria-label="Files">
            @for (r of rows(); track r.item.path) {
              <li [class]="r.state">
                <span class="st" aria-hidden="true">{{ r.state === 'done' ? '✓' : r.state === 'failed' ? '✕' : '' }}</span>
                <span class="nm">{{ r.item.path.split('/').pop() }}@if (r.note) { <em class="note"> — {{ r.note }}</em> }</span>
                <span class="tb">{{ table(r.item.table) }}</span>
              </li>
            } @empty {
              <li class="pending"><span class="st"></span><span class="nm">Looking inside the archive…</span></li>
            }
          </ul>

          @if (finished() && summary(); as s) {
            <div class="sum" role="status">
              <b>{{ s.seated }} {{ s.seated === 1 ? 'file' : 'files' }} seated</b>@if (s.renamed) { <span>, {{ s.renamed }} renamed to avoid a clash</span> }@if (s.failed) { <span>, {{ s.failed }} failed</span> }.
            </div>
            @if (s.skipped.length) {
              <details class="skipped" open>
                <summary>{{ s.skipped.length }} skipped</summary>
                <ul>@for (k of s.skipped; track k.name) { <li><code>{{ k.name }}</code><em> — {{ k.reason }}</em></li> }</ul>
              </details>
            }
          } @else {
            <p class="info"><span aria-hidden="true">ⓘ</span> Folders become tables. Unsupported files will be skipped and listed afterwards.</p>
          }
        }

        <div class="actions">
          @if (finished()) {
            <button class="btn" type="button" (click)="close()">Done</button>
          } @else {
            <button class="btn btn--cancel" type="button" (click)="cancel()">Cancel import</button>
          }
        </div>
      </div>
    </dialog>
  `,
  styles: `
    :host { display: contents; }
    .box { width: min(600px, calc(100vw - 32px)); padding: 24px 28px; display: flex; flex-direction: column; gap: 12px; }
    header { display: flex; align-items: center; gap: 14px; }
    .seal { flex: none; width: 52px; height: 52px; border-radius: 50%; display: grid; place-content: center; background: var(--wood-800); border: 3px solid var(--brass-500); color: var(--candle-400); font-size: 22px; }
    .ttl { flex: 1; min-width: 0; h2 { margin: 0; font: 700 24px var(--font-heading); overflow-wrap: anywhere; } .lede { margin: 2px 0 0; font-size: 16px; } }
    .x { background: none; border: 0; font-size: 20px; color: var(--ink-600); cursor: pointer; }
    .overall { display: flex; justify-content: space-between; align-items: baseline; .cap { font: 700 12px var(--font-heading); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-900); } .count { font: 600 14px var(--font-body); color: var(--ink-600); } }
    .bar { height: 14px; border: 2px solid var(--brass-700); border-radius: 3px; background: var(--parchment-300); overflow: hidden; i { display: block; height: 100%; background: var(--brass-700); transition: width 0.2s; } }
    .rows { list-style: none; margin: 0; padding: 8px 12px; max-height: 200px; overflow: auto; background: var(--parchment-200); border: 2px solid var(--brass-700); border-radius: 4px; display: flex; flex-direction: column; gap: 6px;
      li { display: flex; align-items: center; gap: 10px; font-size: 15px; } .st { width: 14px; height: 14px; border-radius: 50%; flex: none; display: grid; place-content: center; font-size: 11px; line-height: 1; color: var(--text-1); }
      .nm { flex: 1; min-width: 0; font: 14px var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .note { font: italic 13px var(--font-body); color: var(--wine-500); } .tb { font: italic 14px var(--font-body); color: var(--ink-600); }
      .pending .st { background: var(--ink-600); } .active .st { border: 2px dashed var(--brass-700); animation: spin 1.2s linear infinite; } .done .st { background: var(--ale-500); } .failed .st { background: var(--wine-500); } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .active .st { animation: none; } }
    .info { margin: 0; font: italic 15px var(--font-body); color: var(--ink-600); }
    .sum { font-size: 16px; }
    .skipped { border: 2px solid var(--brass-700); border-radius: 4px; padding: 6px 12px; background: var(--parchment-200); summary { cursor: pointer; font: 700 14px var(--font-heading); } ul { margin: 6px 0 0; padding: 0; list-style: none; max-height: 130px; overflow: auto; display: flex; flex-direction: column; gap: 3px; } code { font: 13px var(--font-mono); } em { color: var(--ink-600); } }
    .actions { display: flex; justify-content: flex-end; }
    .btn--cancel { background: transparent; color: var(--wine-500); border-color: var(--wine-500); }
  `,
})
export class ImportDialogComponent {
  readonly scrollId = input.required<string>();
  private readonly collab = inject(CollabService);
  private readonly assets = inject(AssetsService);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  protected readonly name = signal('');
  protected readonly phase = signal<Phase>('reading');
  protected readonly rows = signal<Row[]>([]);
  protected readonly error = signal('');
  protected readonly summary = signal<ImportSummary | null>(null);
  private cancelled = false;
  private closed: (() => void) | null = null;

  protected readonly finished = computed(() => ['done', 'cancelled', 'error'].includes(this.phase()));
  protected readonly settled = computed(() => this.rows().filter((r) => r.state === 'done' || r.state === 'failed').length);
  protected readonly percent = computed(() => (this.rows().length ? Math.round((this.settled() / this.rows().length) * 100) : this.finished() ? 100 : 0));
  protected readonly subtitle = computed(() => {
    switch (this.phase()) {
      case 'reading': return 'Unpacking the archive…';
      case 'seating': return 'Seating files at their tables…';
      case 'cancelled': return 'Stopped. Files already seated stay where they are.';
      case 'error': return 'Nothing was added.';
      default: return 'Everyone at the table can see the new members.';
    }
  });
  protected table(path: string): string {
    return tableLabel(path);
  }

  /** Runs the whole import; resolves once the scribe has read the summary and closed the dialog. */
  run(file: File, prefix = ''): Promise<ImportSummary> {
    this.name.set(file.name);
    this.phase.set('reading');
    this.rows.set([]);
    this.error.set('');
    this.summary.set(null);
    this.cancelled = false;
    const done = new Promise<void>((resolve) => (this.closed = resolve));
    this.dlg().nativeElement.showModal();
    return this.work(file, prefix).then(async (s) => {
      await done;
      return s;
    });
  }

  private fail(message: string): ImportSummary {
    this.error.set(message);
    this.phase.set('error');
    const s = { seated: 0, failed: 0, skipped: [], renamed: 0, last: null };
    this.summary.set(s);
    return s;
  }

  private async work(file: File, prefix: string): Promise<ImportSummary> {
    const room = this.collab.roomId();
    if (!room) return this.fail('You are not at a table right now.');
    if (file.size > IMPORT_LIMITS.zipBytes) return this.fail(`That archive is larger than ${IMPORT_LIMITS.zipBytes / 1024 / 1024} MB.`);
    let data: Uint8Array;
    let plan;
    try {
      data = new Uint8Array(await file.arrayBuffer());
      const taken = [...this.collab.files(), ...this.collab.assets().map((a) => a.path)];
      plan = planImport(listZip(data), taken, IMPORT_LIMITS, prefix);
    } catch {
      return this.fail('That does not look like a readable .zip archive.');
    }
    this.rows.set(plan.items.map((item) => ({ item, state: 'pending' as RowState })));
    if (!plan.items.length) {
      const s = { seated: 0, failed: 0, skipped: plan.skipped, renamed: 0, last: null };
      this.summary.set(s);
      this.phase.set('done');
      return s;
    }

    const { files, failed } = await extractZip(data, plan.items, IMPORT_LIMITS, () => this.cancelled);
    if (this.cancelled) {
      const s = { seated: 0, failed: 0, skipped: plan.skipped, renamed: 0, last: null };
      this.summary.set(s);
      this.phase.set('cancelled');
      return s;
    }
    this.phase.set('seating');
    const taken = new Set([...this.collab.files(), ...this.collab.assets().map((a) => a.path)]);
    let seated = 0;
    let failedCount = 0;
    let last: string | null = null;
    const queue = [...plan.items];
    const mark = (item: ImportItem, state: RowState, note?: string) => this.rows.update((rs) => rs.map((r) => (r.item === item ? { ...r, state, note } : r)));
    const worker = async () => {
      for (let item = queue.shift(); item && !this.cancelled; item = queue.shift()) {
        mark(item, 'active');
        const bytes = files.get(item.entry);
        const problem = failed.get(item.entry);
        if (problem || !bytes) {
          failedCount++;
          mark(item, 'failed', problem ?? 'was missing');
          continue;
        }
        try {
          if (item.kind === 'asset') {
            await this.assets.upload(room, item.path, new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]));
          } else {
            const text = decodeText(bytes);
            if (text === null) throw new Error('does not look like text');
            if (taken.has(item.path)) throw new Error('name was taken meanwhile');
            const error = this.collab.addTextFile(item.path, text);
            if (error) throw new Error(error);
          }
          taken.add(item.path);
          seated++;
          last = item.path;
          mark(item, 'done');
        } catch (e) {
          failedCount++;
          mark(item, 'failed', e instanceof Error ? e.message : apiMessage(e));
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const s: ImportSummary = { seated, failed: failedCount, skipped: plan.skipped, renamed: plan.items.filter((i) => i.renamed).length, last };
    this.summary.set(s);
    this.phase.set(this.cancelled ? 'cancelled' : 'done');
    return s;
  }

  protected cancel(): void {
    this.cancelled = true;
  }

  protected close(): void {
    if (!this.finished()) {
      this.cancelled = true;
      return; // the dialog closes itself once the running uploads have finished
    }
    this.dlg().nativeElement.close();
    this.closed?.();
    this.closed = null;
  }
}
