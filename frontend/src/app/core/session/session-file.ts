import { MAX_IMPORT_COMPRESSED, MAX_IMPORT_JSON, Session, validateSession } from './session';

/** What a saved recording is called: "Thesis-2026-11-05-1432.quillsession". */
export function sessionFileName(title: string, startedAt: number): string {
  const d = new Date(startedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const base = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${base || 'scroll'}-${stamp}.quillsession`;
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  const reader = source.pipeThrough(stream as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error('This recording is far too large to open.');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A recording as bytes to save: its JSON, compressed where the browser can (typed text compresses very well). */
export async function encodeSession(session: Session): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(session));
  return typeof CompressionStream === 'undefined' ? json : through(json, new CompressionStream('gzip'));
}

/** Read a recording from a file's bytes (compressed or plain JSON), checking everything about it. */
export async function decodeSession(bytes: Uint8Array): Promise<Session> {
  if (bytes.length > MAX_IMPORT_COMPRESSED) throw new Error('That file is too large to be a session recording.');
  let json = bytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open compressed recordings.');
    json = await through(bytes, new DecompressionStream('gzip'), MAX_IMPORT_JSON);
  }
  if (json.length > MAX_IMPORT_JSON) throw new Error('That file is too large to be a session recording.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(json));
  } catch {
    throw new Error('That file is not a session recording.');
  }
  return validateSession(parsed);
}
