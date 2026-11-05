import { Component, computed, input, output } from '@angular/core';
import { formatBytes } from '../../core/latex/figure';
import { Member, Usage, tableLabel } from '../../core/collab/tavern';

/** Portrait of a text member: the first lines of the file, where it is used, and what you can do with it. */
@Component({
  selector: 'qq-text-portrait',
  template: `
    <header>
      <span class="eyebrow-ink">Portrait gallery</span>
      <button class="x" type="button" aria-label="Close portrait" (click)="closed.emit()">✕</button>
    </header>
    <div class="frame"><pre class="shot" aria-label="Start of the file">{{ excerpt() }}</pre></div>
    <h3>{{ member().name }}</h3>
    <p class="seat">Seated at the {{ table() }} table@if (member().main) { · the main scroll }</p>
    <dl>
      <div><dt>Size</dt><dd>{{ size() }} · {{ member().ext.toUpperCase() }}</dd></div>
      <div><dt>Lines</dt><dd>{{ lines() }}</dd></div>
      @if (usage().length) {
        <div class="used"><dt>Used in</dt><dd>@for (u of usage(); track u.file + u.line) { <span class="chipk">{{ u.file }} · line {{ u.line }}</span> }</dd></div>
      }
    </dl>
    <span class="grow"></span>
    <button class="btn wide" type="button" (click)="open.emit()">Open in editor</button>
    <div class="actions">
      <button class="btn btn--ink" type="button" (click)="download.emit()">Download</button>
      @if (canEdit()) {
        <button class="btn btn--ink" type="button" (click)="rename.emit()">Rename</button>
        @if (!member().main) { <button class="btn btn--ink" type="button" (click)="remove.emit()">Remove</button> }
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 12px; padding: 22px 24px; background: var(--parchment-100); color: var(--ink-900); border-left: 5px solid var(--wood-900); box-shadow: 0 10px 18px rgb(0 0 0 / 0.55); min-height: 0; overflow: auto; }
    header { display: flex; align-items: center; justify-content: space-between; }
    .eyebrow-ink { font: 700 13px var(--font-heading); letter-spacing: 0.16em; text-transform: uppercase; color: var(--brass-700); }
    .x { background: none; border: 0; font-size: 16px; color: var(--ink-600); cursor: pointer; }
    .frame { padding: 12px; background: linear-gradient(180deg, rgb(var(--sheen-rgb) / 0.12), rgb(0 0 0 / 0.3)), var(--wood-600); border: 4px solid var(--wood-900); border-radius: 4px; }
    .shot { margin: 0; height: 208px; overflow: hidden; background: var(--wood-900); color: var(--candle-400); font: 12px/1.55 var(--font-mono); padding: 10px 12px; border-radius: 2px; white-space: pre; }
    h3 { margin: 0; font: 700 24px var(--font-heading); overflow-wrap: anywhere; }
    .seat { margin: 0; font: italic 17px var(--font-body); color: var(--ink-600); }
    dl { margin: 0; display: flex; flex-direction: column; gap: 8px; border-top: 2px solid rgb(var(--brass7-rgb) / 0.5); padding-top: 10px; div { display: flex; justify-content: space-between; gap: 12px; } dt { font: 700 12px var(--font-heading); letter-spacing: 0.12em; text-transform: uppercase; color: var(--brass-700); } dd { margin: 0; font: 600 17px var(--font-body); text-align: right; display: flex; flex-direction: column; gap: 4px; align-items: flex-end; } }
    .chipk { font: 13px var(--font-mono); border: 2px solid var(--brass-700); border-radius: 4px; padding: 2px 8px; }
    .grow { flex: 1; }
    .wide { width: 100%; }
    .actions { display: flex; gap: 8px; .btn { flex: 1; min-width: 0; padding: 9px 6px; font-size: 14px; text-align: center; } }
  `,
})
export class TextPortraitComponent {
  readonly member = input.required<Member>();
  readonly text = input('');
  readonly usage = input<Usage[]>([]);
  readonly canEdit = input(false);
  readonly closed = output<void>();
  readonly open = output<void>();
  readonly download = output<void>();
  readonly rename = output<void>();
  readonly remove = output<void>();

  protected readonly table = computed(() => tableLabel(this.member().table).replace(/\/$/, '') + (this.member().table ? '/' : ''));
  protected readonly size = computed(() => formatBytes(this.member().size));
  protected readonly lines = computed(() => (this.text() ? this.text().split('\n').length : 0));
  protected readonly excerpt = computed(() => this.text().split('\n').slice(0, 14).map((l) => (l.length > 44 ? l.slice(0, 43) + '…' : l)).join('\n'));
}
