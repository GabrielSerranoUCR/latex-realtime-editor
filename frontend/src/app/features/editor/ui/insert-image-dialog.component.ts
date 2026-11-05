import { Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AssetsService } from '../../../core/api/assets.service';
import { AssetInfo, FigureAlign, FigurePlace, WidthUnit, figureSnippet, hasGraphicx, isLatexIncludable, isPreviewableImage, labelFor } from '../../../core/latex/figure';

const TEXT_WIDTH_CM = 14;
const PRESETS: Array<{ label: string; value: number | null }> = [
  { label: '25%', value: 0.25 },
  { label: '50%', value: 0.5 },
  { label: '70%', value: 0.7 },
  { label: '100%', value: 1 },
  { label: 'Original', value: null },
];

/** "Hang a Portrait in Your Scroll": choose how an image appears, preview it, insert `\includegraphics` at the cursor. */
@Component({
  selector: 'qq-insert-image-dialog',
  imports: [FormsModule],
  templateUrl: './insert-image-dialog.component.html',
  styleUrl: './insert-image-dialog.component.scss',
})
export class InsertImageDialogComponent {
  readonly scrollId = input.required<string>();
  readonly assets = input<AssetInfo[]>([]);
  /** "main.tex line 17" — where the snippet will land. */
  readonly where = input('the cursor');
  /** Current main source, to warn when `graphicx` is missing. */
  readonly source = input('');
  readonly insert = output<string>();
  /** The dialog has closed, whether something was inserted or not (used to line up several dropped images). */
  readonly finished = output<void>();

  private readonly api = inject(AssetsService);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  protected readonly presets = PRESETS;
  protected readonly graphicxLine = '\\usepackage{graphicx}';
  protected readonly aligns: FigureAlign[] = ['left', 'centre', 'right'];
  protected readonly places: Array<{ key: FigurePlace; label: string }> = [
    { key: 'h', label: 'here' },
    { key: 't', label: 'top' },
    { key: 'b', label: 'bottom' },
    { key: 'p', label: 'page' },
  ];
  protected readonly path = signal('');
  protected readonly width = signal<number | null>(0.7);
  protected readonly unit = signal<WidthUnit>('\\textwidth');
  protected readonly align = signal<FigureAlign>('centre');
  protected readonly placement = signal<FigurePlace[]>(['h', 't']);
  protected readonly float = signal(true);
  protected readonly withCaption = signal(true);
  protected readonly caption = signal('');
  protected readonly withShort = signal(false);
  protected readonly short = signal('');
  protected readonly label = signal('');
  protected readonly labelTouched = signal(false);
  protected readonly dims = signal<string | null>(null);

  protected readonly includable = computed(() => this.assets().filter((a) => isLatexIncludable(a.path)));
  protected readonly current = computed(() => this.assets().find((a) => a.path === this.path()) ?? null);
  protected readonly previewUrl = computed(() => {
    const a = this.current();
    return a && isPreviewableImage(a.mime) ? this.api.url(this.scrollId(), a.path, a.sha256) : null;
  });
  protected readonly needsGraphicx = computed(() => !!this.source() && !hasGraphicx(this.source()));
  protected readonly previewWidth = computed(() => {
    const w = this.width();
    if (w === null) return 70;
    return Math.min(100, (this.unit() === 'cm' ? w / TEXT_WIDTH_CM : w) * 100);
  });
  protected readonly widthNote = computed(() => {
    const w = this.width();
    if (w === null) return 'Original size';
    return this.unit() === 'cm' ? `${w} cm` : `${Math.round(w * 100)}% of text width · ${+(w * TEXT_WIDTH_CM).toFixed(1)} cm`;
  });
  protected readonly refHint = computed(() => `\\ref{${this.label() || 'fig:…'}}`);
  protected readonly latex = computed(() =>
    figureSnippet({
      path: this.path() || 'figures/image.png',
      width: this.width(),
      unit: this.unit(),
      float: this.float(),
      align: this.align(),
      placement: this.placement(),
      caption: this.float() && this.withCaption() ? this.caption() : '',
      shortCaption: this.float() && this.withCaption() && this.withShort() ? this.short() : '',
      label: this.float() ? this.label() : '',
    }),
  );

  open(path?: string): void {
    const list = this.includable();
    const chosen = path && list.some((a) => a.path === path) ? path : (list[0]?.path ?? '');
    this.labelTouched.set(false);
    this.select(chosen);
    this.caption.set('');
    this.short.set('');
    this.withShort.set(false);
    this.dlg().nativeElement.showModal();
  }

  protected close(): void {
    this.dlg().nativeElement.close();
  }

  protected select(path: string): void {
    this.path.set(path);
    this.dims.set(null);
    if (!this.labelTouched()) this.label.set(path ? labelFor(path) : '');
  }

  protected loaded(img: EventTarget | null): void {
    const el = img as HTMLImageElement | null;
    if (el?.naturalWidth) this.dims.set(`${el.naturalWidth} × ${el.naturalHeight} px`);
  }

  protected preset(value: number | null): void {
    this.unit.update((u) => (u === 'cm' ? '\\textwidth' : u));
    this.width.set(value);
  }
  protected slide(v: string): void {
    this.width.set(Math.min(1, Math.max(0.1, Number(v))));
  }
  protected typed(v: unknown): void {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) this.width.set(n);
  }
  protected setUnit(u: WidthUnit): void {
    const was = this.unit();
    this.unit.set(u);
    const w = this.width();
    if (w === null) return;
    if (u === 'cm' && was !== 'cm') this.width.set(+(w * TEXT_WIDTH_CM).toFixed(1));
    else if (u !== 'cm' && was === 'cm') this.width.set(Math.min(1, +(w / TEXT_WIDTH_CM).toFixed(2)));
  }
  protected togglePlace(p: FigurePlace): void {
    this.placement.update((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  }
  protected isPreset(v: number | null): boolean {
    const w = this.width();
    if (this.unit() === 'cm') return false;
    return v === null ? w === null : w !== null && Math.abs(w - v) < 0.005;
  }
  protected setLabel(v: string): void {
    this.label.set(v);
    this.labelTouched.set(true);
  }

  protected submit(): void {
    if (!this.path()) return;
    this.insert.emit(this.latex());
    this.close();
  }
}
