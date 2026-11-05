import { Injectable, effect, inject, untracked } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { CollabService } from '../collab/collab.service';
import { CommentsService } from '../collab/comments.service';
import { PreferencesService } from '../prefs/prefs.service';
import { isQuiet } from '../prefs/prefs';
import { ToastService } from './toast.service';
import { describeNote, deliveryFor, joinedAndLeft, newNotes } from './notifications';

/**
 * Tells you what happens at the table while you work: new margin notes (and mentions of you) and scribes
 * coming and going. What it says, and how loudly, is up to the Notifications tab of your profile.
 */
@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly auth = inject(AuthService);
  private readonly collab = inject(CollabService);
  private readonly comments = inject(CommentsService);
  private readonly prefs = inject(PreferencesService);
  private readonly toasts = inject(ToastService);

  /** Notes already seen. Null until the table has synced, so what was there before you came is not "news". */
  private known: Set<string> | null = null;
  private peers: Map<number, string> | null = null;
  private audio: AudioContext | null = null;

  constructor() {
    effect(() => {
      const synced = this.collab.synced();
      const threads = this.comments.threads();
      const me = this.auth.user();
      untracked(() => {
        if (!synced) return void (this.known = null);
        const { events, ids } = newNotes(this.known ?? new Set(), threads, me?.id ?? null, this.collab.me().name);
        const seeding = this.known === null;
        this.known = ids;
        if (!seeding) for (const e of events) this.tell(e);
      });
    });
    effect(() => {
      const synced = this.collab.synced();
      const meId = this.auth.user()?.id;
      // your own other tabs (or the one you just reloaded) are not "someone else" joining
      const now = new Map(this.collab.peers().filter((p) => !meId || p.user.id !== meId).map((p) => [p.clientId, p.user.name] as const));
      untracked(() => {
        if (!synced) return void (this.peers = null);
        const before = this.peers;
        this.peers = now;
        if (!before) return;
        const p = this.prefs.prefs();
        if (!p.joinLeave || isQuiet(p.quietHours)) return;
        const { joined, left } = joinedAndLeft(before, now);
        joined.forEach((n) => this.toasts.show(`${n} joined the table.`));
        left.forEach((n) => this.toasts.show(`${n} left the table.`));
      });
    });
  }

  private tell(e: Parameters<typeof describeNote>[0]): void {
    const how = deliveryFor(e, this.prefs.prefs(), new Date(), typeof document !== 'undefined' && document.hidden);
    const { title, body } = describeNote(e);
    if (how.toast) this.toasts.show(`${title}: ${body}`, 'info');
    if (how.desktop) this.desktop(title, body, e.threadId);
    if (how.bell) this.ring();
  }

  private desktop(title: string, body: string, tag: string): void {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body, tag, icon: '/favicon.ico' });
    } catch {
      /* some browsers only allow it from a service worker */
    }
  }

  /** A short bell. Browsers need a click first before they allow sound, so this stays silent until then. */
  private ring(): void {
    try {
      this.audio ??= new AudioContext();
      const ctx = this.audio;
      if (ctx.state === 'suspended') void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.7);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.75);
    } catch {
      /* no audio available */
    }
  }

  /** Ask the browser for permission to show desktop notifications. */
  async requestDesktopPermission(): Promise<NotificationPermission | 'unsupported'> {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission !== 'default') return Notification.permission;
    try {
      return await Notification.requestPermission();
    } catch {
      return 'denied';
    }
  }

  /** What the browser currently allows. */
  desktopPermission(): NotificationPermission | 'unsupported' {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  }
}
