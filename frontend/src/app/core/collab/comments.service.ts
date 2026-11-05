import { Injectable, computed, effect, inject, signal } from '@angular/core';
import * as Y from 'yjs';
import { AuthService } from '../auth/auth.service';
import { CollabService } from './collab.service';
import { Located, MAX_NOTE_CHARS, MAX_QUOTE_CHARS, NoteMessage, NoteThread, cleanNote, countOpen, lineOf, noteRange, quoteFor, sortLocated } from './comments';

const ROOT = 'comments';

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Margin notes, kept in the scroll's shared document so every scribe sees them the moment they are written. */
@Injectable({ providedIn: 'root' })
export class CommentsService {
  private readonly collab = inject(CollabService);
  private readonly auth = inject(AuthService);

  /** Every thread, as plain data, in the order they were written. */
  readonly threads = signal<NoteThread[]>([]);
  /** Bumped (after a short pause) when any file's text changes, so line numbers stay true while people type. */
  private readonly textRev = signal(0);

  readonly openCount = computed(() => countOpen(this.threads()));

  /** Threads with their current place in the text. */
  readonly located = computed<Array<Located<NoteThread>>>(() => {
    this.textRev();
    this.collab.files(); // a file added or removed
    const doc = this.collab.ydoc();
    return sortLocated(this.threads().map((t) => this.locate(doc, t)), this.collab.activeFile());
  });

  constructor() {
    effect((onCleanup) => {
      const doc = this.collab.ydoc();
      if (!doc) {
        this.threads.set([]);
        return;
      }
      const map = doc.getMap<Y.Map<unknown>>(ROOT);
      const files = doc.getMap<Y.Text>('files');
      const refresh = () => this.threads.set(readThreads(map));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bump = () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.textRev.update((n) => n + 1), 200);
      };
      map.observeDeep(refresh);
      files.observeDeep(bump);
      refresh();
      onCleanup(() => {
        map.unobserveDeep(refresh);
        files.unobserveDeep(bump);
        clearTimeout(timer);
      });
    });
  }

  private locate(doc: Y.Doc | null, t: NoteThread): Located<NoteThread> {
    const text = doc?.getMap<Y.Text>('files').get(t.file);
    if (!doc || !text) return { thread: t, line: null, lost: true, from: null, to: null };
    const start = absolute(doc, t.anchor.start, text);
    const end = absolute(doc, t.anchor.end, text);
    if (start === null || end === null) return { thread: t, line: null, lost: true, from: null, to: null };
    const to = Math.max(start, end);
    return { thread: t, line: lineOf(text.toString(), start), lost: t.quote !== '' && to <= start, from: start, to };
  }

  /** The author of what you write. */
  private author(): Pick<NoteMessage, 'authorId' | 'authorName' | 'authorColor'> | null {
    const u = this.auth.user();
    if (!u) return null;
    const me = this.collab.me();
    return { authorId: u.id, authorName: me.name, authorColor: me.color };
  }

  private message(text: string): NoteMessage | null {
    const a = this.author();
    const clean = cleanNote(text);
    return a && clean ? { id: crypto.randomUUID(), ...a, text: clean, at: Date.now() } : null;
  }

  /** Start a thread about a range of a file (a bare caret means its whole line). Returns the thread id, or null. */
  add(file: string, from: number, to: number, text: string): string | null {
    const doc = this.collab.ydoc();
    const ytext = doc?.getMap<Y.Text>('files').get(file);
    const first = this.message(text);
    if (!doc || !ytext || !first) return null;
    const source = ytext.toString();
    const range = noteRange(source, Math.min(from, ytext.length), Math.min(to, ytext.length));
    const id = crypto.randomUUID();
    doc.transact(() => {
      const t = new Y.Map<unknown>();
      t.set('id', id);
      t.set('file', file);
      t.set('start', Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, range.from, 0)));
      t.set('end', Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, range.to, -1)));
      t.set('quote', quoteFor(source, range.from, range.to));
      t.set('resolved', false);
      t.set('resolvedBy', null);
      t.set('createdAt', Date.now());
      const messages = new Y.Array<NoteMessage>();
      messages.push([first]);
      t.set('messages', messages);
      doc.getMap<Y.Map<unknown>>(ROOT).set(id, t);
    });
    return id;
  }

  reply(threadId: string, text: string): boolean {
    const doc = this.collab.ydoc();
    const msg = this.message(text);
    const messages = doc?.getMap<Y.Map<unknown>>(ROOT).get(threadId)?.get('messages') as Y.Array<NoteMessage> | undefined;
    if (!doc || !msg || !messages) return false;
    messages.push([msg]);
    return true;
  }

  setResolved(threadId: string, resolved: boolean): void {
    const doc = this.collab.ydoc();
    const t = doc?.getMap<Y.Map<unknown>>(ROOT).get(threadId);
    const a = this.author();
    if (!doc || !t || !a) return;
    doc.transact(() => {
      t.set('resolved', resolved);
      t.set('resolvedBy', resolved ? a.authorName : null);
    });
  }

  /** You can take back your own message; taking back the last one removes the thread. */
  removeMessage(threadId: string, messageId: string): void {
    const doc = this.collab.ydoc();
    const root = doc?.getMap<Y.Map<unknown>>(ROOT);
    const t = root?.get(threadId);
    const messages = t?.get('messages') as Y.Array<NoteMessage> | undefined;
    const me = this.auth.user()?.id;
    if (!doc || !root || !messages || !me) return;
    const index = messages.toArray().findIndex((m) => m?.id === messageId);
    if (index < 0 || messages.get(index).authorId !== me) return;
    doc.transact(() => {
      if (messages.length === 1) root.delete(threadId);
      else messages.delete(index, 1);
    });
  }

  /** The scribe who started a thread may delete it whole; so may someone who manages the scroll (`asManager`). */
  removeThread(threadId: string, asManager = false): void {
    const doc = this.collab.ydoc();
    const root = doc?.getMap<Y.Map<unknown>>(ROOT);
    const messages = root?.get(threadId)?.get('messages') as Y.Array<NoteMessage> | undefined;
    const me = this.auth.user()?.id;
    if (!root || !messages || !me) return;
    if (asManager || messages.get(0)?.authorId === me) root.delete(threadId);
  }
}

