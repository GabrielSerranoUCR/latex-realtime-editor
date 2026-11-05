import { EnvironmentInjector, createEnvironmentInjector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import * as Y from 'yjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../auth/auth.service';
import { CollabService } from './collab.service';
import { CommentsService } from './comments.service';

const SOURCE = 'line one\nline two is here\nline three\n';

/** The scroll as it was before anyone looked at it: every browser starts from this same state. */
const BASE = (() => {
  const seed = new Y.Doc();
  seed.getMap<Y.Text>('files').set('main.tex', new Y.Text(SOURCE));
  seed.getMap<Y.Text>('files').set('other.tex', new Y.Text('other file\n'));
  return Y.encodeStateAsUpdate(seed);
})();

/** A scribe's browser: its own copy of the document and its own service, side by side with the others. */
function replica(userId = 'u1', name = 'Aelith') {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, BASE);
  const collab = { ydoc: signal<Y.Doc | null>(doc), files: signal(['main.tex', 'other.tex']), activeFile: signal<string | null>('main.tex'), me: signal({ name, color: '#C9A04A', colorLight: '#C9A04A33' }) };
  const auth = { user: signal<{ id: string } | null>({ id: userId }) };
  const injector = createEnvironmentInjector([{ provide: CollabService, useValue: collab }, { provide: AuthService, useValue: auth }, CommentsService], TestBed.inject(EnvironmentInjector));
  const svc = injector.get(CommentsService);
  TestBed.tick();
  const text = () => doc.getMap<Y.Text>('files').get('main.tex')!;
  return { svc, doc, collab, auth, text };
}

const sync = (from: { doc: Y.Doc }, to: { doc: Y.Doc }) => Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc));

