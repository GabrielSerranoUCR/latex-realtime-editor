import { Component, computed, input, output } from '@angular/core';
import { CompileResponse, CompileState, Diagnostic } from '../../../core/api/compile.service';

/** Compile output: a status badge, clickable diagnostics, and the raw engine log. */
@Component({
  selector: 'qq-ink-log',
  template: `
    <div class="head">
      <span class="eyebrow">Ink Log</span>
      @switch (state()) {
        @case ('compiling') { <span class="chip chip--warn">Compiling…</span> }
        @case ('ok') { <span class="chip chip--ok">Compiled in {{ seconds() }}s</span> }
        @case ('failed') { <span class="chip chip--bad">Failed · {{ errors().length || 1 }} {{ errors().length === 1 ? 'error' : 'errors' }}</span> }
        @default { <span class="chip chip--idle">Ready</span> }
      }
      @if (showWarnings() && warnings().length) { <span class="chip chip--warn">{{ warnings().length }} warnings</span> }
      <span class="sp"></span>
      <span class="engine">Engine: Tectonic</span>
      @if (controls()) {
        <button type="button" class="hbtn" title="Pop out to a new window" aria-label="Pop Ink Log out to a new window" (click)="popOut.emit()">⧉</button>
        <button type="button" class="hbtn" title="Hide this panel" aria-label="Hide Ink Log" (click)="hide.emit()">−</button>
      }
    </div>

    <div class="body" role="log" aria-live="polite">
      @if (fatalError(); as f) {
        <p class="line bad">{{ f }}</p>
      }
      @for (d of diagnostics(); track $index) {
        <button type="button" class="line" [class.bad]="d.severity === 'error'" [class.warn]="d.severity === 'warning'" (click)="jump.emit(d)" [disabled]="!d.file">
          <b>{{ d.severity }}</b>
          @if (d.file) { <code>{{ d.file }}:{{ d.line }}</code> }
          {{ d.message }}
        </button>
      }
      @if (!fatalError() && !diagnostics().length) {
        <p class="line muted">{{ state() === 'idle' ? 'Nothing compiled yet.' : state() === 'ok' ? '✓ Output written.' : 'No diagnostics.' }}</p>
      }
      @if (result()?.log; as raw) {
        <details><summary>Full engine output</summary><pre>{{ raw }}</pre></details>
      }
    </div>
  `,
  styleUrl: './ink-log.component.scss',
})
export class InkLogComponent {
  readonly state = input<CompileState>('idle');
  readonly result = input<CompileResponse | null>(null);
  readonly fatalError = input<string | null>(null);
  readonly jump = output<Diagnostic>();
  /** Pop-out and hide buttons (off inside the popped-out window itself). */
  readonly controls = input(true);
  readonly popOut = output<void>();
  readonly hide = output<void>();

  /** Warnings can be left out of the list (a preference; errors always show). */
  readonly showWarnings = input(true);
  readonly diagnostics = computed(() => (this.result()?.diagnostics ?? []).filter((d) => this.showWarnings() || d.severity !== 'warning'));
  readonly errors = computed(() => this.diagnostics().filter((d) => d.severity === 'error'));
  readonly warnings = computed(() => (this.result()?.diagnostics ?? []).filter((d) => d.severity === 'warning'));
  readonly seconds = computed(() => ((this.result()?.durationMs ?? 0) / 1000).toFixed(1));
}
