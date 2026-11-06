import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { CompileService, Diagnostic } from '../../core/api/compile.service';
import { ScrollsService } from '../../core/api/scrolls.service';
import { CollabService } from '../../core/collab/collab.service';
import { PreferencesService } from '../../core/prefs/prefs.service';
import { PopPanel, PopoutMessage, channelName, parseMessage } from '../../core/layout/popout-protocol';
import { PdfPoint } from '../editor/ui/pdf-preview.component';
import { InkLogComponent } from '../editor/ui/ink-log.component';
import { PdfPreviewComponent } from '../editor/ui/pdf-preview.component';

/**
 * A panel in a window of its own ("Scroll Preview" or "Ink Log"). It never edits anything: the PDF follows the
 * document's latest build, and the compile state is mirrored from the main window over a BroadcastChannel.
 */
@Component({
  selector: 'qq-popout-page',
  imports: [PdfPreviewComponent, InkLogComponent],
  template: `
    <div class="win">
      <header class="bar">
        <h1>The Gilded Quill — {{ title() }}@if (scrollTitle()) { · {{ scrollTitle() }} }</h1>
        @if (panel() === 'preview' && compile.pdfUrl(); as pdf) { <a class="btn btn--ghost" [href]="pdf" download="scroll.pdf">⤓ Download</a> }
        <button type="button" class="btn btn--ghost" (click)="dockBack()">Dock back</button>
      </header>
      <main class="stage">
        @if (panel() === 'preview') {
          <qq-pdf-preview [controls]="false" [pdfUrl]="compile.pdfUrl()" [state]="compile.state()" [stale]="compile.stale()" (locate)="locateInMain($event)" />
        } @else {
          <qq-ink-log [controls]="false" [showWarnings]="prefs.prefs().showWarnings" [state]="compile.state()" [result]="compile.result()" [fatalError]="compile.fatalError()" (jump)="jumpInMain($event)" />
        }
      </main>
      <footer class="foot" role="status">
        <span aria-hidden="true">⛓</span>
        @if (linked()) { Live-linked to the main window · recompiles automatically }
        @else { Waiting for the main window… open this scroll's editor to see builds here }
      </footer>
    </div>
  `,
  styles: `
    :host { display: block; height: 100vh; background: var(--wood-900); color: var(--text-1); }
    .win { height: 100%; display: flex; flex-direction: column; }
    .bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: linear-gradient(180deg, rgb(var(--sheen-rgb) / 0.08), rgb(0 0 0 / 0.3)), var(--wood-800); border-bottom: 3px solid var(--brass-700); }
    h1 { flex: 1; margin: 0; font: 700 17px var(--font-heading); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stage { flex: 1; min-height: 0; display: flex; flex-direction: column; > * { flex: 1; min-height: 0; display: flex; flex-direction: column; } }
    .foot { padding: 6px 16px; font: 12px var(--font-mono); color: var(--ale-500); background: rgb(var(--shade-rgb) / 0.8); }
  `,
})
export class PopoutPage {
  readonly id = input.required<string>();
  readonly panel = input.required<string>();

  protected readonly compile = inject(CompileService);
  protected readonly prefs = inject(PreferencesService);
  private readonly collab = inject(CollabService);
  private readonly scrolls = inject(ScrollsService);
  private readonly router = inject(Router);

  protected readonly scrollTitle = signal('');
  protected readonly linked = signal(false);
  private channel: BroadcastChannel | null = null;
  private readonly which = computed<PopPanel>(() => (this.panel() === 'log' ? 'log' : 'preview'));
  protected readonly title = computed(() => (this.which() === 'log' ? 'Ink Log' : 'Scroll Preview'));

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.start(id));
    });
    // the PDF follows whatever build the document announces, even if the main window is busy
    effect(() => {
      const room = this.collab.roomId();
      const built = this.collab.lastBuild();
      if (room && built && this.which() === 'preview') untracked(() => this.compile.adoptBuild(room, built));
    });
    effect(() => {
      document.title = `The Gilded Quill — ${this.title()}${this.scrollTitle() ? ' · ' + this.scrollTitle() : ''}`;
    });
    inject(DestroyRef).onDestroy(() => {
      this.channel?.close();
      this.collab.disconnect();
    });
  }

  private async start(id: string): Promise<void> {
    try {
      this.scrollTitle.set((await this.scrolls.get(id)).title); // also proves we may see this scroll
    } catch {
      await this.router.navigateByUrl('/404', { replaceUrl: true });
      return;
    }
    if (this.which() === 'preview') this.collab.connect(id);
    if (typeof BroadcastChannel === 'undefined') return;
    this.channel?.close();
    this.channel = new BroadcastChannel(channelName(id));
    this.channel.onmessage = (e: MessageEvent) => {
      const m = parseMessage(e.data);
      if (m?.type === 'snapshot') {
        this.compile.applyRemote(m.snapshot);
        this.linked.set(true);
      }
    };
    this.channel.postMessage({ type: 'hello', panel: this.which() } satisfies PopoutMessage);
  }

  protected dockBack(): void {
    if (this.channel) {
      this.channel.postMessage({ type: 'dock', panel: this.which() } satisfies PopoutMessage);
      // the main window closes us; if nobody answers (it is gone), open the editor here instead
      setTimeout(() => void this.router.navigate(['/scroll', this.id()]), 600);
    } else void this.router.navigate(['/scroll', this.id()]);
  }

  /** A double-click on the preview: find the source line here, and have the editor window go to it. */
  protected async locateInMain(p: PdfPoint): Promise<void> {
    const hit = await this.compile.locate(this.id(), p.page, p.x, p.y);
    if (hit) this.jumpInMain({ severity: 'info', file: hit.file, line: hit.line, message: '' });
  }

  protected jumpInMain(d: Diagnostic): void {
    this.channel?.postMessage({ type: 'jump', diagnostic: d } satisfies PopoutMessage);
  }
}
