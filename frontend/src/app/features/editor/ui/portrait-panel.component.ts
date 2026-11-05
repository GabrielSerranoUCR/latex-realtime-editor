import { Component, computed, inject, input, output, signal } from '@angular/core';
import { AssetsService } from '../../../core/api/assets.service';
import { AssetInfo, formatBytes, extOf, isLatexIncludable, isPreviewableImage } from '../../../core/latex/figure';
import type { Usage } from '../../../core/collab/tavern';

/** "Portrait Gallery": a framed look at one image or PDF, with the actions that belong to it. */
@Component({
  selector: 'qq-portrait-panel',
  template: `
    <header>
      <span class="eyebrow-ink">Portrait gallery</span>
      <button class="x" type="button" aria-label="Close portrait" (click)="closed.emit()">✕</button>
    </header>

    <div class="frame">
      <div class="shot">
        @if (url(); as u) {
          @if (previewable()) {
            <img [src]="u" [alt]="asset().path" draggable="false" (load)="onLoad($event.target)" />
          } @else {
            <span class="badge">{{ ext().toUpperCase() }}</span>
          }
        }
      </div>
    </div>

    <h3>{{ name() }}</h3>
    <p class="seat">Seated at the {{ table() }} table</p>
    @if (mates().length > 1) {
      <div class="mates" aria-label="Others at this table">
        @for (m of mates(); track m.path) {
          <button type="button" class="mate" [class.on]="m.path === asset().path" [attr.aria-label]="m.path" (click)="pick.emit(m.path)"><img [src]="mateUrl(m)" alt="" draggable="false" /></button>
        }
      </div>
    }

    <dl>
      @if (dims(); as d) { <div><dt>Dimensions</dt><dd>{{ d }}</dd></div> }
      <div><dt>Size</dt><dd>{{ size() }} · {{ ext().toUpperCase() }}</dd></div>
      @if (usage().length) {
        <div class="used"><dt>Used in</dt><dd>@for (u of usage(); track u.file + u.line) { <span class="chipk">{{ u.file }} · line {{ u.line }}</span> }</dd></div>
      }
      @if (!includable()) { <div><dt>In LaTeX</dt><dd class="warn">convert to png, jpg or pdf</dd></div> }
    </dl>

    <span class="grow"></span>
    @if (error(); as e) { <p class="alert" role="alert">{{ e }}</p> }
    @if (includable() && canEdit()) {
      <button class="btn wide" type="button" (click)="insert.emit(asset().path)">Insert \\includegraphics</button>
    }
    <div class="actions">
      <a class="btn btn--ink" [href]="url()" [attr.download]="name()">Download</a>
      @if (canEdit()) {
        <button class="btn btn--ink" type="button" (click)="picker.click()">Replace</button>
        <button class="btn btn--ink" type="button" (click)="confirming.set(true)">Remove</button>
      }
    </div>
    <input #picker type="file" hidden [accept]="'.' + ext()" (change)="replacePicked(picker)" />

    @if (confirming()) {
      <div class="confirm" role="alertdialog" aria-label="Remove file">
        <p>Remove <b>{{ asset().path }}</b> from the hall? Any <code>\\includegraphics</code> that uses it will stop compiling.</p>
        <div class="actions">
          <button class="btn btn--ink" type="button" (click)="confirming.set(false)">Keep it</button>
          <button class="btn btn--danger" type="button" (click)="confirming.set(false); remove.emit(asset().path)">Remove</button>
        </div>
      </div>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 12px; padding: 22px 24px; background: var(--parchment-100); color: var(--ink-900); border: 5px solid var(--wood-900); border-radius: 6px; box-shadow: 0 10px 18px rgb(0 0 0 / 0.55); position: relative; min-height: 0; overflow: auto; }
    header { display: flex; align-items: center; justify-content: space-between; }
    .eyebrow-ink { font: 700 13px var(--font-heading); letter-spacing: 0.16em; text-transform: uppercase; color: var(--brass-700); }
    .x { background: none; border: 0; font-size: 16px; color: var(--ink-600); cursor: pointer; }
    .frame { padding: 12px; background: linear-gradient(180deg, rgb(var(--sheen-rgb) / 0.12), rgb(0 0 0 / 0.3)), var(--wood-600); border: 4px solid var(--wood-900); border-radius: 4px; box-shadow: 0 10px 18px rgb(0 0 0 / 0.4); }
    .shot { min-height: 150px; max-height: 240px; display: grid; place-content: center; background: #fffdf6; border-radius: 2px; overflow: hidden; img { max-width: 100%; max-height: 240px; display: block; } }
    .badge { font: 700 28px var(--font-heading); color: var(--brass-700); padding: 40px; }
    h3 { margin: 0; font: 700 24px var(--font-heading); overflow-wrap: anywhere; }
    .seat { margin: 0; font: italic 17px var(--font-body); color: var(--ink-600); }
    dl { margin: 0; display: flex; flex-direction: column; gap: 8px; border-top: 2px solid rgb(var(--brass7-rgb) / 0.5); padding-top: 10px; div { display: flex; justify-content: space-between; gap: 12px; } dt { font: 700 12px var(--font-heading); letter-spacing: 0.12em; text-transform: uppercase; color: var(--brass-700); } dd { margin: 0; font: 600 17px var(--font-body); text-align: right; } .warn { color: var(--wine-500); } }
    .mates { display: flex; gap: 8px; flex-wrap: wrap; }
    .mate { width: 52px; height: 52px; padding: 0; overflow: hidden; border: 2px solid var(--wood-900); border-radius: 4px; background: #fffdf6; cursor: pointer; &.on { border: 4px solid var(--candle-400); } img { width: 100%; height: 100%; object-fit: cover; display: block; } }
    .used dd { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
    .chipk { font: 13px var(--font-mono); border: 2px solid var(--brass-700); border-radius: 4px; padding: 2px 8px; }
    .grow { flex: 1; }
    .wide { width: 100%; }
    .actions { display: flex; gap: 8px; .btn { flex: 1; min-width: 0; padding: 9px 6px; font-size: 14px; text-align: center; text-decoration: none; } }
    .confirm { position: absolute; inset: auto 12px 12px; padding: 14px; background: var(--parchment-200); border: 3px solid var(--wine-500); border-radius: 6px; box-shadow: 0 8px 20px rgb(0 0 0 / 0.5); p { margin: 0 0 10px; } }
  `,
})
export class PortraitPanelComponent {
  readonly scrollId = input.required<string>();
  readonly asset = input.required<AssetInfo>();
  readonly canEdit = input(false);
  readonly error = input<string | null>(null);
  /** Previewable images at the same table (the thumbnails strip in the design). */
  readonly mates = input<AssetInfo[]>([]);
  readonly usage = input<Usage[]>([]);
  readonly pick = output<string>();
  readonly closed = output<void>();
  readonly insert = output<string>();
  readonly remove = output<string>();
  readonly replace = output<{ path: string; file: File }>();

