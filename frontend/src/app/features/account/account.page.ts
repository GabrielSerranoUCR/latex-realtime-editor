import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService, apiMessage } from '../../core/auth/auth.service';
import { formatCountdown } from '../../core/auth/countdown';
import { safeNext } from '../../core/auth/auth.guard';

/** Seconds before a second magic link may be asked for. */
const RESEND_AFTER = 60;

/**
 * The tavern door's recovery rooms, one component per mode (route data `mode`):
 *  - forgot : ask for a reset link
 *  - reset  : choose a new password (token from the email link)
 *  - verify : confirm the email address (token from the email link, runs on load)
 *  - magic-sent : "Your magic link is cast" (after asking for a sign-in link)
 *  - magic  : the page a magic link opens (signs in on load)
 */
@Component({
  selector: 'qq-account-page',
  imports: [FormsModule, RouterLink],
  templateUrl: './account.page.html',
  styleUrl: '../auth/auth.page.scss',
})
export class AccountPage {
  readonly mode = input<'forgot' | 'reset' | 'verify' | 'magic-sent' | 'magic'>('forgot');

  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly confirm = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly done = signal(false);

  protected readonly token = computed(() => this.route.snapshot.queryParamMap.get('token') ?? '');
  protected readonly mismatch = computed(() => this.confirm().length > 0 && this.password() !== this.confirm());
  protected readonly longEnough = computed(() => this.password().length >= 10);
  protected readonly tooLong = computed(() => this.password().length > 128);

  /** "Magic link is cast": whose inbox to look in, and how long until another can be asked for. */
  protected readonly sentTo = computed(() => this.route.snapshot.queryParamMap.get('email') ?? '');
  protected readonly wait = signal(RESEND_AFTER);
  protected readonly waitText = computed(() => formatCountdown(this.wait()));
  protected readonly resent = signal(false);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    // Verification and magic links need no clicks: they run as soon as the page opens.
    queueMicrotask(() => {
      if (this.mode() === 'verify') void this.runVerify();
      else if (this.mode() === 'magic') void this.runMagic();
      else if (this.mode() === 'magic-sent') {
        if (!this.sentTo()) void this.router.navigate(['/login'], { replaceUrl: true });
        else this.startCountdown();
      }
    });
    inject(DestroyRef).onDestroy(() => clearInterval(this.timer));
  }

  private startCountdown(): void {
    clearInterval(this.timer);
    this.wait.set(RESEND_AFTER);
    this.timer = setInterval(() => {
      this.wait.update((n) => Math.max(0, n - 1));
      if (this.wait() === 0) clearInterval(this.timer);
    }, 1000);
  }

  /** "Nothing arrived? Resend": another link (the old one stops working), and the wait begins again. */
  protected async resend(): Promise<void> {
    if (this.wait() > 0 || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.requestMagicLink(this.sentTo());
      this.resent.set(true);
      this.startCountdown();
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  private async runMagic(): Promise<void> {
    this.busy.set(true);
    try {
      if (!this.token()) throw { status: 400, error: { error: 'That sign-in link is incomplete.' } };
      await this.auth.useMagicLink(this.token());
      await this.router.navigateByUrl(safeNext(this.route.snapshot.queryParamMap.get('next')), { replaceUrl: true });
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  private async runVerify(): Promise<void> {
    this.busy.set(true);
    try {
      if (!this.token()) throw { status: 400, error: { error: 'That confirmation link is incomplete.' } };
      await this.auth.verifyEmail(this.token());
      await this.auth.refresh(); // picks up emailVerified for a signed-in visitor
      this.done.set(true);
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.error.set(null);
    this.busy.set(true);
    try {
      if (this.mode() === 'forgot') {
        await this.auth.forgotPassword(this.email());
        this.done.set(true);
      } else {
        if (this.mismatch() || !this.longEnough() || this.tooLong()) return;
        await this.auth.resetPassword(this.token(), this.password());
        this.done.set(true);
      }
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected goSignIn(): void {
    void this.router.navigate(['/login']);
  }
}