function absolute(doc: Y.Doc, json: unknown, text: Y.Text): number | null {
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc);
    return abs && abs.type === text ? abs.index : null;
  } catch {
    return null;
  }
}

/** Read the shared map defensively: it was written by other browsers, so take only what is well-formed. */
export function readThreads(map: Y.Map<Y.Map<unknown>>): NoteThread[] {
  const out: NoteThread[] = [];
  map.forEach((t, key) => {
    if (!(t instanceof Y.Map)) return;
    const messagesRaw = t.get('messages');
    const raw = messagesRaw instanceof Y.Array ? messagesRaw.toArray() : [];
    const messages: NoteMessage[] = [];
    for (const m of raw as Array<Partial<NoteMessage> | null>) {
      if (!m || typeof m.id !== 'string' || typeof m.text !== 'string' || typeof m.at !== 'number') continue;
      messages.push({ id: m.id.slice(0, 64), authorId: str(m.authorId, 64), authorName: str(m.authorName, 80) || 'A scribe', authorColor: /^#[0-9a-fA-F]{3,8}$/.test(String(m.authorColor)) ? String(m.authorColor) : '#C9A04A', text: m.text.slice(0, MAX_NOTE_CHARS), at: m.at });
    }
    const file = t.get('file');
    if (!messages.length || typeof file !== 'string') return;
    out.push({
      id: typeof t.get('id') === 'string' ? (t.get('id') as string).slice(0, 64) : key,
      file,
      anchor: { start: t.get('start'), end: t.get('end') },
      quote: str(t.get('quote'), MAX_QUOTE_CHARS + 1),
      resolved: t.get('resolved') === true,
      resolvedBy: typeof t.get('resolvedBy') === 'string' ? (t.get('resolvedBy') as string).slice(0, 80) : null,
      createdAt: typeof t.get('createdAt') === 'number' ? (t.get('createdAt') as number) : messages[0].at,
      messages,
    });
  });
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
