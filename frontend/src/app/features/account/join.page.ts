import { Component, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { apiMessage } from '../../core/auth/auth.service';
import { LinkPreview, ScrollsService } from '../../core/api/scrolls.service';

/** "Join this scroll?": the page a share link opens (`/join/:token`). Signing in first is handled by the route guard. */
@Component({
  selector: 'qq-join-page',
  imports: [RouterLink],
  template: `
    <main class="door wood-bg">
      <section class="parchment card">
        @switch (state()) {
          @case ('loading') { <h1>Reading the sign…</h1> }
          @case ('missing') {
            <h1>This link no longer works</h1>
            <p class="lede">It was switched off or replaced by the owner of the scroll. Ask them for a fresh one.</p>
            <a class="btn" routerLink="/">Back to the quest board</a>
          }
          @case ('ready') {
            @if (link(); as l) {
              <h1>{{ l.ownerName }} shared a scroll</h1>
              <div class="scroll"><b>{{ l.scrollTitle }}</b><span class="chip chip--idle">{{ l.role }}</span></div>
              <p class="lede">{{ l.role === 'scribe' ? 'You will be able to edit and compile this scroll with the others.' : 'You will be able to read this scroll and download the PDF.' }}</p>
              @if (error(); as e) { <p class="alert" role="alert">{{ e }}</p> }
              <button class="btn" type="button" (click)="join()" [disabled]="busy()">{{ l.role === 'scribe' ? 'Join as a scribe' : 'Open as a reader' }}</button>
              <a class="foot" routerLink="/">Not now</a>
            }
          }
        }
      </section>
    </main>
  `,
  styleUrl: '../auth/auth.page.scss',
  styles: `.card { align-items: center; text-align: center; } .scroll { display: flex; gap: 12px; align-items: center; font: 700 22px var(--font-heading); }`,
})
export class JoinPage {
  readonly token = input.required<string>();

  private readonly api = inject(ScrollsService);
  private readonly router = inject(Router);

  protected readonly state = signal<'loading' | 'missing' | 'ready'>('loading');
  protected readonly link = signal<LinkPreview | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    queueMicrotask(() => void this.load());
  }

  private async load(): Promise<void> {
    try {
      this.link.set(await this.api.linkPreview(this.token()));
      this.state.set('ready');
    } catch {
      this.state.set('missing');
    }
  }

  protected async join(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const { scrollId } = await this.api.joinByLink(this.token());
      await this.router.navigate(['/scroll', scrollId]);
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
