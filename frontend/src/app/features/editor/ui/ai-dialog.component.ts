import { Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { AiEditMode, Role, ScrollsService } from '../../../core/api/scrolls.service';
import { apiMessage } from '../../../core/auth/auth.service';
import { CollabService } from '../../../core/collab/collab.service';

/**
 * "AI assistant edits": how edits from programs using access tokens (through MCP) reach this scroll, and the
 * ones waiting for a person. Reviewing needs a scribe or the owner; only the owner may switch to applying
 * automatically.
 */
@Component({
  selector: 'qq-ai-dialog',
  imports: [],
  template: `
    <dialog class="modal" #dlg aria-labelledby="aiH">
      <div class="parchment box">
        <header>
          <span class="seal" aria-hidden="true">✦</span>
          <div class="ttl">
            <h2 id="aiH">AI assistant edits</h2>
            <p class="lede">Edits that programs make with your access tokens (an AI assistant through MCP).</p>
          </div>
          <button class="x" type="button" aria-label="Close" (click)="close()">✕</button>
        </header>

        <div class="modes" role="radiogroup" aria-label="How edits from an assistant arrive">
          <button type="button" role="radio" class="mode" [class.on]="mode() === 'review'" [attr.aria-checked]="mode() === 'review'" [disabled]="busy() || !isOwner()" (click)="choose('review')">
            <b>Review each edit</b>
            <small>A person accepts or rejects every change an assistant proposes. Nothing reaches the scroll until then.</small>
          </button>
          <button type="button" role="radio" class="mode" [class.on]="mode() === 'auto'" [attr.aria-checked]="mode() === 'auto'" [disabled]="busy() || !isOwner()" (click)="choose('auto')">
            <b>Apply automatically</b>
            <small>Changes land in the scroll at once, like another scribe typing. You can still go back through History.</small>
          </button>
        </div>
        @if (!isOwner()) { <p class="hint">Only the owner of this scroll can change this. Right now: {{ mode() === 'auto' ? 'edits apply automatically' : 'each edit is reviewed' }}.</p> }
        @if (error(); as e) { <p class="alert" role="alert">{{ e }}</p> }

        @if (waiting() > 0) {
          <p class="hint">{{ waiting() }} change{{ waiting() === 1 ? '' : 's' }} waiting for a decision. <button type="button" class="link" (click)="viewChanges()">View changes</button></p>
        }
        <div class="foot"><span class="sp"></span><button class="btn" type="button" (click)="close()">Done</button></div>
      </div>
    </dialog>
  `,
  styleUrl: './ai-dialog.component.scss',
})
export class AiDialogComponent {
  readonly scrollId = input.required<string>();
  readonly role = input<Role | null>(null);
  readonly mode = input<AiEditMode>('review');
  /** The mode was changed here: the page reloads the scroll. */
  readonly modeChange = output<AiEditMode>();
  /** "View changes" was pressed: the page opens the review. */
  readonly reviewChanges = output<void>();

  private readonly api = inject(ScrollsService);
  private readonly collab = inject(CollabService);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly isOwner = computed(() => this.role() === 'owner');
  protected readonly waiting = computed(() => this.collab.pendingEdits());

  async open(): Promise<void> {
    this.error.set(null);
    if (!this.dlg().nativeElement.open) this.dlg().nativeElement.showModal();
  }

  protected close(): void {
    this.dlg().nativeElement.close();
  }

  /** The edits are reviewed in their own dialog, not here. */
  protected viewChanges(): void {
    this.close();
    this.reviewChanges.emit();
  }

  protected async choose(mode: AiEditMode): Promise<void> {
    if (mode === this.mode() || !this.isOwner()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.setAiMode(this.scrollId(), mode);
      this.modeChange.emit(mode);
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
