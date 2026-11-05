import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { CollabService } from '../collab/collab.service';
import { MAX_RECORD_BYTES, MAX_RECORD_MS, Op, Session, TextChange, pushOp } from './session';
import { encodeSession, sessionFileName } from './session-file';
import { SavedSession, clearLast, keep, loadLast, saveLast } from './session-store';

/**
 * Records a scroll's editing as a timelapse: from "Record a session" until Stop, or until the hour (or 5 MB)
 * is used up. The recording is kept in this browser for 30 minutes to watch or export, then thrown away.
 */
@Injectable({ providedIn: 'root' })
export class SessionRecorderService {
  private readonly collab = inject(CollabService);

  readonly recording = signal(false);
  readonly elapsedMs = signal(0);
  readonly bytes = signal(0);
  /** The recording kept from last time, if it has not expired. */
  readonly last = signal<SavedSession | null>(null);
  /** The clock for "keeps for another …" (moves each second while something is kept). */
  readonly now = signal(Date.now());
  /** Why the last recording ended by itself, if it did. */
  readonly stoppedBecause = signal<string | null>(null);

  private ops: Op[] = [];
  private files: Array<{ path: string; text: string }> = [];
  private startedAt = 0;
  private title = '';
  private room: string | null = null;
  private unwatch: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private clock: ReturnType<typeof setInterval> | undefined;

  constructor() {
    void this.restore();
    // leaving the scroll ends the recording (the document is gone)
    effect(() => {
      const room = this.collab.roomId();
      untracked(() => {
        if (this.recording() && room !== this.room) void this.stop('You left the scroll, so the recording ended.');
      });
    });
  }

  /** Pick up what was kept before a reload, and start the countdown. */
  private async restore(): Promise<void> {
    const found = await loadLast();
    if (!this.last() && !this.recording()) this.last.set(found); // never replace a recording made while this was loading
    this.watchClock();
  }

  private watchClock(): void {
    clearInterval(this.clock);
    if (!this.last()) return;
    this.clock = setInterval(() => {
      this.now.set(Date.now());
      const l = this.last();
      if (l && Date.now() >= l.expiresAt) {
        this.last.set(null);
        void clearLast();
        clearInterval(this.clock);
      }
    }, 1000);
  }

  /** Milliseconds the kept recording will still be there. */
  keepsFor(): number {
    const l = this.last();
    return l ? Math.max(0, l.expiresAt - this.now()) : 0;
  }

  /** Begin recording. Needs the scroll to be open and in sync. */
  start(title: string): boolean {
    const room = this.collab.roomId();
    if (this.recording() || !room || !this.collab.synced()) return false;
    this.room = room;
    this.title = title;
    this.startedAt = Date.now();
    this.files = this.collab.files().map((path) => ({ path, text: this.collab.fileText(path) ?? '' }));
    this.ops = [];
    this.bytes.set(this.files.reduce((n, f) => n + f.text.length + f.path.length + 24, 200));
    this.elapsedMs.set(0);
    this.stoppedBecause.set(null);
    this.unwatch = this.collab.watchChanges((c) => this.onChange(c));
    this.timer = setInterval(() => {
      this.elapsedMs.set(Date.now() - this.startedAt);
      if (this.elapsedMs() >= MAX_RECORD_MS) void this.stop('The recording reached its hour and stopped.');
    }, 500);
    this.recording.set(true);
    return true;
  }

  private onChange(c: TextChange): void {
    const t = Date.now() - this.startedAt;
    const op: Op = c.kind === 'e' ? [t, 'e', c.path, c.pos, c.del, c.ins] : c.kind === 'c' ? [t, 'c', c.path, c.text] : [t, 'd', c.path];
    this.bytes.update((n) => n + pushOp(this.ops, op));
    if (this.bytes() >= MAX_RECORD_BYTES) void this.stop('The recording reached its size limit (5 MB) and stopped.');
  }

  /** Stop and keep what was recorded for 30 minutes. */
  async stop(because: string | null = null): Promise<Session | null> {
    if (!this.recording()) return null;
    this.unwatch?.();
    this.unwatch = null;
    clearInterval(this.timer);
    this.recording.set(false);
    this.stoppedBecause.set(because);
    const session: Session = { v: 1, title: this.title, startedAt: this.startedAt, durationMs: Date.now() - this.startedAt, files: this.files, ops: this.ops };
    this.ops = [];
    this.files = [];
    const saved = keep(session);
    this.last.set(saved);
    this.now.set(Date.now());
    this.watchClock();
    await saveLast(saved);
    return session;
  }

  /** Save the kept recording as a file (gzipped JSON). */
  async exportLast(): Promise<string | null> {
    const l = this.last();
    if (!l) return null;
    const bytes = await encodeSession(l.session);
    const name = sessionFileName(l.session.title, l.session.startedAt);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return name;
  }

  async discard(): Promise<void> {
    this.last.set(null);
    clearInterval(this.clock);
    await clearLast();
  }
}
