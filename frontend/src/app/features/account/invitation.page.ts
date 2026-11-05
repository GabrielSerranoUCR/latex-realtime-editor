import { Component, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService, apiMessage } from '../../core/auth/auth.service';
import { MyInvite, ScrollsService } from '../../core/api/scrolls.service';

/** "Aelith invited you to Thesis": the page an invitation email links to (`/invitations/:id`). */
@Component({
  selector: 'qq-invitation-page',
  imports: [RouterLink],
  template: `
    <main class="door wood-bg">
      <section class="parchment card">
        @switch (state()) {
          @case ('loading') { <h1>Opening the letter…</h1> }
          @case ('unverified') {
            <h1>Confirm your email first</h1>
            <p class="lede">This invitation is addressed to <b>{{ auth.user()?.email }}</b>. Confirm that address (we emailed you a link), then come back to this page.</p>
            <button class="btn" type="button" (click)="resend()" [disabled]="busy()">{{ note() ?? 'Resend confirmation link' }}</button>
            <a class="foot" routerLink="/">Go to the quest board</a>
          }
          @case ('missing') {
            <h1>No letter for you here</h1>
            <p class="lede">This invitation was sent to a different address, has expired, or was withdrawn. You are signed in as <b>{{ auth.user()?.email }}</b>.</p>
            <a class="btn" routerLink="/">Back to the quest board</a>
          }
          @case ('ready') {
            @if (invite(); as i) {
              <h1>{{ i.inviterName }} invited you</h1>
              <div class="scroll"><b>{{ i.scrollTitle }}</b><span class="chip chip--idle">{{ i.role }}</span></div>
              <p class="lede">{{ i.role === 'scribe' ? 'You will be able to edit and compile this scroll with the others.' : 'You will be able to read this scroll and download the PDF.' }}</p>
              @if (error(); as e) { <p class="alert" role="alert">{{ e }}</p> }
              <button class="btn" type="button" (click)="accept()" [disabled]="busy()">Join the table</button>
              <button class="link" type="button" (click)="decline()" [disabled]="busy()">Decline invitation</button>
            }
          }
        }
      </section>
    </main>
  `,
  styleUrl: '../auth/auth.page.scss',
  styles: `.card { align-items: center; text-align: center; } .scroll { display: flex; gap: 12px; align-items: center; font: 700 22px var(--font-heading); }`,
})
export class InvitationPage {
  readonly id = input.required<string>();

  protected readonly auth = inject(AuthService);
  private readonly api = inject(ScrollsService);
  private readonly router = inject(Router);

  protected readonly state = signal<'loading' | 'unverified' | 'missing' | 'ready'>('loading');
  protected readonly invite = signal<MyInvite | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly note = signal<string | null>(null);

  constructor() {
    queueMicrotask(() => void this.load());
  }

  private async load(): Promise<void> {
    if (!this.auth.user()?.emailVerified) {
      this.state.set('unverified');
      return;
    }
    try {
      this.invite.set(await this.api.getInvite(this.id()));
      this.state.set('ready');
    } catch {
      this.state.set('missing');
    }
  }

  protected async accept(): Promise<void> {
    this.busy.set(true);
    try {
      const { scrollId } = await this.api.acceptInvite(this.id());
      await this.router.navigate(['/scroll', scrollId]);
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async decline(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.declineInvite(this.id());
      await this.router.navigateByUrl('/');
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async resend(): Promise<void> {
    this.busy.set(true);
    try {
      await this.auth.resendVerification();
      this.note.set('Link sent');
    } catch (e) {
      this.note.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
