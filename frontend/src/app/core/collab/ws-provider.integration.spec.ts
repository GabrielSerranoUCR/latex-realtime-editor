// @vitest-environment node
import { Awareness } from 'y-protocols/awareness';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WsProvider } from './ws-provider';

/**
 * Runs against a *real* quill-server (and its PostgreSQL). Start both, then:
 *   QUILL_WS=ws://localhost:8080 npm test
 * Skipped when QUILL_WS is not set.
 */
const base: string | undefined = (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.['QUILL_WS'];
const live = base ? describe : describe.skip;
const http = (base ?? '').replace(/^ws/, 'http');

async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Sign up a throwaway account and create a scroll (no Origin header: not a browser). */
async function account() {
  const email = `vitest-${Date.now()}-${Math.floor(Math.random() * 1e6)}@guild.test`;
  const signup = await fetch(`${http}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, displayName: 'Vitest', password: 'correct horse battery staple' }),
  });
  const cookie = signup.headers.getSetCookie().find((c) => c.startsWith('quill_session='))!.split(';')[0];
  const scroll = await (await fetch(`${http}/api/scrolls`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ title: 'live test' }) })).json();
  return { cookie, room: scroll.id as string };
}

/** A WebSocket that sends our session cookie, like a signed-in browser tab. */
const withCookie = (cookie: string) =>
  class extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, { headers: { cookie }, protocols } as never);
    }
  } as unknown as typeof WebSocket;

function client(room: string, cookie: string) {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const provider = new WsProvider(`${base}/ws/${room}`, doc, awareness, { minBackoffMs: 50, webSocketCtor: withCookie(cookie) });
  return { doc, awareness, provider, files: doc.getMap<Y.Text>('files') };
}

live('WsProvider ↔ quill-server', () => {
  it('connects, syncs and reports status', async () => {
    const { cookie, room } = await account();
    const a = client(room, cookie);
    expect(a.provider.status$.value).toBe('connecting');
    await until(() => a.provider.status$.value === 'connected', 'connected');
    await until(() => a.provider.synced$.value, 'synced');
    a.provider.destroy();
    expect(a.provider.status$.value).toBe('offline');
  });

  it('propagates edits between two clients in both directions', async () => {
    const { cookie, room } = await account();
    const a = client(room, cookie);
    const b = client(room, cookie);
    await until(() => a.provider.synced$.value && b.provider.synced$.value, 'both synced');

    a.doc.transact(() => {
      const t = new Y.Text();
      t.insert(0, 'hello');
      a.files.set('main.tex', t);
    });
    await until(() => b.files.get('main.tex')?.toString() === 'hello', 'B sees A');

    b.files.get('main.tex')!.insert(5, ' world');
    await until(() => a.files.get('main.tex')?.toString() === 'hello world', 'A sees B');
    a.provider.destroy();
    b.provider.destroy();
  });

  it('merges edits that were made before the connection existed', async () => {
    const { cookie, room } = await account();
    const a = client(room, cookie);
    await until(() => a.provider.synced$.value, 'A synced');
    a.doc.transact(() => {
      const t = new Y.Text();
      t.insert(0, 'base');
      a.files.set('main.tex', t);
    });

    // C types while "offline" (before its provider exists), then connects.
    const doc = new Y.Doc();
    doc.getMap<Y.Text>('files').set('notes.tex', new Y.Text('written offline'));
    const provider = new WsProvider(`${base}/ws/${room}`, doc, new Awareness(doc), { minBackoffMs: 50, webSocketCtor: withCookie(cookie) });

    await until(() => a.files.get('notes.tex')?.toString() === 'written offline', 'offline edit reached A');
    await until(() => doc.getMap<Y.Text>('files').get('main.tex')?.toString() === 'base', 'C received A');
    a.provider.destroy();
    provider.destroy();
  });

  it('shares presence and clears it when a scribe leaves', async () => {
    const { cookie, room } = await account();
    const a = client(room, cookie);
    const b = client(room, cookie);
    await until(() => a.provider.synced$.value && b.provider.synced$.value, 'both synced');
    a.awareness.setLocalStateField('user', { name: 'Aelith', color: '#D9772B' });
    await until(() => b.awareness.getStates().get(a.doc.clientID)?.['user']?.name === 'Aelith', 'B sees Aelith');

    a.provider.destroy();
    await until(() => !b.awareness.getStates().has(a.doc.clientID), 'Aelith removed');
    b.provider.destroy();
  });

  it('recovers after the socket drops (reconnect with back-off)', async () => {
    const { cookie, room } = await account();
    const a = client(room, cookie);
    await until(() => a.provider.synced$.value, 'synced');
    const sock = (a.provider as unknown as { socket: { _socket?: WebSocket } }).socket?._socket;
    sock?.close();
    await until(() => a.provider.status$.value !== 'connected', 'went offline');
    await until(() => a.provider.status$.value === 'connected', 'reconnected');
    a.provider.destroy();
  });

  it('is refused without a session', async () => {
    const { room } = await account();
    const a = client(room, 'quill_session=not-a-real-token');
    // never reaches "connected": the server answers 401 to the upgrade and the provider keeps retrying
    await new Promise((r) => setTimeout(r, 600));
    expect(a.provider.status$.value).not.toBe('connected');
    a.provider.destroy();
  });
});
