import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScrollsService } from '../../core/api/scrolls.service';
import { AuthService, SessionInfo, User } from '../../core/auth/auth.service';
import { ModalsService } from '../../core/notify/modals.service';
import { NotificationsService } from '../../core/notify/notifications.service';
import { ToastService } from '../../core/notify/toast.service';
import { PreferencesService } from '../../core/prefs/prefs.service';
import { ProfileModalComponent } from './profile-modal.component';

const user: User = { id: 'u1', email: 'gabriel@guild.com', displayName: 'Dame Aelith', color: '#C9A04A', emailVerified: true, affiliation: 'University of Costa Rica' };
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const sessions = (): SessionInfo[] => [
  { id: 's1', createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), userAgent: SAFARI, current: true },
  { id: 's2', createdAt: new Date(Date.now() - 2 * 86400_000).toISOString(), expiresAt: new Date().toISOString(), userAgent: IPHONE, current: false },
];

function setup(over: { permission?: 'granted' | 'denied' | 'default' | 'unsupported' } = {}) {
  const auth = {
    user: signal<User | null>(user),
    updateProfile: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => undefined),
    sessions: vi.fn(async () => sessions()),
    revokeSession: vi.fn(async () => undefined),
    deleteAccount: vi.fn(async () => undefined),
    forgotPassword: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };
  const router = { navigate: vi.fn(async () => true) };
  const notifications = { desktopPermission: vi.fn(() => over.permission ?? 'granted'), requestDesktopPermission: vi.fn(async () => over.permission ?? 'granted') };
  const scrolls = { list: vi.fn(async () => [{ role: 'owner' }, { role: 'owner' }, { role: 'reader' }]) };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: AuthService, useValue: auth }, { provide: Router, useValue: router }, { provide: NotificationsService, useValue: notifications }, { provide: ScrollsService, useValue: scrolls }] });
  const fixture = TestBed.createComponent(ProfileModalComponent);
  fixture.detectChanges();
  const modals = TestBed.inject(ModalsService);
  const toasts = TestBed.inject(ToastService);
  const prefs = TestBed.inject(PreferencesService);
  const host = fixture.nativeElement as HTMLElement;
  const open = async (tab: 'profile' | 'security' | 'notifications' = 'profile') => {
    modals.openProfile(tab);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const settle = async () => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
  };
  const type = (sel: string, value: string) => {
    const el = host.querySelector(sel) as HTMLInputElement;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  };
  const click = (el: Element | null) => {
    (el as HTMLElement).click();
    fixture.detectChanges();
  };
  const byText = (sel: string, text: string) => Array.from(host.querySelectorAll(sel)).find((e) => e.textContent!.trim().startsWith(text)) ?? null;
  const submit = (sel: string) => {
    (host.querySelector(sel) as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
  };
  return { fixture, auth, router, notifications, modals, toasts, prefs, host, open, settle, type, click, byText, submit };
}