describe('CommentsService', () => {
  let t: ReturnType<typeof replica>;
  beforeEach(() => {
    TestBed.resetTestingModule();
    t = replica();
  });

  it('starts a thread on a selection and shows it with its line and quote', () => {
    const id = t.svc.add('main.tex', 14, 21, '  Clarify this?  ');
    expect(id).toBeTruthy();
    const [thread] = t.svc.threads();
    expect(thread).toMatchObject({ file: 'main.tex', quote: 'two is', resolved: false });
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({ text: 'Clarify this?', authorId: 'u1', authorName: 'Aelith' });
    const [loc] = t.svc.located();
    expect(loc).toMatchObject({ line: 2, lost: false, from: 14, to: 21 });
    expect(t.svc.openCount()).toBe(1);
  });

  it('turns a bare caret into the whole line', () => {
    t.svc.add('main.tex', 12, 12, 'whole line please');
    expect(t.svc.threads()[0].quote).toBe('line two is here');
    expect(t.svc.located()[0]).toMatchObject({ from: 9, to: 25, line: 2 });
  });

  it('keeps notes attached to their text as the document changes around them', async () => {
    t.svc.add('main.tex', 9, 25, 'about line two');
    t.text().insert(0, 'a new first line\nand another\n');
    t.text().insert(t.text().toString().indexOf('is here'), 'XX ');
    await new Promise((r) => setTimeout(r, 260));
    TestBed.tick();
    const loc = t.svc.located()[0];
    expect(loc.line).toBe(4);
    expect(loc.lost).toBe(false);
    expect(t.text().toString().slice(loc.from!, loc.to!)).toBe('line two XX is here');
  });

  it('knows when the text a note was about has been deleted', async () => {
    t.svc.add('main.tex', 9, 25, 'about line two');
    t.text().delete(9, 17);
    await new Promise((r) => setTimeout(r, 260));
    TestBed.tick();
    expect(t.svc.located()[0].lost).toBe(true);
    expect(t.svc.threads()[0].quote).toBe('line two is here'); // the words are still on the note
  });

  it('replies, resolves and reopens', () => {
    const id = t.svc.add('main.tex', 0, 4, 'first')!;
    expect(t.svc.reply(id, 'second')).toBe(true);
    expect(t.svc.reply(id, '   ')).toBe(false);
    expect(t.svc.reply('nope', 'x')).toBe(false);
    expect(t.svc.threads()[0].messages.map((m) => m.text)).toEqual(['first', 'second']);
    t.svc.setResolved(id, true);
    expect(t.svc.threads()[0]).toMatchObject({ resolved: true, resolvedBy: 'Aelith' });
    expect(t.svc.openCount()).toBe(0);
    t.svc.setResolved(id, false);
    expect(t.svc.threads()[0]).toMatchObject({ resolved: false, resolvedBy: null });
  });

  it('refuses empty notes and notes on a file that is not there', () => {
    expect(t.svc.add('main.tex', 0, 3, '  ')).toBeNull();
    expect(t.svc.add('ghost.tex', 0, 3, 'hello')).toBeNull();
    expect(t.svc.threads()).toEqual([]);
  });

  it('lets you take back only your own messages, and removes the thread with the last one', () => {
    const mine = t.svc.add('main.tex', 0, 4, 'mine')!;
    // somebody else replies (as a different scribe)
    const other = replica('u2', 'Marcus');
    sync(t, other);
    other.svc.reply(mine, 'theirs');
    sync(other, t);
    const [thread] = t.svc.threads();
    expect(thread.messages.map((m) => m.authorName)).toEqual(['Aelith', 'Marcus']);
    t.svc.removeMessage(mine, thread.messages[1].id); // not mine: ignored
    expect(t.svc.threads()[0].messages).toHaveLength(2);
    t.svc.removeMessage(mine, thread.messages[0].id);
    expect(t.svc.threads()[0].messages.map((m) => m.authorName)).toEqual(['Marcus']);
    sync(t, other);
    other.svc.removeMessage(mine, thread.messages[1].id);
    expect(other.svc.threads()).toEqual([]);
  });

  it('lets the thread starter, or a manager, delete a whole thread', () => {
    const id = t.svc.add('main.tex', 0, 4, 'mine')!;
    const other = replica('u2', 'Marcus');
    sync(t, other);
    other.svc.removeThread(id); // a different scribe, not a manager
    expect(other.svc.threads()).toHaveLength(1);
    other.svc.removeThread(id, true);
    expect(other.svc.threads()).toEqual([]);
    sync(other, t);
    expect(t.svc.threads()).toEqual([]);
  });

  it('shares notes between replicas, including ones written at the same time', () => {
    const a = t;
    const b = replica('u2', 'Marcus');
    sync(a, b);
    a.svc.add('main.tex', 0, 4, 'from A');
    b.svc.add('main.tex', 9, 15, 'from B');
    sync(b, a);
    sync(a, b);
    expect(a.svc.threads().map((x) => x.messages[0].text).sort()).toEqual(['from A', 'from B']);
    expect(b.svc.threads()).toHaveLength(2);
  });

  it('orders notes by the open file first, then position', () => {
    t.svc.add('other.tex', 0, 5, 'in other');
    t.svc.add('main.tex', 20, 25, 'late');
    t.svc.add('main.tex', 0, 4, 'early');
    expect(t.svc.located().map((l) => l.thread.messages[0].text)).toEqual(['early', 'late', 'in other']);
  });

  it('ignores malformed notes that another browser might have written', () => {
    const notes = t.doc.getMap<unknown>('comments');
    notes.set('junk1', 'a string');
    const bad = new Y.Map<unknown>();
    bad.set('file', 7);
    notes.set('junk2', bad);
    const noMessages = new Y.Map<unknown>();
    noMessages.set('file', 'main.tex');
    noMessages.set('messages', new Y.Array());
    notes.set('junk3', noMessages);
    const odd = new Y.Map<unknown>();
    odd.set('file', 'main.tex');
    odd.set('start', 'x');
    odd.set('end', { nope: 1 });
    const msgs = new Y.Array<unknown>();
    msgs.push([{ id: 'm1', text: '<img src=x onerror=1>', at: 1, authorColor: 'red; background:url(x)', authorName: 'Eve' }, { id: 5 }, null]);
    odd.set('messages', msgs);
    notes.set('odd', odd);
    TestBed.tick();
    const [only] = t.svc.threads();
    expect(t.svc.threads()).toHaveLength(1);
    expect(only.messages).toHaveLength(1);
    expect(only.messages[0].authorColor).toBe('#C9A04A'); // never a raw style string
    expect(t.svc.located()[0].lost).toBe(true); // a broken anchor is "lost", not a crash
  });

  it('forgets everything when the scroll is closed', () => {
    t.svc.add('main.tex', 0, 4, 'x');
    (t.collab.ydoc as ReturnType<typeof signal<Y.Doc | null>>).set(null);
    TestBed.tick();
    expect(t.svc.threads()).toEqual([]);
  });
});