  private readonly api = inject(AssetsService);
  protected readonly confirming = signal(false);
  protected readonly dims = signal<string | null>(null);

  protected readonly url = computed(() => this.api.url(this.scrollId(), this.asset().path, this.asset().sha256));
  protected readonly name = computed(() => this.asset().path.split('/').pop() ?? this.asset().path);
  protected readonly table = computed(() => {
    const i = this.asset().path.lastIndexOf('/');
    return i < 0 ? 'top-level' : this.asset().path.slice(0, i) + '/';
  });
  protected readonly ext = computed(() => extOf(this.asset().path));
  protected readonly size = computed(() => formatBytes(this.asset().size));
  protected readonly previewable = computed(() => isPreviewableImage(this.asset().mime));
  protected readonly includable = computed(() => isLatexIncludable(this.asset().path));

  protected mateUrl(a: AssetInfo): string {
    return this.api.url(this.scrollId(), a.path, a.sha256);
  }

  protected onLoad(img: EventTarget | null): void {
    const el = img as HTMLImageElement | null;
    this.dims.set(el?.naturalWidth ? `${el.naturalWidth} × ${el.naturalHeight} px` : null);
  }

  protected replacePicked(input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = '';
    this.dims.set(null);
    if (file) this.replace.emit({ path: this.asset().path, file });
  }
}
