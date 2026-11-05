import { Component, computed, inject } from '@angular/core';
import { ToastService } from '../../../core/notify/toast.service';
import { MAX_RECORD_BYTES, MAX_RECORD_MS, clock } from '../../../core/session/session';
import { SessionRecorderService } from '../../../core/session/recorder.service';

/** While a session is being recorded: a red dot, the time used out of the hour, the size, and Stop. Always on screen. */
@Component({
  selector: 'qq-rec-pill',
  template: `
    @if (rec.recording()) {
      <div class="pill" [class.warn]="nearEnd()" role="group" aria-label="Recording a session">
        <i class="dot" aria-hidden="true"></i>
        <b>REC</b>
        <span class="time" role="timer" [attr.aria-label]="'Recording for ' + used()">{{ used() }} <small>/ {{ limit }}</small></span>
        <span class="size" [title]="'Recordings stop at 5 MB'">{{ mb() }} <small>/ 5 MB</small></span>
        <button type="button" class="stop" (click)="stop()">Stop</button>
      </div>
    }
  `,
  styles: `
    :host { display: contents; }
    .pill { position: fixed; z-index: 70; top: 71px; right: 16px; display: inline-flex; align-items: center; gap: 12px; padding: 3px 5px 3px 12px; border-radius: 999px; background: rgb(var(--panel-rgb) / 0.97); color: var(--text-1); border: 2px solid var(--wine-500); box-shadow: 0 8px 18px rgb(0 0 0 / 0.5); font: 600 15px var(--font-body);
      b { font: 700 12px var(--font-heading); letter-spacing: 0.16em; color: var(--diff-del); }
      .time { font: 700 16px var(--font-mono); small { font: 400 12px var(--font-mono); color: var(--text-3); } }
      .size { font: 400 13px var(--font-mono); color: var(--text-2); small { color: var(--text-3); } }
      .stop { padding: 4px 14px; border-radius: 999px; border: 0; cursor: pointer; background: var(--wine-500); color: var(--on-solid); font: 700 13px var(--font-heading); &:focus-visible { outline: 2px solid var(--candle-400); outline-offset: 2px; } }
      &.warn { border-color: var(--ember-500); .time { color: var(--ember-500); } } }
    .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--wine-500); animation: beat 1.4s ease-in-out infinite; }
    @keyframes beat { 50% { opacity: 0.3; } }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
  `,
})
export class RecPillComponent {
  protected readonly rec = inject(SessionRecorderService);
  private readonly toasts = inject(ToastService);

  protected async stop(): Promise<void> {
    if (await this.rec.stop()) this.toasts.show('Recording saved. It stays in this browser for 30 minutes: watch or export it from Tools.', 'ok', 9000);
  }
  protected readonly limit = clock(MAX_RECORD_MS);
  protected readonly used = computed(() => clock(this.rec.elapsedMs()));
  protected readonly mb = computed(() => (this.rec.bytes() / (1024 * 1024)).toFixed(this.rec.bytes() < 1024 * 1024 ? 2 : 1));
  /** In the last tenth of the time or the size: the pill turns amber. */
  protected readonly nearEnd = computed(() => this.rec.elapsedMs() > MAX_RECORD_MS * 0.9 || this.rec.bytes() > MAX_RECORD_BYTES * 0.9);
}
