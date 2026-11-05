import { Component, inject, signal } from '@angular/core';
import { AuthService, apiMessage } from '../../core/auth/auth.service';

/** Shown to signed-in people whose email is not confirmed yet (invitations and recovery need it). */
@Component({
  selector: 'qq-verify-banner',
  template: `
    @if (auth.user(); as u) {
      @if (!u.emailVerified) {
        <div class="verify" role="status">
          <b>Confirm your email.</b>
          <span>We sent a link to {{ u.email }}. It unlocks invitations and password recovery.</span>
          <button class="btn btn--sm btn--ghost" type="button" [disabled]="busy()" (click)="resend()">{{ note() ?? 'Resend link' }}</button>
          @if (error()) { <span class="err">{{ error() }}</span> }
        </div>
      }
    }
  `,
  styles: `
    .verify { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 8px 24px; background: var(--notice-bg); color: var(--notice-ink); border-bottom: 2px solid var(--notice-line); font-size: 16px; b { font: 700 15px var(--font-heading); } }
    .verify .btn { color: var(--notice-ink); border-color: var(--notice-ink); }
    .err { font-weight: 600; }
  `,
})
export class VerifyBannerComponent {
  protected readonly auth = inject(AuthService);
  protected readonly busy = signal(false);
  protected readonly note = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  protected async resend(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.resendVerification();
      this.note.set('Link sent');
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
