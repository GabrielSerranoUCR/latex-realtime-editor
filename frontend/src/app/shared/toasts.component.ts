import { Component, inject } from '@angular/core';
import { ToastService } from '../core/notify/toast.service';

/** The stack of short messages from `ToastService`, over whatever page is showing. */
@Component({
  selector: 'qq-toasts',
  template: `
    <div class="stack" aria-live="polite">
      @for (t of toasts.toasts(); track t.id) {
        <div class="toast" [class.ok]="t.kind === 'ok'" [class.bad]="t.kind === 'bad'" [attr.role]="t.kind === 'bad' ? 'alert' : 'status'">
          <span>{{ t.text }}</span>
          <button type="button" aria-label="Dismiss" (click)="toasts.dismiss(t.id)">✕</button>
        </div>
      }
    </div>
  `,
  styles: `
    .stack { position: fixed; z-index: 100; left: 50%; top: 80px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 8px; width: min(460px, calc(100vw - 32px)); pointer-events: none; }
    .toast { pointer-events: auto; width: 100%; box-sizing: border-box; display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; border-radius: 6px; background: var(--toast-bg); color: var(--toast-ink); border: 3px solid var(--toast-line); box-shadow: 0 10px 24px rgb(0 0 0 / 0.55); font: 600 16px var(--font-body); &.ok { border-color: var(--toast-ok); } &.bad { border-color: var(--toast-bad); color: var(--toast-bad); } span { flex: 1; overflow-wrap: anywhere; } button { background: none; border: 0; cursor: pointer; color: inherit; font-size: 13px; } }
  `,
})
export class ToastsComponent {
  protected readonly toasts = inject(ToastService);
}
