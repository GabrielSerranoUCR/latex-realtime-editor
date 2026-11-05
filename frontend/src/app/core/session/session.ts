/**
 * Session recording: a timelapse of how a scroll's text changed. Only text is traced (no cursors, no pictures,
 * no screen), as a starting snapshot of every file plus a list of small edits with their times. That is a few
 * kilobytes per minute of typing, so an hour fits comfortably under the size limit.
 */

/** The longest a recording may run. */
export const MAX_RECORD_MS = 60 * 60 * 1000;
/** The most a recording may weigh (as JSON, before compression). */
export const MAX_RECORD_BYTES = 5 * 1024 * 1024;
/** How long a finished recording is kept in this browser, to watch or export. */
export const KEEP_MS = 30 * 60 * 1000;

/** Limits for a file that is imported (a stranger's file is never trusted). */
export const MAX_IMPORT_COMPRESSED = 8 * 1024 * 1024;
export const MAX_IMPORT_JSON = 30 * 1024 * 1024;
export const MAX_IMPORT_OPS = 400_000;

/** One change, `t` milliseconds after the recording began: an edit of a file, a file made, a file deleted. */
export type Op = [t: number, kind: 'e', path: string, pos: number, del: number, ins: string] | [t: number, kind: 'c', path: string, text: string] | [t: number, kind: 'd', path: string];

export interface Session {
  v: 1;
  title: string;
  /** When it began (milliseconds since 1970). */
  startedAt: number;
  durationMs: number;
  /** Every file as it was at the start. */
  files: Array<{ path: string; text: string }>;
  ops: Op[];
}

/** A change as the document reports it (the time is added by the recorder). */
export type TextChange = { kind: 'e'; path: string; pos: number; del: number; ins: string } | { kind: 'c'; path: string; text: string } | { kind: 'd'; path: string };

/** About what an op weighs once written as JSON. */
export function opSize(op: Op): number {
  return 16 + op[2].length + (op[1] === 'e' ? op[5].length + 8 : op[1] === 'c' ? op[3].length : 0);
}

/** Typing letter by letter is merged into one entry (also a run of backspaces), so the list stays short. */
const MERGE_WITHIN_MS = 1500;
const MERGE_MAX_CHARS = 400;

/** Add an op, joining it to the one before when they continue each other. Returns the bytes that were added. */
export function pushOp(ops: Op[], op: Op): number {
  const last = ops[ops.length - 1];
  if (last && last[1] === 'e' && op[1] === 'e' && last[2] === op[2] && op[0] - last[0] <= MERGE_WITHIN_MS) {
    // typing on: the new text starts where the last text ended
    if (last[4] === 0 && op[4] === 0 && op[3] === last[3] + last[5].length && last[5].length < MERGE_MAX_CHARS) {
      last[5] += op[5];
      return op[5].length;
    }
    // backspacing on: the new deletion ends where the last one began
    if (last[5] === '' && op[5] === '' && last[4] > 0 && op[4] > 0 && op[3] + op[4] === last[3] && last[4] < MERGE_MAX_CHARS) {
      last[3] = op[3];
      last[4] += op[4];
      return 0;
    }
  }
  ops.push(op);
  return opSize(op);
}

