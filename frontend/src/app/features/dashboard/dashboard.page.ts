import { Component, ElementRef, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ModalsService } from '../../core/notify/modals.service';
import { AuthService, apiMessage } from '../../core/auth/auth.service';
import { MyInvite, ScrollSummary, ScrollsService, timeAgo } from '../../core/api/scrolls.service';
import { PendingImportService, titleFromZip } from '../../core/collab/pending-import';
import { IMPORT_LIMITS } from '../../core/collab/zip-import';
import { VerifyBannerComponent } from '../account/verify-banner.component';

/** The quest board: every scroll you own or have been invited to. */
@Component({
  selector: 'qq-dashboard-page',
  imports: [FormsModule, RouterLink, VerifyBannerComponent],
  templateUrl: './dashboard.page.html',
  styleUrl: './dashboard.page.scss',
})
export class DashboardPage {
  protected readonly auth = inject(AuthService);
  protected readonly modals = inject(ModalsService);
  private readonly api = inject(ScrollsService);
  private readonly router = inject(Router);
  private readonly pending = inject(PendingImportService);

  protected readonly scrolls = signal<ScrollSummary[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly invites = signal<MyInvite[]>([]);
  protected readonly newTitle = signal('');
  protected readonly dialogError = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly toDelete = signal<ScrollSummary | null>(null);
  protected readonly filter = signal<'all' | 'mine' | 'shared'>('all');

  private readonly newDialog = viewChild.required<ElementRef<HTMLDialogElement>>('newDialog');
  private readonly deleteDialog = viewChild.required<ElementRef<HTMLDialogElement>>('deleteDialog');

  protected readonly visible = computed(() => {
    const all = this.scrolls() ?? [];
    const f = this.filter();
    return f === 'all' ? all : all.filter((s) => (f === 'mine') === (s.role === 'owner'));
  });

  constructor() {
    void this.load();
    // "File → New scroll…" in the editor arrives here with ?new=1: open the new-scroll dialog right away
    const route = inject(ActivatedRoute);
    afterNextRender(() => {
      if (route.snapshot.queryParamMap.get('new')) {
        this.openNew();
        void this.router.navigate([], { queryParams: { new: null }, queryParamsHandling: 'merge', replaceUrl: true });
      }
    });
  }

  protected ago = (iso: string) => timeAgo(iso);

  protected async load(): Promise<void> {
    this.error.set(null);
    // invitations need a verified email; failing here just means there is nothing to show
    this.api.myInvites().then((i) => this.invites.set(i)).catch(() => this.invites.set([]));
    try {
      this.scrolls.set(await this.api.list());
    } catch (e) {
      this.error.set(apiMessage(e));
      this.scrolls.set([]);
    }
  }

  protected openNew(): void {
    this.newTitle.set('');
    this.dialogError.set(null);
    this.newDialog().nativeElement.showModal();
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.busy.set(true);
    this.dialogError.set(null);
    try {
      const scroll = await this.api.create(this.newTitle());
      this.newDialog().nativeElement.close();
      await this.router.navigate(['/scroll', scroll.id]);
    } catch (e) {
      this.dialogError.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected pickZip(input: HTMLInputElement): void {
    input.value = '';
    input.click();
  }

  /** A new scroll named after the archive; the Tavern Hall unpacks the archive into it, then the scroll opens. */
  protected async importZip(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.busy()) return;
    if (!/\.zip$/i.test(file.name)) return void this.error.set('Choose a .zip archive.');
    if (file.size > IMPORT_LIMITS.zipBytes) return void this.error.set(`That archive is larger than ${IMPORT_LIMITS.zipBytes / 1024 / 1024} MB.`);
    this.busy.set(true);
    this.error.set(null);
    try {
      const scroll = await this.api.create(titleFromZip(file.name));
      this.pending.hold(scroll.id, file);
      await this.router.navigate(['/scroll', scroll.id, 'hall']);
    } catch (e) {
      this.error.set(apiMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected askDelete(scroll: ScrollSummary): void {
    this.toDelete.set(scroll);
    this.deleteDialog().nativeElement.showModal();
  }

  protected async confirmDelete(): Promise<void> {
    const scroll = this.toDelete();
    if (!scroll) return;
    try {
      await this.api.remove(scroll.id);
      this.scrolls.update((list) => (list ?? []).filter((s) => s.id !== scroll.id));
    } catch (e) {
      this.error.set(apiMessage(e));
    }
    this.deleteDialog().nativeElement.close();
  }

  protected async acceptInvite(invite: MyInvite): Promise<void> {
    try {
      const { scrollId } = await this.api.acceptInvite(invite.id);
      await this.router.navigate(['/scroll', scrollId]);
    } catch (e) {
      this.error.set(apiMessage(e));
    }
  }

  protected async declineInvite(invite: MyInvite): Promise<void> {
    try {
      await this.api.declineInvite(invite.id);
      this.invites.update((l) => l.filter((i) => i.id !== invite.id));
    } catch (e) {
      this.error.set(apiMessage(e));
    }
  }

  protected async signOut(): Promise<void> {
    await this.auth.logout();
    await this.router.navigateByUrl('/login');
  }
}
