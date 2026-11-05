import { describe, expect, it } from 'vitest';
import { Session } from './session';
import { decodeSession, encodeSession, sessionFileName } from './session-file';
import { isExpired, keep } from './session-store';

const session: Session = { v: 1, title: 'Thesis', startedAt: 1_700_000_000_000, durationMs: 5000, files: [{ path: 'main.tex', text: 'Hola ¿qué? ✓' }], ops: [[10, 'e', 'main.tex', 0, 0, 'x']] };

describe('session files', () => {
  it('round-trips, compressed where the browser can', async () => {
    const bytes = await encodeSession(session);
    expect(await decodeSession(bytes)).toEqual(session);
    if (typeof CompressionStream !== 'undefined') expect(bytes[0]).toBe(0x1f); // gzip
  });

  it('reads plain JSON too', async () => {
    expect(await decodeSession(new TextEncoder().encode(JSON.stringify(session)))).toEqual(session);
  });

  it('turns away files that are not recordings, or are too big', async () => {
    await expect(decodeSession(new TextEncoder().encode('not json'))).rejects.toThrow(/not a session recording/);
    await expect(decodeSession(new TextEncoder().encode('{"v":9}'))).rejects.toThrow(/session recording/);
    await expect(decodeSession(new Uint8Array(9 * 1024 * 1024))).rejects.toThrow(/too large/);
  });

  it('names the file after the scroll and the moment it was recorded', () => {
    expect(sessionFileName('Thesis – Chapter 4', new Date(2026, 10, 5, 14, 32).getTime())).toBe('Thesis-Chapter-4-2026-11-05-1432.quillsession');
    expect(sessionFileName('…', new Date(2026, 0, 2, 3, 4).getTime())).toBe('scroll-2026-01-02-0304.quillsession');
  });
});

describe('keeping a recording for 30 minutes', () => {
  it('is kept until half an hour after it ends, then it is gone', () => {
    const rec = keep(session, 1000);
    expect(rec.expiresAt).toBe(1000 + 30 * 60 * 1000);
    expect(isExpired(rec, 1000 + 30 * 60 * 1000 - 1)).toBe(false);
    expect(isExpired(rec, 1000 + 30 * 60 * 1000)).toBe(true);
  });
});