/** Make the change in a set of files (path to text). */
export function applyOp(files: Map<string, string>, op: Op): void {
  const path = op[2];
  if (op[1] === 'c') files.set(path, op[3]);
  else if (op[1] === 'd') files.delete(path);
  else {
    const text = files.get(path) ?? '';
    const pos = Math.min(Math.max(0, op[3]), text.length);
    files.set(path, text.slice(0, pos) + op[5] + text.slice(pos + op[4]));
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Check something read from a file and turn it into a Session, or say what is wrong with it. Never trusts its shape. */
export function validateSession(raw: unknown): Session {
  const bad = (why: string): never => {
    throw new Error(`This is not a session recording the tavern can read: ${why}.`);
  };
  if (!raw || typeof raw !== 'object') return bad('it is not a recording');
  const r = raw as Record<string, unknown>;
  if (r['v'] !== 1) return bad('its version is not known');
  if (!isStr(r['title']) || !isNum(r['startedAt']) || !isNum(r['durationMs'])) return bad('the header is incomplete');
  if (!Array.isArray(r['files']) || !Array.isArray(r['ops'])) return bad('it has no files or no edits');
  if (r['ops'].length > MAX_IMPORT_OPS) return bad('it has too many edits');
  const files = (r['files'] as unknown[]).map((f) => {
    const x = f as Record<string, unknown>;
    return isStr(x?.['path']) && isStr(x?.['text']) ? { path: x['path'], text: x['text'] } : bad('a file entry is damaged');
  });
  let last = 0;
  const ops = (r['ops'] as unknown[]).map((o) => {
    const a = o as unknown[];
    if (!Array.isArray(a) || !isNum(a[0]) || a[0] < last || !isStr(a[2])) return bad('an edit is damaged');
    last = a[0];
    if (a[1] === 'e' && isNum(a[3]) && isNum(a[4]) && isStr(a[5]) && a[3] >= 0 && a[4] >= 0) return a as unknown as Op;
    if (a[1] === 'c' && isStr(a[3])) return a as unknown as Op;
    if (a[1] === 'd') return [a[0], 'd', a[2]] as Op;
    return bad('an edit is of an unknown kind');
  });
  return { v: 1, title: r['title'].slice(0, 200), startedAt: r['startedAt'], durationMs: Math.max(0, r['durationMs']), files, ops };
}

// ---- the sped-up timeline

/** A pause longer than this is shortened to this: a timelapse does not wait while you think. */
export const MAX_GAP_MS = 3000;

/** Each edit's time on the timelapse's own clock (long pauses cut), and its total length. */
export function compressTimes(ops: readonly Op[], maxGap = MAX_GAP_MS): { vt: number[]; total: number } {
  const vt: number[] = [];
  let now = 0;
  let prev = 0;
  for (const op of ops) {
    now += Math.min(Math.max(0, op[0] - prev), maxGap);
    prev = op[0];
    vt.push(now);
  }
  return { vt, total: now + 600 };
}

export const SPEEDS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512] as const;

/** The speed at which the whole timelapse takes about `targetMs` (never slower than real time). */
export function autoSpeed(totalMs: number, targetMs = 45_000): number {
  const wanted = totalMs / targetMs;
  return SPEEDS.find((s) => s >= wanted) ?? SPEEDS[SPEEDS.length - 1];
}

/** "07:05", or "1:02:09" past an hour. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${String(m).padStart(2, '0')}:${sec}`;
}

const CHECKPOINT_EVERY = 1500;

/** Plays a Session forward and can jump anywhere (it keeps a few snapshots to jump from). */
export class Replayer {
  readonly vt: number[];
  readonly total: number;
  private files = new Map<string, string>();
  private applied = 0;
  private readonly checkpoints: Array<{ at: number; files: Map<string, string> }> = [];

  constructor(readonly session: Session) {
    ({ vt: this.vt, total: this.total } = compressTimes(session.ops));
    this.reset();
  }

  private reset(): void {
    this.files = new Map(this.session.files.map((f) => [f.path, f.text]));
    this.applied = 0;
  }

  get texts(): ReadonlyMap<string, string> {
    return this.files;
  }
  get appliedCount(): number {
    return this.applied;
  }

  /** How many edits happen at or before this time on the timelapse's clock. */
  private countAt(vt: number): number {
    let lo = 0;
    let hi = this.vt.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.vt[mid] <= vt) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Apply every edit up to this time (forward only). Returns the last edit applied, or null if none. */
  advanceTo(vt: number): Op | null {
    const to = this.countAt(vt);
    let last: Op | null = null;
    while (this.applied < to) {
      last = this.session.ops[this.applied];
      applyOp(this.files, last);
      this.applied++;
      if (this.applied % CHECKPOINT_EVERY === 0 && !this.checkpoints.some((c) => c.at === this.applied)) this.checkpoints.push({ at: this.applied, files: new Map(this.files) });
    }
    return last;
  }

  /** Jump to a time, before or after the present one. */
  seekTo(vt: number): Op | null {
    const to = this.countAt(vt);
    if (to < this.applied) {
      const from = [...this.checkpoints].reverse().find((c) => c.at <= to);
      this.files = new Map(from?.files ?? this.session.files.map((f) => [f.path, f.text]));
      this.applied = from?.at ?? 0;
    }
    return this.advanceTo(vt) ?? (this.applied > 0 ? this.session.ops[this.applied - 1] : null);
  }
}
