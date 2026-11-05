import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../auth/auth.service';
import { CollabService } from '../collab/collab.service';
import { CommentsService } from '../collab/comments.service';
import { NoteThread } from '../collab/comments';
import { PreferencesService } from '../prefs/prefs.service';
import { NotificationsService } from './notifications.service';
import { ToastService } from './toast.service';

const msg = (id: string, authorId: string, authorName: string, text: string) => ({ id, authorId, authorName, authorColor: '#C9A04A', text, at: 1 });
const thread = (id: string, messages: ReturnType<typeof msg>[]): NoteThread => ({ id, file: 'main.tex', anchor: { start: 0, end: 0 }, quote: 'q', resolved: false, resolvedBy: null, createdAt: 1, messages });

function setup() {
  const collab = { synced: signal(false), peers: signal<Array<{ clientId: number; user: { name: string; id?: string } }>>([]), me: signal({ name: 'Aelith' }) };
  const comments = { threads: signal<NoteThread[]>([]) };
  const auth = { user: signal<{ id: string } | null>({ id: 'me' }) };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: CollabService, useValue: collab }, { provide: CommentsService, useValue: comments }, { provide: AuthService, useValue: auth }] });
  const svc = TestBed.inject(NotificationsService);
  const toasts = TestBed.inject(ToastService);
  const prefs = TestBed.inject(PreferencesService);
  TestBed.tick();
  const texts = () => toasts.toasts().map((t) => t.text);
  return { svc, collab, comments, toasts, prefs, texts };
}

describe('NotificationsService', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does not call what was already on the table news', () => {
    const t = setup();
    t.comments.threads.set([thread('a', [msg('1', 'u2', 'Marcus', 'old note')])]);
    t.collab.synced.set(true);
    TestBed.tick();
    expect(t.texts()).toEqual([]);
  });

  it('tells you about a new note from someone else, and about a mention', () => {
    const t = setup();
    t.collab.synced.set(true);
    TestBed.tick();
    t.comments.threads.set([thread('a', [msg('1', 'u2', 'Marcus', 'a question')])]);
    TestBed.tick();
    expect(t.texts()).toEqual(['Marcus wrote a margin note: a question']);
    t.comments.threads.set([thread('a', [msg('1', 'u2', 'Marcus', 'a question'), msg('2', 'u2', 'Marcus', 'ping @Aelith')])]);
    TestBed.tick();
    expect(t.texts().at(-1)).toBe('Marcus mentioned you: ping @Aelith');
    expect(t.texts()).toHaveLength(2);
  });

  it('keeps quiet about your own notes, and when notes are switched off', () => {
    const t = setup();
    t.collab.synced.set(true);
    TestBed.tick();
    t.comments.threads.set([thread('a', [msg('1', 'me', 'Aelith', 'mine')])]);
    TestBed.tick();
    expect(t.texts()).toEqual([]);
    t.prefs.update({ notifyMentions: false });
    t.comments.threads.set([thread('a', [msg('1', 'me', 'Aelith', 'mine'), msg('2', 'u2', 'Marcus', 'hello')])]);
    TestBed.tick();
    expect(t.texts()).toEqual([]);
  });

  it('says when scribes come and go, but not for who was already here', () => {
    const t = setup();
    t.collab.peers.set([{ clientId: 1, user: { name: 'Marcus' } }]);
    t.collab.synced.set(true);
    TestBed.tick();
    expect(t.texts()).toEqual([]);
    t.collab.peers.set([{ clientId: 1, user: { name: 'Marcus' } }, { clientId: 2, user: { name: 'Gabriel' } }]);
    TestBed.tick();
    t.collab.peers.set([{ clientId: 2, user: { name: 'Gabriel' } }]);
    TestBed.tick();
    expect(t.texts()).toEqual(['Gabriel joined the table.', 'Marcus left the table.']);
  });

  it('does not announce your own other tabs as someone joining', () => {
    const t = setup();
    t.collab.synced.set(true);
    TestBed.tick();
    t.collab.peers.set([{ clientId: 7, user: { name: 'Aelith', id: 'me' } }]);
    TestBed.tick();
    t.collab.peers.set([]);
    TestBed.tick();
    expect(t.texts()).toEqual([]);
  });

  it('can be told not to announce arrivals', () => {
    const t = setup();
    t.prefs.update({ joinLeave: false });
    t.collab.synced.set(true);
    TestBed.tick();
    t.collab.peers.set([{ clientId: 9, user: { name: 'Eve' } }]);
    TestBed.tick();
    expect(t.texts()).toEqual([]);
  });

  it('starts over when the table is left and rejoined', () => {
    const t = setup();
    t.collab.synced.set(true);
    TestBed.tick();
    t.collab.synced.set(false);
    TestBed.tick();
    t.comments.threads.set([thread('a', [msg('1', 'u2', 'Marcus', 'seen on the way in')])]);
    t.collab.synced.set(true);
    TestBed.tick();
    expect(t.texts()).toEqual([]);
  });

  it('reports what the browser allows for desktop notifications', async () => {
    const t = setup();
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' });
    expect(t.svc.desktopPermission()).toBe('default');
    expect(await t.svc.requestDesktopPermission()).toBe('granted');
    vi.stubGlobal('Notification', { permission: 'denied' });
    expect(await t.svc.requestDesktopPermission()).toBe('denied');
    vi.stubGlobal('Notification', undefined);
    expect(await t.svc.requestDesktopPermission()).toBe('unsupported');
  });
});

describe('ToastService', () => {
  it('shows a message and removes it after its time', () => {
    vi.useFakeTimers();
    TestBed.resetTestingModule();
    const toasts = TestBed.inject(ToastService);
    const id = toasts.show('hello');
    expect(toasts.toasts().map((t) => t.text)).toEqual(['hello']);
    vi.advanceTimersByTime(5100);
    expect(toasts.toasts()).toEqual([]);
    toasts.show('a'); toasts.show('b'); toasts.show('c'); toasts.show('d'); toasts.show('e');
    expect(toasts.toasts().map((t) => t.text)).toEqual(['b', 'c', 'd', 'e']);
    toasts.dismiss(toasts.toasts()[0].id);
    expect(toasts.toasts()).toHaveLength(3);
    expect(id).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});
