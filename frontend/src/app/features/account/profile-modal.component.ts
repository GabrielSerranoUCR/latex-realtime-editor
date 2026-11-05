import { DatePipe } from '@angular/common';
import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ScrollsService } from '../../core/api/scrolls.service';
import { AccessToken, TokensService, mcpConfig } from '../../core/api/tokens.service';
import { AuthService, SessionInfo, apiMessage } from '../../core/auth/auth.service';
import { ModalsService, ProfileTab } from '../../core/notify/modals.service';
import { NotificationsService } from '../../core/notify/notifications.service';
import { ToastService } from '../../core/notify/toast.service';
import { describeAgent, passwordStrength, sessionWhen, shortName } from '../../core/account/account-utils';
import { QUIET_LABELS, QuietHours, THEMES, ThemeId } from '../../core/prefs/prefs';
import { PreferencesService } from '../../core/prefs/prefs.service';
import { ToggleComponent } from '../../shared/toggle.component';

/** The cursor colours the server accepts (it checks the same list). */
export const CURSOR_COLORS: Array<{ value: string; name: string }> = [
  { value: '#C9A04A', name: 'Brass' },
  { value: '#D9772B', name: 'Ember' },
  { value: '#6F8F4E', name: 'Ale green' },
  { value: '#F6C85F', name: 'Candle' },
  { value: '#9B3030', name: 'Wine' },
];

