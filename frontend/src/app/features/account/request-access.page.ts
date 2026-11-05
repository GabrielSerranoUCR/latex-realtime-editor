import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService, apiMessage } from '../../core/auth/auth.service';
import { Door, ScrollsService } from '../../core/api/scrolls.service';

/** "You need a seat": a private scroll you have no access to. Ask its owner to let you in (`/request/:id`). */
@Component({
  selector: 'qq-request-access-page',
  imports: [FormsModule, RouterLink],
  template: `
    <main class="door wood-bg">
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

      <section class="parchment card">
        @if (state() === 'loading') {
          <h1>Knocking on the door…</h1>
        } @else if (door(); as d) {
          <span class="seal" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M17 9V7a5 5 0 0 0-10 0v2H5v12h14V9h-2zM9 7a3 3 0 0 1 6 0v2H9V7zm4 9.700V19h-2v-2.300a2 2 0 1 1 2 0z"/></svg>
          </span>
          @if (state() === 'sent' || d.requested) {
            <h1>{{ state() === 'sent' ? 'Your request is sent' : 'Your request is waiting' }}</h1>
            <p class="lede">{{ d.ownerName }} has been told. When they agree, “{{ d.title }}” will appear on your quest board, and you will get an email.</p>
            <a class="btn" routerLink="/">Back to the quest board</a>
            @if (state() !== 'sent') { <p class="foot"><button type="button" class="link" (click)="again()">Send a new message</button></p> }
          } @else {
            <form class="stack" (submit)="send($event)">
              <h1>You need a seat</h1>
              <p class="lede">“{{ d.title }}” is private. Ask the owner, {{ d.ownerName }}, to let you in.</p>
              <label class="field">
                <span>Message (optional)</span>
                <input name="message" maxlength="500" autocomplete="off" [placeholder]="'Hi ' + firstName(d.ownerName) + ', I am helping with this one…'" [(ngModel)]="message" />
              </label>
              @if (error(); as e) { <p class="alert" role="alert">{{ e }}</p> }
              <button class="btn" type="submit" [disabled]="busy()">{{ busy() ? 'One moment…' : 'Request a seat' }}</button>
              <p class="foot">Signed in as {{ auth.user()?.email }} · <button type="button" class="link" (click)="switchAccount()">Switch account</button></p>
            </form>
          }
        }
      </section>
    </main>
  `,
  styleUrl: '../auth/auth.page.scss',
  styles: `.link { font-size: 16px; } h1, .lede { text-align: center; }`,
})
export class RequestAccessPage {
  readonly id = input.required<string>();

  protected readonly auth = inject(AuthService);
  private readonly api = inject(ScrollsService);
  private readonly router = inject(Router);

  protected readonly state = signal<'loading' | 'ask' | 'sent'>('loading');
  protected readonly door = signal<Door | null>(null);
  protected readonly message = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    queueMicrotask(() => void this.load());
  }

  private async load(): Promise<void> {
    try {
      const d = await this.api.door(this.id());
      // already has a seat (say, the owner just gave one): go straight in
      if (d.member) return void (await this.router.navigate(['/scroll', this.id()], { replaceUrl: true }));
      this.door.set(d);
      this.state.set('ask');
    } catch {
      await this.router.navigateByUrl('/404', { replaceUrl: true });
    }
  }

  protected firstName(full: string): string {
    return full.replace(/^(Sir|Dame|Lady|Brother)\s+/i, '').split(/\s+/)[0] || full;
  }

  protected async send(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.askForSeat(this.id(), this.message());
      this.state.set('sent');
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected again(): void {
    this.door.update((d) => (d ? { ...d, requested: false } : d));
    this.state.set('ask');
  }

  /** Sign out and come back to this page after signing in as someone else. */
  protected async switchAccount(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/login'], { queryParams: { next: this.router.url } });
  }
}
