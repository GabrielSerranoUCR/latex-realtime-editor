import { Component, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { apiMessage } from '../../../core/auth/auth.service';
import { Member, PendingInvite, Role, ScrollsService, SeatRequest, ShareLink, shareUrl } from '../../../core/api/scrolls.service';

/** Invite scribes and readers, change roles, remove people. Only the owner can manage; others can look. */
@Component({
  selector: 'qq-share-dialog',
  imports: [FormsModule],
  templateUrl: './share-dialog.component.html',
  styleUrl: './share-dialog.component.scss',
})
export class ShareDialogComponent {
  readonly scrollId = input.required<string>();
  readonly title = input('');
  readonly role = input<Role | null>(null);
  readonly meId = input<string | null>(null);

  private readonly api = inject(ScrollsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  protected readonly members = signal<Member[]>([]);
  protected readonly pending = signal<PendingInvite[]>([]);
  protected readonly notice = signal<string | null>(null);
  protected readonly email = signal('');
  protected readonly inviteRole = signal<'scribe' | 'reader'>('scribe');
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly links = signal<ShareLink[]>([]);
  protected readonly requests = signal<SeatRequest[]>([]);
  protected readonly copied = signal<'scribe' | 'reader' | null>(null);
  protected readonly linkRows: Array<{ role: 'scribe' | 'reader'; title: string; blurb: string }> = [
    { role: 'scribe', title: 'Link for editing', blurb: 'Anyone who opens it and signs in becomes a scribe.' },
    { role: 'reader', title: 'Link for viewing', blurb: 'Anyone who opens it and signs in becomes a reader.' },
  ];
  protected readonly canManage = computed(() => this.role() === 'owner');

  async open(): Promise<void> {
    this.error.set(null);
    this.notice.set(null);
    this.email.set('');
    this.dialog().nativeElement.showModal();
    await this.load();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  private async load(): Promise<void> {
    try {
      this.members.set(await this.api.members(this.scrollId()));
      if (this.canManage()) {
        this.pending.set(await this.api.pendingInvites(this.scrollId()));
        this.links.set(await this.api.shareLinks(this.scrollId()));
        this.requests.set(await this.api.seatRequests(this.scrollId()));
      }
    } catch (e) {
      this.error.set(apiMessage(e));
    }
  }

  protected async invite(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || !this.email().trim()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const sent = await this.api.invite(this.scrollId(), this.email().trim(), this.inviteRole());
      this.pending.update((list) => [...list.filter((p) => p.id !== sent.id), sent]);
      this.notice.set(`Invitation sent to ${sent.email}.`);
      this.email.set('');
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Give someone who asked a seat, as a scribe or a reader. */
  protected async grant(r: SeatRequest, role: 'scribe' | 'reader'): Promise<void> {
    this.error.set(null);
    try {
      await this.api.approveRequest(this.scrollId(), r.userId, role);
      this.requests.update((l) => l.filter((x) => x.userId !== r.userId));
      this.notice.set(`${r.displayName} now has a seat as a ${role}.`);
      this.members.set(await this.api.members(this.scrollId()));
    } catch (e) {
      this.error.set(apiMessage(e));
      await this.load();
    }
  }

  protected async turnAway(r: SeatRequest): Promise<void> {
    this.error.set(null);
    try {
      await this.api.declineRequest(this.scrollId(), r.userId);
      this.requests.update((l) => l.filter((x) => x.userId !== r.userId));
    } catch (e) {
      this.error.set(apiMessage(e));
    }
  }

  protected linkFor(role: 'scribe' | 'reader'): ShareLink | undefined {
    return this.links().find((l) => l.role === role);
  }

  protected urlOf(link: ShareLink): string {
    return shareUrl(window.location.origin, link.token);
  }

  /** Switch a link on, or give it a new address (the old one stops working). */
  protected async makeLink(role: 'scribe' | 'reader'): Promise<void> {
    this.error.set(null);
    try {
      const link = await this.api.putShareLink(this.scrollId(), role);
      this.links.update((l) => [...l.filter((x) => x.role !== role), link]);
      this.copied.set(null);
    } catch (e) {
      this.error.set(apiMessage(e));
    }
  }

  protected async stopLink(role: 'scribe' | 'reader'): Promise<void> {
    this.error.set(null);
    try {
      await this.api.removeShareLink(this.scrollId(), role);
      this.links.update((l) => l.filter((x) => x.role !== role));
    } catch (e) {
      this.error.set(apiMessage(e));
    }
  }

  protected async copy(link: ShareLink, input: HTMLInputElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.urlOf(link));
    } catch {
      input.select(); // the browser would not let us: the link is selected, so Ctrl/⌘+C works
    }
    this.copied.set(link.role);
    setTimeout(() => this.copied() === link.role && this.copied.set(null), 2500);
  }

  protected async changeRole(member: Member, role: 'scribe' | 'reader'): Promise<void> {
    this.error.set(null);
    try {
      await this.api.setRole(this.scrollId(), member.userId, role);
      this.members.update((list) => list.map((m) => (m.userId === member.userId ? { ...m, role } : m)));
    } catch (e) {
      this.error.set(apiMessage(e));
      await this.load();
    }
  }

  protected async remove(member: Member): Promise<void> {
    this.error.set(null);
    try {
      await this.api.removeMember(this.scrollId(), member.userId);
      this.members.update((list) => list.filter((m) => m.userId !== member.userId));
    } catch (e) {
      this.error.set(apiMessage(e));
    }
  }

  protected async revoke(invite: PendingInvite): Promise<void> {
    this.error.set(null);
    try {
      await this.api.revokeInvite(this.scrollId(), invite.id);
      this.pending.update((list) => list.filter((p) => p.id !== invite.id));
    } catch (e) {
      this.error.set(apiMessage(e));
    }
  }

  protected initials(name: string): string {
    return name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  }
}
