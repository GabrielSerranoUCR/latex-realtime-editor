import { KEEP_MS, Session } from './session';

/** A finished recording waiting in this browser, and when it will be thrown away. */
export interface SavedSession {
  session: Session;
  expiresAt: number;
}

export const isExpired = (s: SavedSession, now = Date.now()): boolean => now >= s.expiresAt;

/** A recording that has just ended, kept for `KEEP_MS`. */
export const keep = (session: Session, now = Date.now()): SavedSession => ({ session, expiresAt: now + KEEP_MS });

const DB = 'quill-session';
const STORE = 'kv';
const KEY = 'last';
let memory: SavedSession | null = null;

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Keep the last recording (one slot) so it survives a reload; where the browser will not store it, in memory until the page closes. */
export async function saveLast(rec: SavedSession): Promise<void> {
  memory = rec;
  const db = await open();
  if (db) await run(db, 'readwrite', (s) => s.put(rec, KEY));
  db?.close();
}

/** The kept recording, unless it has expired (then it is thrown away). */
export async function loadLast(now = Date.now()): Promise<SavedSession | null> {
  const db = await open();
  const stored = db ? await run<SavedSession>(db, 'readonly', (s) => s.get(KEY) as IDBRequest<SavedSession>) : null;
  db?.close();
  const rec = stored ?? memory;
  if (rec && isExpired(rec, now)) {
    await clearLast();
    return null;
  }
  return rec;
}

export async function clearLast(): Promise<void> {
  memory = null;
  const db = await open();
  if (db) await run(db, 'readwrite', (s) => s.delete(KEY));
  db?.close();
}
