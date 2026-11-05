import { Component, computed, inject, input, output } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { CompileState } from '../../../core/api/compile.service';

/** Shows the last successful PDF; dims it and says so when the latest build failed. */
@Component({
  selector: 'qq-pdf-preview',
  template: `
    <div class="head">
      <span class="eyebrow">Scroll Preview</span>
      @if (controls()) {
        <span class="sp"></span>
        @if (pdfUrl()) { <a class="hbtn" [href]="pdfUrl()" download="scroll.pdf" title="Download the PDF" aria-label="Download the PDF">⤓</a> }
        <button type="button" class="hbtn" title="Pop out to a new window" aria-label="Pop Scroll Preview out to a new window" (click)="popOut.emit()">⧉</button>
        <button type="button" class="hbtn" title="Hide this panel" aria-label="Hide Scroll Preview" (click)="hide.emit()">−</button>
      }
    </div>
    <div class="stage">
      @if (src(); as s) {
        <iframe title="Compiled PDF preview" [src]="s" [class.stale]="stale()"></iframe>
        @if (stale()) { <span class="chip chip--bad badge">Last good build</span> }
      } @else {
        <div class="empty">
          <p class="title">No scroll to show yet</p>
          <p>Press <kbd>Compile</kbd> (or <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd>) to ink your scroll.</p>
        </div>
      }
      @if (state() === 'compiling') {
        <div class="busy" role="status"><span class="chip chip--idle">Inking your scroll…</span></div>
      }
    </div>
  `,
  styleUrl: './pdf-preview.component.scss',
})
export class PdfPreviewComponent {
  readonly pdfUrl = input<string | null>(null);
  readonly state = input<CompileState>('idle');
  readonly stale = input(false);
  /** Pop-out and hide buttons (off inside the popped-out window itself). */
  readonly controls = input(true);
  readonly popOut = output<void>();
  readonly hide = output<void>();

  private readonly sanitizer = inject(DomSanitizer);
  /** Same-origin URL produced by our own backend, so bypassing the resource-URL check is safe. */
  readonly src = computed(() => {
    const url = this.pdfUrl();
    return url ? this.sanitizer.bypassSecurityTrustResourceUrl(url + '#view=FitH') : null;
  });
}
