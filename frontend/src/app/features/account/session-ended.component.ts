import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService, apiMessage } from '../../core/auth/auth.service';

/**
 * "Your session has ended": shown over whatever page you were on when the server stops accepting your
 * session. The page underneath is left alone, so what you had typed is still there; sign in again and carry on.
 */
@Component({
  selector: 'qq-session-ended',
  imports: [FormsModule],
  template: `
    @if (auth.endedFor(); as was) {
      <main class="door wood-bg overlay" role="alertdialog" aria-modal="true" aria-labelledby="sess-title" aria-describedby="sess-lede">
        <section class="hanging-sign">
          <div class="chains"><i></i><i></i></div>
          <div class="board">
            <div class="est">~ EST. IN THE YEAR OF THE QUILL ~</div>
            <h1>THE GILDED QUILL</h1>
            <p>A tavern for LaTeX scribes.<br />Draft together. Compile by candlelight.</p>
          </div>
          <ul class="perks">
            <li><span class="coin">✎</span> Scribe together in real time</li>
            <li><span class="coin">⚒</span> Inked by the Tectonic engine</li>
            <li><span class="coin">❦</span> Preview your finished scroll as PDF</li>
          </ul>
        </section>

        <form class="parchment card" (submit)="submit($event, was)">
          <span class="seal red" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M6 2h12v2c0 3-2 5-4 6.5 2 1.5 4 3.5 4 6.5v3H6v-3c0-3 2-5 4-6.5C8 9 6 7 6 4V2zm3 2c0 1.8 1.2 3 3 4.2C13.800 7 15 5.800 15 4H9zm3 9.800C10.200 15 9 16.200 9 18v1h6v-1c0-1.800-1.200-3-3-4.200z"/></svg>
          </span>
          <h1 id="sess-title">Your session has ended</h1>
          <p id="sess-lede" class="lede">For your safety you were signed out. Your unsaved edits were kept. Sign in again to carry on where you left off.</p>
          <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" [(ngModel)]="email" required /></label>
          <label class="field"><span>Password</span><input id="sess-password" name="password" type="password" autocomplete="current-password" placeholder="••••••••••" [(ngModel)]="password" required /></label>
          @if (error(); as e) { <p class="alert" role="alert">{{ e }}</p> }
          <button class="btn" type="submit" [disabled]="busy() || !password()">{{ busy() ? 'One moment…' : 'Sign in again' }}</button>
          @if (sent(); as note) { <p class="note" role="status">{{ note }}</p> }
          <p class="foot"><button type="button" class="link" (click)="emailLink(was)" [disabled]="busy()">Email me a sign-in link</button> · <button type="button" class="link" (click)="otherAccount()">Use a different account</button></p>
        </form>
      </main>
    }
  `,
  styleUrl: '../auth/auth.page.scss',
  styles: `
    :host { display: contents; }
    .overlay { position: fixed; inset: 0; z-index: 500; overflow: auto; }
    .link { font-size: 16px; }
    .note { margin: 0; padding: 8px 12px; border-radius: 4px; background: rgb(111 143 78 / 0.15); border: 1px solid var(--ale-500); font-weight: 600; text-align: center; }
  `,
})
export class SessionEndedComponent {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly sent = signal<string | null>(null);
  protected readonly shown = computed(() => this.auth.endedFor() !== null);

  constructor() {
    // signed in again somewhere else (another tab, a link from the email)? then there is nothing left to ask
    effect((onCleanup) => {
      if (!this.auth.endedFor()) return;
      const timer = setInterval(() => void this.auth.recoverSession(), 4000);
      onCleanup(() => clearInterval(timer));
    });
    // it just appeared: the email is filled in, so the cursor goes to the password
    effect(() => {
      const was = this.auth.endedFor();
      untracked(() => {
        if (!was) return;
        this.email.set(was);
        this.password.set('');
        this.error.set(null);
        this.sent.set(null);
        setTimeout(() => (document.getElementById('sess-password') as HTMLInputElement | null)?.focus(), 50);
      });
    });
  }

  protected async submit(event: Event, was: string): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.signInAgain(this.email().trim(), this.password());
      this.password.set('');
      // the same person on a scroll: carry straight on (the live connection finds its way back). Anyone else, or any
      // other page (a list that failed to load), starts afresh so nothing of the old session is left on screen.
      const sameScroll = /^\/scroll\//.test(this.router.url);
      if (!sameScroll || this.email().trim().toLowerCase() !== was.toLowerCase()) window.location.reload();
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** A sign-in link by email: open it in any tab and this page carries on by itself. */
  protected async emailLink(was: string): Promise<void> {
    const to = this.email().trim() || was;
    this.error.set(null);
    try {
      await this.auth.requestMagicLink(to);
      this.sent.set(`A link is on its way to ${to}. Open it in any tab and this page carries on.`);
    } catch (e) {
      this.error.set(apiMessage(e));
    }
  }

  /** Leave this account altogether and go to the sign-in page (coming back here afterwards). */
  protected async otherAccount(): Promise<void> {
    const back = this.router.url;
    await this.auth.logout();
    await this.router.navigate(['/login'], { queryParams: { next: back } });
  }
}
