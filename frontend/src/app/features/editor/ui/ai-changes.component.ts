import { Component, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { EditProposal, Role, ScrollsService, canWrite } from '../../../core/api/scrolls.service';
import { apiMessage } from '../../../core/auth/auth.service';
import { CollabService } from '../../../core/collab/collab.service';
import { Review, reviewProposal } from '../../../core/collab/proposal-view';
import { ProposalDiffComponent } from './proposal-diff.component';

interface Card {
  p: EditProposal;
  review: Review;
}

/**
 * "AI changes pending": how edits from programs using access tokens (through MCP) reach this scroll, and the
 * ones waiting for a person. Reviewing needs a scribe or the owner; only the owner may switch to applying
 * automatically.
 */
@Component({
  selector: 'qq-ai-changes',
  imports: [ProposalDiffComponent],
  template: `
    <dialog class="modal" #dlg aria-labelledby="chH">
      <div class="parchment box">
        <header>
          <span class="seal" aria-hidden="true">✦</span>
          <div class="ttl">
            <h2 id="chH">AI changes pending</h2>
            <p class="lede">What an AI assistant wants to change: the scroll as it is now on the left, with the changes on the right.</p>
          </div>
          <button class="x" type="button" aria-label="Close" (click)="close()">✕</button>
        </header>

        @if (error(); as e) { <p class="alert" role="alert">{{ e }}</p> }

        <div class="waitHead">
          <h3>Waiting for a decision ({{ cards().length }})</h3>
          @if (cards().length && canReview()) {
            <span class="bulk">
              <label class="pickAll"><input type="checkbox" [checked]="allPicked()" [indeterminate]="picked().size > 0 && !allPicked()" (change)="pickAll($any($event.target).checked)" [disabled]="busy()" /> Select all</label>
              <button type="button" class="link" (click)="some(true)" [disabled]="busy() || !picked().size">Accept selected ({{ picked().size }})</button>
              <button type="button" class="link danger" (click)="some(false)" [disabled]="busy() || !picked().size">Reject selected</button>
              <span class="sep" aria-hidden="true">|</span>
              <button type="button" class="link" (click)="all(true)" [disabled]="busy()">Accept all</button>
              <button type="button" class="link danger" (click)="all(false)" [disabled]="busy()">Reject all</button>
            </span>
          }
        </div>
        <ul class="props" aria-label="Edits waiting for a decision">
          @for (c of cards(); track c.p.id) {
            <li>
              <div class="top">
                @if (canReview()) { <input type="checkbox" class="pick" [checked]="picked().has(c.p.id)" (change)="pick(c.p.id, $any($event.target).checked)" [disabled]="busy()" [attr.aria-label]="'Select: ' + c.review.title" /> }
                <div class="who">
                  <b>{{ c.review.title }}
                    <span class="tag" [class.t-del]="c.review.action === 'delete'" [class.t-new]="c.review.action === 'create'">{{ label(c.review.action) }}</span>
                    @if (!c.review.stale) { <span class="cnt"><i class="a">+{{ c.review.add }}</i> <i class="d">−{{ c.review.del }}</i></span> }
                  </b>
                  <small>from {{ c.p.by }}{{ c.p.tokenName ? ' · ' + c.p.tokenName : '' }}</small>
                </div>
              </div>
              @if (c.p.note) { <q class="note">{{ c.p.note }}</q> }
              <qq-proposal-diff [review]="c.review" />
              @if (problems()[c.p.id]; as why) { <p class="alert" role="alert">{{ why }}</p> }
              @if (canReview()) {
                <div class="acts">
                  <button type="button" class="btn btn--sm" (click)="decide(c.p, true)" [disabled]="busy()" [attr.aria-label]="'Accept: ' + c.review.title">Accept</button>
                  <button type="button" class="btn btn--sm btn--ink" (click)="decide(c.p, false)" [disabled]="busy()" [attr.aria-label]="'Reject: ' + c.review.title">Reject</button>
                </div>
              }
            </li>
          } @empty {
            <li class="none">Nothing is waiting.</li>
          }
        </ul>
        <div class="foot"><span class="sp"></span><button class="btn" type="button" (click)="close()">Close</button></div>
      </div>
    </dialog>
  `,
  styleUrl: './ai-changes.component.scss',
})
export class AiChangesComponent {
  readonly scrollId = input.required<string>();
  readonly role = input<Role | null>(null);

  private readonly api = inject(ScrollsService);
  private readonly collab = inject(CollabService);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  protected readonly proposals = signal<EditProposal[]>([]);
  protected readonly problems = signal<Record<string, string>>({});
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly canReview = computed(() => canWrite(this.role()));
  /** Ticked for a bulk decision. */
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  /** Every waiting change drawn against the file as it is right now; rebuilt after each decision (accepting moves the text). */
  protected readonly cards = signal<Card[]>([]);
  protected readonly allPicked = computed(() => this.cards().length > 0 && this.picked().size === this.cards().length);

  constructor() {
    // while it is open, follow the server's count: new proposals appear, decided ones go
    effect(() => {
      this.collab.pendingEdits();
      untracked(() => {
        if (this.dlg().nativeElement.open) void this.load();
      });
    });
  }

  async open(): Promise<void> {
    this.error.set(null);
    this.problems.set({});
    if (!this.dlg().nativeElement.open) this.dlg().nativeElement.showModal();
    await this.load();
  }

  protected close(): void {
    this.dlg().nativeElement.close();
  }

  private async load(): Promise<void> {
    try {
      this.proposals.set(await this.api.proposals(this.scrollId()));
      this.rebuild();
    } catch (e) {
      this.error.set(apiMessage(e));
    }
  }

  private rebuild(): void {
    this.cards.set(this.proposals().map((p) => ({ p, review: reviewProposal(p, this.collab.fileText(p.path)) })));
    this.picked.update((s) => new Set([...s].filter((id) => this.proposals().some((p) => p.id === id))));
  }

  protected label(action: Review['action']): string {
    return { edit: 'edit', create: 'new file', rewrite: 'whole file', delete: 'delete' }[action];
  }

  protected pick(id: string, on: boolean): void {
    this.picked.update((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  protected pickAll(on: boolean): void {
    this.picked.set(on ? new Set(this.proposals().map((p) => p.id)) : new Set());
  }

  /** Accept or reject one. A refusal (the text moved on) is shown on that proposal, which stays so it can be rejected. */
  protected async decide(p: EditProposal, accept: boolean): Promise<boolean> {
    this.busy.set(true);
    this.problems.update((m) => {
      const { [p.id]: _gone, ...rest } = m;
      return rest;
    });
    try {
      if (accept) await this.api.acceptProposal(this.scrollId(), p.id);
      else await this.api.rejectProposal(this.scrollId(), p.id);
      this.proposals.update((l) => l.filter((x) => x.id !== p.id));
      this.rebuild();
      return true;
    } catch (e) {
      this.problems.update((m) => ({ ...m, [p.id]: apiMessage(e) }));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** Accept (or reject) the ticked ones, oldest first, stopping at the first that cannot be done. */
  protected async some(accept: boolean): Promise<void> {
    for (const p of this.proposals().filter((x) => this.picked().has(x.id))) {
      if (!(await this.decide(p, accept))) return;
    }
  }

  /** Accept (or reject) everything waiting, one by one, stopping at the first that cannot be done. */
  protected async all(accept: boolean): Promise<void> {
    for (const p of [...this.proposals()]) {
      if (!(await this.decide(p, accept))) return;
    }
  }
}