describe('ProfileModalComponent', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
    };
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens on the profile tab with who you are and how many scrolls you own', async () => {
    const t = setup();
    await t.open();
    await t.settle();
    expect(t.host.querySelector('dialog.profile')!.hasAttribute('open')).toBe(true);
    expect(t.host.querySelector('.ident b')!.textContent).toBe('Dame Aelith');
    expect(t.host.querySelector('.ident small')!.textContent).toContain('gabriel@guild.com · Owner of 2 scrolls');
    expect((t.host.querySelector('input[name=name]') as HTMLInputElement).value).toBe('Dame Aelith');
    expect((t.host.querySelector('input[name=aff]') as HTMLInputElement).value).toBe('University of Costa Rica');
    expect((t.host.querySelector('input[name=email]') as HTMLInputElement).readOnly).toBe(true);
  });

  it('shows the name others will call you, without a title, as you type', async () => {
    const t = setup();
    await t.open();
    expect(t.host.querySelector('.shown')!.textContent).toContain('“Aelith”');
    t.type('input[name=name]', 'Sir Marcus Reed');
    expect(t.host.querySelector('.shown')!.textContent).toContain('“Marcus”');
  });

  it('saves the profile (trimmed), the presence switches and closes with a toast', async () => {
    const t = setup();
    await t.open();
    t.type('input[name=name]', '  Aelith the Bold ');
    t.type('input[name=aff]', ' Guild of Quills ');
    t.click(t.host.querySelector('.swatch[aria-label="Wine"]'));
    t.click(t.host.querySelectorAll('qq-toggle input')[0]);
    t.submit('form#ppanel-profile');
    await t.settle();
    expect(t.auth.updateProfile).toHaveBeenCalledWith({ displayName: 'Aelith the Bold', color: '#9B3030', affiliation: 'Guild of Quills' });
    expect(t.prefs.prefs().showMyCursor).toBe(false);
    expect(t.prefs.prefs().appearPresent).toBe(true);
    expect(t.toasts.toasts().at(-1)?.text).toContain('profile is saved');
    expect(t.modals.profile()).toBeNull();
    expect(t.host.querySelector('dialog.profile')!.hasAttribute('open')).toBe(false);
  });

  it('keeps the dialog open and says why when saving fails or the name is empty', async () => {
    const t = setup();
    await t.open();
    t.type('input[name=name]', '   ');
    t.submit('form#ppanel-profile');
    expect(t.host.querySelector('.alert')!.textContent).toContain('cannot be empty');
    t.type('input[name=name]', 'Aelith');
    t.auth.updateProfile.mockRejectedValueOnce({ status: 400, error: { error: 'Your name must be between 1 and 60 characters.' } });
    t.submit('form#ppanel-profile');
    await t.settle();
    expect(t.host.querySelector('.alert')!.textContent).toContain('between 1 and 60');
    expect(t.modals.profile()).toBe('profile');
  });

  it('moves between tabs with the arrow keys', async () => {
    const t = setup();
    await t.open();
    const strip = t.host.querySelector('.modal-tabs') as HTMLElement;
    strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    t.fixture.detectChanges();
    expect(t.host.querySelector('[role=tab][aria-selected=true]')!.textContent).toContain('Security');
    strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    t.fixture.detectChanges();
    expect(t.host.querySelector('[role=tab][aria-selected=true]')!.textContent).toContain('Notifications');
    strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    t.fixture.detectChanges();
    expect(t.host.querySelector('[role=tab][aria-selected=true]')!.textContent).toContain('Profile');
  });

  it('signs out from the profile tab', async () => {
    const t = setup();
    await t.open();
    t.click(t.byText('.foot .btn--cancel', 'Sign out'));
    await t.settle();
    expect(t.auth.logout).toHaveBeenCalled();
    expect(t.router.navigate).toHaveBeenCalledWith(['/login']);
  });

  describe('security', () => {
    it('lists the sessions by device, marks this one and signs the others out', async () => {
      const t = setup();
      await t.open('security');
      await t.settle();
      const rows = Array.from(t.host.querySelectorAll('.sessions li')).map((r) => r.textContent!.replace(/\s+/g, ' ').trim());
      expect(rows[0]).toContain('Safari on macOS');
      expect(rows[0]).toContain('this device');
      expect(rows[0]).toContain('Current');
      expect(rows[1]).toContain('Safari on iOS');
      expect(rows[1]).toContain('signed in 2 days ago');
      t.click(t.host.querySelector('.sessions .out'));
      await t.settle();
      expect(t.auth.revokeSession).toHaveBeenCalledWith('s2');
      expect(t.auth.sessions).toHaveBeenCalledTimes(2);
    });

    it('rates the new password and only allows an update once there is a current password and 10+ characters', async () => {
      const t = setup();
      await t.open('security');
      const update = () => t.byText('form .btn', 'Update password') as HTMLButtonElement;
      expect(update().disabled).toBe(true);
      t.type('input[name=cur]', 'old password');
      t.type('input[name=new]', 'short');
      expect(t.host.querySelector('.strength')!.textContent).toContain('too short');
      expect(update().disabled).toBe(true);
      t.type('input[name=new]', 'correct horse battery staple 42!');
      expect(t.host.querySelector('.strength')!.textContent).toContain('strong');
      expect(update().disabled).toBe(false);
    });

    it('changes the password, says other devices were signed out, and clears the fields', async () => {
      const t = setup();
      await t.open('security');
      t.type('input[name=cur]', 'old password');
      t.type('input[name=new]', 'a brand new passphrase');
      t.submit('.pw');
      await t.settle();
      expect(t.auth.changePassword).toHaveBeenCalledWith('old password', 'a brand new passphrase');
      expect(t.host.querySelector('.notice')!.textContent).toContain('Every other device has been signed out');
      expect((t.host.querySelector('input[name=cur]') as HTMLInputElement).value).toBe('');
      expect(t.auth.sessions).toHaveBeenCalledTimes(2);
    });

    it('shows the server\'s reason when the password cannot be changed', async () => {
      const t = setup();
      await t.open('security');
      t.auth.changePassword.mockRejectedValueOnce({ status: 400, error: { error: 'Your current password is not right.' } });
      t.type('input[name=cur]', 'wrong');
      t.type('input[name=new]', 'a brand new passphrase');
      t.submit('.pw');
      await t.settle();
      expect(t.host.querySelector('.pw .alert')!.textContent).toContain('current password is not right');
    });

    it('emails you a reset link for a forgotten password', async () => {
      const t = setup();
      await t.open('security');
      t.click(t.byText('.pw .link', 'Forgot your password'));
      await t.settle();
      expect(t.auth.forgotPassword).toHaveBeenCalledWith('gabriel@guild.com');
      expect(t.host.querySelector('.notice')!.textContent).toContain('gabriel@guild.com');
    });

    it('only lets the account be deleted after typing your email and password', async () => {
      const t = setup();
      await t.open('security');
      t.click(t.byText('.foot .link', 'Delete my account'));
      const del = () => t.host.querySelector('dialog.danger-dlg .btn--danger') as HTMLButtonElement;
      expect(t.host.querySelector('dialog.danger-dlg')!.hasAttribute('open')).toBe(true);
      expect(del().disabled).toBe(true);
      t.type('input[name=delemail]', 'someone@else.com');
      expect(t.host.querySelector('.field small.bad')!.textContent).toContain('does not match');
      t.type('input[name=delpw]', 'my password');
      expect(del().disabled).toBe(true);
      t.type('input[name=delemail]', ' Gabriel@Guild.com ');
      expect(del().disabled).toBe(false);
      t.submit('dialog.danger-dlg form');
      await t.settle();
      expect(t.auth.deleteAccount).toHaveBeenCalledWith('my password');
      expect(t.router.navigate).toHaveBeenCalledWith(['/login']);
      expect(t.modals.profile()).toBeNull();
    });

    it('keeps the deletion dialog open with the reason when the server refuses', async () => {
      const t = setup();
      await t.open('security');
      t.click(t.byText('.foot .link', 'Delete my account'));
      t.auth.deleteAccount.mockRejectedValueOnce({ status: 400, error: { error: 'Your password is not right.' } });
      t.type('input[name=delemail]', 'gabriel@guild.com');
      t.type('input[name=delpw]', 'nope');
      t.submit('dialog.danger-dlg form');
      await t.settle();
      expect(t.host.querySelector('dialog.danger-dlg .alert')!.textContent).toContain('password is not right');
      expect(t.router.navigate).not.toHaveBeenCalled();
    });
  });

  describe('notifications', () => {
    it('saves what you choose and closes', async () => {
      const t = setup();
      await t.open('notifications');
      const toggles = () => t.host.querySelectorAll<HTMLInputElement>('qq-toggle input');
      t.click(toggles()[2]); // bell on
      t.click(toggles()[3]); // join/leave off
      const sel = t.host.querySelector('select[name=quiet]') as HTMLSelectElement;
      sel.value = 'nights';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      t.fixture.detectChanges();
      t.submit('form#ppanel-notifications');
      expect(t.prefs.prefs()).toMatchObject({ notifyMentions: true, bell: true, joinLeave: false, quietHours: 'nights' });
      expect(t.modals.profile()).toBeNull();
      expect(t.toasts.toasts().at(-1)?.text).toContain('notification preferences');
    });

    it('turns the desktop switch back off when the browser says no, and explains', async () => {
      const t = setup({ permission: 'denied' });
      await t.open('notifications');
      t.click(t.host.querySelectorAll('qq-toggle input')[1]);
      await t.settle();
      await t.settle();
      expect(t.notifications.requestDesktopPermission).toHaveBeenCalled();
      expect((t.host.querySelectorAll('qq-toggle input')[1] as HTMLInputElement).checked).toBe(false);
      expect(t.host.querySelector('.alert')!.textContent).toContain('blocking notifications');
    });

    it('keeps the desktop switch on when the browser agrees', async () => {
      const t = setup({ permission: 'default' });
      t.notifications.requestDesktopPermission.mockResolvedValue('granted' as never);
      await t.open('notifications');
      t.click(t.host.querySelectorAll('qq-toggle input')[1]);
      await t.settle();
      await t.settle();
      expect((t.host.querySelectorAll('qq-toggle input')[1] as HTMLInputElement).checked).toBe(true);
      expect(t.host.querySelector('.alert')).toBeNull();
    });
  });

  it('is not shut by the late "close" event of an earlier closing when reopened straight away', async () => {
    const t = setup();
    await t.open('profile');
    t.modals.closeProfile();
    t.fixture.detectChanges(); // we close the dialog; the browser will report it a moment later
    t.modals.openProfile('security'); // asked again before that report and before the page has acted on it
    t.host.querySelector('dialog.profile')!.dispatchEvent(new Event('close')); // the late report
    t.fixture.detectChanges();
    await t.fixture.whenStable();
    expect(t.modals.profile()).toBe('security');
    expect(t.host.querySelector('dialog.profile')!.hasAttribute('open')).toBe(true);
  });

  it('closes when the page asks it to, and does not open for nobody', async () => {
    const t = setup();
    await t.open();
    t.modals.closeProfile();
    t.fixture.detectChanges();
    expect(t.host.querySelector('dialog.profile')!.hasAttribute('open')).toBe(false);
    t.auth.user.set(null);
    t.modals.openProfile();
    t.fixture.detectChanges();
    await t.fixture.whenStable();
    expect(t.modals.profile()).toBeNull();
  });
});
