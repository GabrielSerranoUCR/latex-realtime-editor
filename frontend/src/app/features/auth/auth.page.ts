import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService, apiMessage } from '../../core/auth/auth.service';
import { safeNext } from '../../core/auth/auth.guard';

/** The tavern door: sign in or join the guild (route data `mode`). */
@Component({
  selector: 'qq-auth-page',
  imports: [FormsModule, RouterLink],
  templateUrl: './auth.page.html',
  styleUrl: './auth.page.scss',
})
export class AuthPage {
  /** Route data, bound via withComponentInputBinding. */
  readonly mode = input<'login' | 'signup'>('login');

  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly email = signal('');
  protected readonly displayName = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly isSignup = computed(() => this.mode() === 'signup');
  protected readonly queryParams = computed(() => {
    const next = this.route.snapshot.queryParamMap.get('next');
    return next ? { next } : {};
  });

  /** "Email me a magic link": no password; a one-time link goes to the address in the box. */
  protected async magic(): Promise<void> {
    if (this.busy()) return;
    const email = this.email().trim();
    if (!email) return void this.error.set('Type your email first, then ask for the link.');
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.requestMagicLink(email);
      await this.router.navigate(['/magic-sent'], { queryParams: { email, ...this.queryParams() } });
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      if (this.isSignup()) await this.auth.signup(this.email(), this.displayName(), this.password());
      else await this.auth.login(this.email(), this.password());
      await this.router.navigateByUrl(safeNext(this.route.snapshot.queryParamMap.get('next')));
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
