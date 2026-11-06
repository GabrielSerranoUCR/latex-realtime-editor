import { Component, ElementRef, OnDestroy, effect, input, output, signal, untracked, viewChild } from '@angular/core';
import { CompileState } from '../../../core/api/compile.service';
import { pageScale, pointOnPage, restoredScrollTop } from '../../../core/pdf/geometry';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type Task = ReturnType<PdfJs['getDocument']>;
type Page = import('pdfjs-dist/legacy/build/pdf.mjs').PDFPageProxy;

/** A place on the PDF, in points from the page's top-left corner (1-based page). */
export interface PdfPoint {
  page: number;
  x: number;
  y: number;
  /** The word under the double-click (the browser selects it), and the text just before it, to place the caret inside the line. */
  word?: string;
  before?: string;
}

let pdfjs: Promise<PdfJs> | null = null;
/** pdf.js is loaded on first use (it is large), with its worker bundled by the build. */
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerPort = new Worker(new URL('../../../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' });
    return lib;
  });
  return pdfjs;
}

interface Slot { el: HTMLElement; canvas: HTMLCanvasElement; text: HTMLElement | null; page: Page; scale: number; renderedAt: number }

/** Shows the last successful PDF; dims it and says so when the latest build failed. Double-click a spot to ask where it came from in the source. */
@Component({
  selector: 'qq-pdf-preview',
  template: `
    <div class="head">
      <span class="eyebrow">Scroll Preview</span>
      <span class="sp"></span>
      @if (pdfUrl()) {
        <button type="button" class="hbtn" title="Zoom out" aria-label="Zoom out" (click)="zoomBy(-0.15)">−</button>
        <button type="button" class="hbtn zoom" [title]="zoom() === 1 ? 'Fits the panel height' : 'Back to fit the panel height'" aria-label="Fit to height" (click)="setZoom(1)">{{ (zoom() * 100).toFixed(0) }}%</button>
        <button type="button" class="hbtn" title="Zoom in" aria-label="Zoom in" (click)="zoomBy(0.15)">+</button>
      }
      @if (controls()) {
        @if (pdfUrl()) { <a class="hbtn" [href]="pdfUrl()" download="scroll.pdf" title="Download the PDF" aria-label="Download the PDF">⤓</a> }
        <button type="button" class="hbtn" title="Pop out to a new window" aria-label="Pop Scroll Preview out to a new window" (click)="popOut.emit()">⧉</button>
        <button type="button" class="hbtn" title="Hide this panel" aria-label="Hide Scroll Preview" (click)="hide.emit()">−</button>
      }
    </div>
    <div class="stage">
      <div #scroller class="scroller" [attr.data-src]="pdfUrl()" [class.stale]="stale()" [hidden]="!pdfUrl()" role="document" aria-label="Compiled PDF preview" (dblclick)="onDouble($event)"></div>
      @if (!pdfUrl()) {
        <div class="empty">
          <p class="title">No scroll to show yet</p>
          <p>Press <kbd>Compile</kbd> (or <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd>) to ink your scroll.</p>
        </div>
      } @else if (failed()) {
        <div class="empty overlay"><p class="title">The preview could not be drawn</p><p>You can still <a [href]="pdfUrl()" download="scroll.pdf">download the PDF</a>.</p></div>
      }
      @if (stale()) { <span class="chip chip--bad badge">Last good build</span> }
      @if (state() === 'compiling') {
        <div class="busy" role="status"><span class="chip chip--idle">Inking your scroll…</span></div>
      }
    </div>
  `,
  styleUrl: './pdf-preview.component.scss',
})
export class PdfPreviewComponent implements OnDestroy {
  readonly pdfUrl = input<string | null>(null);
  readonly state = input<CompileState>('idle');
  readonly stale = input(false);
  /** Pop-out and hide buttons (off inside the popped-out window itself). */
  readonly controls = input(true);
  readonly popOut = output<void>();
  readonly hide = output<void>();
  /** The reader double-clicked this spot of the PDF. */
  readonly locate = output<PdfPoint>();