/** "Your Tavern Profile": who you are at the table, how to keep the account safe, and how the tavern tells you things. */
@Component({
  selector: 'qq-profile-modal',
  imports: [FormsModule, ToggleComponent, DatePipe],
  templateUrl: './profile-modal.component.html',
  styleUrl: './profile-modal.component.scss',
})
export class ProfileModalComponent {
  protected readonly auth = inject(AuthService);
  private readonly modals = inject(ModalsService);
  protected readonly prefs = inject(PreferencesService);
  private readonly scrolls = inject(ScrollsService);
  private readonly tokensApi = inject(TokensService);
  private readonly notifications = inject(NotificationsService);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);

  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  private readonly deleteDlg = viewChild.required<ElementRef<HTMLDialogElement>>('deleteDlg');

  protected readonly colors = CURSOR_COLORS;
  protected readonly themes = THEMES;
  /** Three colours that sum up each hall, for its card: wall, accent, paper. */
  protected readonly themeColors: Record<ThemeId, [string, string, string]> = {
    tavern: ['#2b1a0f', '#c9a04a', '#f3e6c8'],
    royal: ['#ffffff', '#c9a04a', '#e8e1cf'],
    caves: ['#0a0f18', '#3f84e8', '#e8eefa'],
  };
  protected readonly theme = computed(() => this.prefs.prefs().theme);
  protected readonly quietChoices = Object.entries(QUIET_LABELS) as Array<[QuietHours, string]>;
  protected readonly tab = signal<ProfileTab>('profile');
  protected readonly tabs: Array<{ id: ProfileTab; label: string }> = [
    { id: 'profile', label: 'Profile' },
    { id: 'security', label: 'Security' },
    { id: 'notifications', label: 'Notifications' },
  ];

  // identity header
  protected readonly user = this.auth.user;
  protected readonly initials = computed(() => (this.user()?.displayName ?? '').replace(/^(Sir|Dame|Lady|Brother)\s+/i, '').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase());
  protected readonly ownedScrolls = signal<number | null>(null);

  // profile tab drafts
  protected readonly name = signal('');
  protected readonly affiliation = signal('');
  protected readonly color = signal('#C9A04A');
  protected readonly showMyCursor = signal(true);
  protected readonly appearPresent = signal(true);
  protected readonly profileError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly shownAs = computed(() => shortName(this.name().trim() || this.user()?.displayName || ''));

  // security tab
  protected readonly currentPw = signal('');
  protected readonly newPw = signal('');
  protected readonly strength = computed(() => passwordStrength(this.newPw()));
  protected readonly pwError = signal<string | null>(null);
  protected readonly pwNotice = signal<string | null>(null);
  protected readonly pwBusy = signal(false);
  protected readonly sessions = signal<SessionInfo[]>([]);
  protected readonly sessionsError = signal<string | null>(null);

  // access tokens (for AI assistants)
  protected readonly tokens = signal<AccessToken[]>([]);
  protected readonly tokenName = signal('');
  protected readonly tokenWrite = signal(false);
  protected readonly tokenDays = signal<number | null>(90);
  protected readonly tokenError = signal<string | null>(null);
  protected readonly newToken = signal<{ token: string; config: string } | null>(null);
  protected readonly copied = signal<'token' | 'config' | null>(null);
  protected readonly expiryChoices: Array<{ days: number | null; label: string }> = [
    { days: 30, label: '30 days' },
    { days: 90, label: '90 days' },
    { days: 365, label: 'A year' },
    { days: null, label: 'Never' },
  ];

  // delete account
  protected readonly confirmEmail = signal('');
  protected readonly confirmPw = signal('');
  protected readonly deleteError = signal<string | null>(null);
  protected readonly deleting = signal(false);
  protected readonly emailMatches = computed(() => !!this.user() && this.confirmEmail().trim().toLowerCase() === this.user()!.email.toLowerCase());

  // notifications tab drafts
  protected readonly nMentions = signal(true);
  protected readonly nDesktop = signal(false);
  protected readonly nBell = signal(false);
  protected readonly nJoinLeave = signal(true);
  protected readonly nQuiet = signal<QuietHours>('off');
  protected readonly notifyNote = signal<string | null>(null);

  constructor() {
    effect(() => {
      const tab = this.modals.profile();
      untracked(() => (tab ? this.open(tab) : this.hide()));
    });
    // turning on desktop notifications asks the browser; a "no" turns the switch back off afterwards
    effect(() => {
      const on = this.nDesktop();
      untracked(() => {
        if (on && this.dlg().nativeElement.open) void this.askDesktop();
      });
    });
  }

  // ---- opening and closing
  private open(tab: ProfileTab): void {
    const u = this.user();
    if (!u) return void this.modals.closeProfile();
    this.tab.set(tab);
    this.name.set(u.displayName);
    this.affiliation.set(u.affiliation ?? '');
    this.color.set(u.color);
    const p = this.prefs.prefs();
    this.showMyCursor.set(p.showMyCursor);
    this.appearPresent.set(p.appearPresent);
    this.nMentions.set(p.notifyMentions);
    this.nDesktop.set(p.desktopNotifications && this.notifications.desktopPermission() === 'granted');
    this.nBell.set(p.bell);
    this.nJoinLeave.set(p.joinLeave);
    this.nQuiet.set(p.quietHours);
    this.profileError.set(null);
    this.pwError.set(null);
    this.pwNotice.set(null);
    this.notifyNote.set(null);
    this.currentPw.set('');
    this.newPw.set('');
    this.ownedScrolls.set(null);
    void this.loadOwned();
    void this.loadSessions();
    void this.loadTokens();
    this.newToken.set(null);
    const el = this.dlg().nativeElement;
    if (!el.open) el.showModal();
  }

  /** We closed the dialog ourselves, so the `close` event that follows is ours and says nothing new. */
  private closingByUs = false;

  private hide(): void {
    const el = this.dlg().nativeElement;
    if (!el.open) return;
    this.closingByUs = true;
    el.close();
  }

  /**
   * The browser reports a close a moment after it happens. If we caused it, the state is already right (and may
   * even have been set to "open again" since): leave it. Otherwise (Escape) the page must be told.
   */
  protected closed(): void {
    if (this.closingByUs) {
      this.closingByUs = false;
      return;
    }
    this.modals.closeProfile();
  }

  protected close(): void {
    this.modals.closeProfile();
  }

  /** A theme applies the moment it is picked, so you can see it; it is kept in this browser. */
  protected setTheme(id: ThemeId): void {
    this.prefs.update({ theme: id });
  }

  protected pick(t: ProfileTab): void {
    this.tab.set(t);
  }

  /** Arrow keys move between tabs, as in any tab strip. */
  protected tabKey(e: KeyboardEvent): void {
    const i = this.tabs.findIndex((t) => t.id === this.tab());
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? this.tabs.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = this.tabs[(next + this.tabs.length) % this.tabs.length];
    this.tab.set(t.id);
    queueMicrotask(() => document.getElementById('ptab-' + t.id)?.focus());
  }

  private async loadOwned(): Promise<void> {
    try {
      this.ownedScrolls.set((await this.scrolls.list()).filter((s) => s.role === 'owner').length);
    } catch {
      this.ownedScrolls.set(null);
    }
  }

  // ---- profile tab
  protected async saveProfile(e: Event): Promise<void> {
    e.preventDefault();
    const name = this.name().trim();
    if (!name) return void this.profileError.set('Your name cannot be empty.');
    this.saving.set(true);
    this.profileError.set(null);
    try {
      await this.auth.updateProfile({ displayName: name, color: this.color(), affiliation: this.affiliation().trim() });
      this.prefs.update({ showMyCursor: this.showMyCursor(), appearPresent: this.appearPresent() });
      this.toasts.show('Your profile is saved.', 'ok');
      this.close();
    } catch (err) {
      this.profileError.set(apiMessage(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected async signOut(): Promise<void> {
    this.close();
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }

  // ---- security tab
  protected async changePassword(e: Event): Promise<void> {
    e.preventDefault();
    this.pwBusy.set(true);
    this.pwError.set(null);
    this.pwNotice.set(null);
    try {
      await this.auth.changePassword(this.currentPw(), this.newPw());
      this.currentPw.set('');
      this.newPw.set('');
      this.pwNotice.set('Your password is changed. Every other device has been signed out.');
      await this.loadSessions();
    } catch (err) {
      this.pwError.set(apiMessage(err));
    } finally {
      this.pwBusy.set(false);
    }
  }

  /** Send yourself a reset link (the same one the sign-in page sends). */
  protected async emailReset(): Promise<void> {
    const email = this.user()?.email;
    if (!email) return;
    this.pwError.set(null);
    try {
      await this.auth.forgotPassword(email);
      this.pwNotice.set(`A reset link is on its way to ${email}.`);
    } catch (err) {
      this.pwError.set(apiMessage(err));
    }
  }

  private async loadSessions(): Promise<void> {
    try {
      this.sessions.set(await this.auth.sessions());
      this.sessionsError.set(null);
    } catch (err) {
      this.sessionsError.set(apiMessage(err));
    }
  }

  private async loadTokens(): Promise<void> {
    try {
      this.tokens.set(await this.tokensApi.list());
    } catch (err) {
      this.tokenError.set(apiMessage(err));
    }
  }

  protected async makeToken(e: Event): Promise<void> {
    e.preventDefault();
    this.tokenError.set(null);
    try {
      const made = await this.tokensApi.create(this.tokenName().trim(), this.tokenWrite(), this.tokenDays());
      this.newToken.set({ token: made.token, config: mcpConfig(window.location.origin, made.token) });
      this.tokenName.set('');
      this.tokenWrite.set(false);
      this.copied.set(null);
      await this.loadTokens();
    } catch (err) {
      this.tokenError.set(apiMessage(err));
    }
  }

  protected async revokeToken(t: AccessToken): Promise<void> {
    this.tokenError.set(null);
    try {
      await this.tokensApi.revoke(t.id);
      await this.loadTokens();
    } catch (err) {
      this.tokenError.set(apiMessage(err));
    }
  }

  protected async copy(what: 'token' | 'config'): Promise<void> {
    const n = this.newToken();
    if (!n) return;
    try {
      await navigator.clipboard.writeText(what === 'token' ? n.token : n.config);
      this.copied.set(what);
      setTimeout(() => this.copied() === what && this.copied.set(null), 2500);
    } catch {
      this.tokenError.set('Your browser would not let me copy. Select the text and copy it yourself.');
    }
  }

  protected tokenWhen(t: AccessToken): string {
    return t.lastUsedAt ? `last used ${sessionWhen(t.lastUsedAt, false)}` : 'never used';
  }

  protected device(s: SessionInfo) {
    return describeAgent(s.userAgent);
  }
  protected when(s: SessionInfo): string {
    return sessionWhen(s.createdAt, s.current);
  }

  protected async revoke(s: SessionInfo): Promise<void> {
    try {
      await this.auth.revokeSession(s.id);
      await this.loadSessions();
    } catch (err) {
      this.sessionsError.set(apiMessage(err));
    }
  }

  // ---- delete account
  protected askDelete(): void {
    this.confirmEmail.set('');
    this.confirmPw.set('');
    this.deleteError.set(null);
    this.deleteDlg().nativeElement.showModal();
  }

  protected async deleteAccount(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.emailMatches()) return void this.deleteError.set('The email does not match your account.');
    this.deleting.set(true);
    this.deleteError.set(null);
    try {
      await this.auth.deleteAccount(this.confirmPw());
      this.deleteDlg().nativeElement.close();
      this.close();
      await this.router.navigate(['/login']);
    } catch (err) {
      this.deleteError.set(apiMessage(err));
    } finally {
      this.deleting.set(false);
    }
  }

  // ---- notifications tab
  private async askDesktop(): Promise<void> {
    const answer = await this.notifications.requestDesktopPermission();
    if (answer === 'granted') return void this.notifyNote.set(null);
    this.nDesktop.set(false);
    this.notifyNote.set(answer === 'unsupported' ? 'This browser cannot show desktop notifications.' : 'Your browser is blocking notifications for this site. Allow them in the site settings, then try again.');
  }

  protected saveNotifications(): void {
    this.prefs.update({ notifyMentions: this.nMentions(), desktopNotifications: this.nDesktop(), bell: this.nBell(), joinLeave: this.nJoinLeave(), quietHours: this.nQuiet() });
    this.toasts.show('Your notification preferences are saved.', 'ok');
    this.close();
  }
}