  protected readonly zoom = signal(1);
  protected readonly failed = signal(false);
  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');

  private task: Task | null = null;
  private slots: Slot[] = [];
  private pagesEl: HTMLElement | null = null;
  private observer: IntersectionObserver | null = null;
  private resizer: ResizeObserver | null = null;
  private height = 0;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    effect(() => {
      const url = this.pdfUrl();
      untracked(() => void this.open(url));
    });
    effect(() => {
      this.zoom();
      untracked(() => this.layout());
    });
  }

  ngOnDestroy(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.observer?.disconnect();
    this.resizer?.disconnect();
    void this.task?.destroy();
  }

  protected zoomBy(delta: number): void {
    this.setZoom(Math.round((this.zoom() + delta) * 100) / 100);
  }

  protected setZoom(z: number): void {
    this.zoom.set(Math.min(4, Math.max(0.25, z)));
  }

  private async open(url: string | null): Promise<void> {
    const mine = ++this.generation;
    if (!url) {
      this.clear();
      return;
    }
    try {
      const lib = await loadPdfJs();
      const task = lib.getDocument({ url, withCredentials: true });
      const doc = await task.promise;
      if (mine !== this.generation) {
        void task.destroy();
        return;
      }
      const pages: Page[] = [];
      for (let n = 1; n <= doc.numPages; n++) pages.push(await doc.getPage(n));
      if (mine !== this.generation) {
        void task.destroy();
        return;
      }
      const host = this.scroller().nativeElement;
      const oldTop = host.scrollTop;
      const oldHeight = host.scrollHeight;
      const old = this.task;
      this.task = task;
      this.build(pages);
      host.scrollTop = restoredScrollTop(oldTop, oldHeight, host.scrollHeight);
      void old?.destroy();
      this.failed.set(false);
      this.watch();
    } catch {
      if (mine === this.generation) this.failed.set(true);
    }
  }

  private clear(): void {
    this.observer?.disconnect();
    this.slots = [];
    this.pagesEl?.replaceChildren();
    void this.task?.destroy();
    this.task = null;
  }

  /** One placeholder per page, sized now; the pictures are drawn when they come near the screen. */
  private build(pages: Page[]): void {
    const host = this.scroller().nativeElement;
    if (!this.pagesEl || this.pagesEl.parentElement !== host) {
      this.pagesEl = document.createElement('div');
      this.pagesEl.className = 'pages';
      host.replaceChildren(this.pagesEl);
    }
    this.observer?.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.draw(this.slots.find((s) => s.el === e.target));
    }, { root: host, rootMargin: '800px 0px' });
    this.slots = pages.map((page, i) => {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset['page'] = String(i + 1);
      const canvas = document.createElement('canvas');
      el.appendChild(canvas);
      return { el, canvas, text: null, page, scale: 1, renderedAt: 0 };
    });
    this.pagesEl.replaceChildren(...this.slots.map((s) => s.el));
    this.layout();
    for (const s of this.slots) this.observer.observe(s.el);
  }

  private watch(): void {
    if (this.resizer) return;
    const host = this.scroller().nativeElement;
    this.resizer = new ResizeObserver(() => {
      if (Math.abs(host.offsetHeight - this.height) < 2) return;
      clearTimeout(this.timer);
      // the panel changed size: fit the page to it afresh, back at the default zoom
      this.timer = setTimeout(() => {
        this.zoom.set(1);
        this.layout();
      }, 120);
    });
    this.resizer.observe(host);
  }

  /** Size every page for the panel height and zoom; pages that are on screen are drawn again at the new size. */
  private layout(): void {
    const host = this.scroller().nativeElement;
    this.height = host.offsetHeight;
    if (!this.slots.length || this.height <= 0) return;
    const top = host.scrollTop;
    const height = host.scrollHeight;
    for (const s of this.slots) {
      const base = s.page.getViewport({ scale: 1 });
      const next = pageScale(this.height, base.height, this.zoom());
      if (next !== s.scale) {
        s.text?.remove(); // its words would no longer sit on the page
        s.text = null;
      }
      s.scale = next;
      s.el.style.width = `${base.width * s.scale}px`;
      s.el.style.height = `${base.height * s.scale}px`;
      s.renderedAt = 0;
    }
    if (height > 0) host.scrollTop = restoredScrollTop(top, height, host.scrollHeight);
    const box = host.getBoundingClientRect();
    for (const s of this.slots) {
      const r = s.el.getBoundingClientRect();
      if (r.bottom > box.top - 800 && r.top < box.bottom + 800) this.draw(s);
    }
  }

  private draw(s: Slot | undefined): void {
    if (!s || s.renderedAt === s.scale) return;
    s.renderedAt = s.scale;
    const ratio = window.devicePixelRatio || 1;
    const viewport = s.page.getViewport({ scale: s.scale * ratio });
    // draw off-screen, then swap, so a redraw never flashes blank
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    const scale = s.scale;
    s.page.render({ canvas, viewport }).promise.then(
      () => {
        if (s.renderedAt !== scale) return;
        s.canvas.replaceWith(canvas);
        s.canvas = canvas;
        void this.drawText(s, scale);
      },
      () => {
        s.renderedAt = 0;
      },
    );
  }

  /** The invisible text over the page: what makes words selectable and copyable. */
  private async drawText(s: Slot, scale: number): Promise<void> {
    try {
      const lib = await loadPdfJs();
      const layer = document.createElement('div');
      layer.className = 'textLayer';
      s.el.style.setProperty('--total-scale-factor', String(scale));
      await new lib.TextLayer({ textContentSource: s.page.streamTextContent(), container: layer, viewport: s.page.getViewport({ scale }) }).render();
      if (s.renderedAt !== scale) return; // the page was laid out again meanwhile
      s.text?.remove();
      s.el.appendChild(layer);
      s.text = layer;
    } catch {
      /* no text layer: the page is still readable, just not selectable */
    }
  }

  protected onDouble(ev: MouseEvent): void {
    const pageEl = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.page');
    const slot = this.slots.find((s) => s.el === pageEl);
    if (!pageEl || !slot) return;
    const p = pointOnPage(ev.clientX, ev.clientY, pageEl.getBoundingClientRect(), slot.scale);
    if (!p) return;
    this.ping(pageEl, ev.clientX, ev.clientY);
    this.locate.emit({ page: Number(pageEl.dataset['page']), x: p.x, y: p.y, ...this.clickedWord(pageEl, ev.clientX, ev.clientY) });
  }

  /** The word under the click (read from the click's position, not from the selection), and what precedes it in the same piece of text. */
  private clickedWord(pageEl: HTMLElement, clientX: number, clientY: number): { word?: string; before?: string } {
    const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => Range | null };
    let node: Node | null = null;
    let offset = 0;
    const pos = doc.caretPositionFromPoint?.(clientX, clientY);
    if (pos) ({ offsetNode: node, offset } = pos);
    else {
      const range = doc.caretRangeFromPoint?.(clientX, clientY);
      if (range) ({ startContainer: node, startOffset: offset } = range);
    }
    if (!node || node.nodeType !== Node.TEXT_NODE || !pageEl.contains(node)) return {};
    const text = node.textContent ?? '';
    const isWord = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}'’]/u.test(c);
    let i = Math.min(offset, text.length);
    let j = i;
    while (i > 0 && isWord(text[i - 1])) i--;
    while (j < text.length && isWord(text[j])) j++;
    if (i === j || j - i > 60) return {};
    return { word: text.slice(i, j), before: text.slice(0, i) };
  }

  /** A small ring where the reader double-clicked, so it is clear the click was heard. */
  private ping(pageEl: HTMLElement, clientX: number, clientY: number): void {
    const r = pageEl.getBoundingClientRect();
    const dot = document.createElement('span');
    dot.className = 'ping';
    dot.style.left = `${clientX - r.left}px`;
    dot.style.top = `${clientY - r.top}px`;
    pageEl.appendChild(dot);
    setTimeout(() => dot.remove(), 700);
  }
}
