/** Line diffs between the live scroll and an older version, and the small helpers the history panel needs. */

export type DiffType = 'same' | 'add' | 'del';

export interface DiffLine {
  type: DiffType;
  text: string;
  /** 1-based line in the older version (same, add). */
  old?: number;
  /** 1-based line in the current version (same, del). */
  now?: number;
}

type Op = 'same' | 'del' | 'add';

/** Myers' O(ND) shortest edit script. Returns null when more than `maxD` edits are needed. */
function myers(a: readonly string[], b: readonly string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice()); // the furthest-reaching points after round d - 1
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        const ops: Op[] = [];
        let cx = n;
        let cy = m;
        for (let dd = d; dd > 0; dd--) {
          const vv = trace[dd];
          const kk = cx - cy;
          const prevK = kk === -dd || (kk !== dd && vv[off + kk - 1] < vv[off + kk + 1]) ? kk + 1 : kk - 1;
          const prevX = vv[off + prevK];
          const prevY = prevX - prevK;
          while (cx > prevX && cy > prevY) {
            ops.push('same');
            cx--;
            cy--;
          }
          if (cx === prevX) {
            ops.push('add');
            cy--;
          } else {
            ops.push('del');
            cx--;
          }
        }
        while (cx > 0 && cy > 0) {
          ops.push('same');
          cx--;
          cy--;
        }
        return ops.reverse();
      }
    }
  }
  return null;
}

/**
 * What restoring would do: `add` lines exist only in the old version (they come back), `del` lines exist
 * only in the current one (they go away). Common head and tail are trimmed, then a shortest edit script
 * finds the rest; a middle needing more than `maxEdits` changes is shown as one replaced block.
 */
export function diffLines(current: readonly string[], old: readonly string[], maxEdits = 1500): DiffLine[] {
  let head = 0;
  while (head < current.length && head < old.length && current[head] === old[head]) head++;
  let tail = 0;
  while (tail < current.length - head && tail < old.length - head && current[current.length - 1 - tail] === old[old.length - 1 - tail]) tail++;
  const a = current.slice(head, current.length - tail);
  const b = old.slice(head, old.length - tail);

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ type: 'same', text: current[i], old: i + 1, now: i + 1 });

  const ops: Op[] = (a.length && b.length ? myers(a, b, maxEdits) : null) ?? [...a.map(() => 'del' as const), ...b.map(() => 'add' as const)];
  let i = 0;
  let j = 0;
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    out.push(...dels, ...adds); // within a changed block, what goes away comes before what comes back
    dels = [];
    adds = [];
  };
  for (const op of ops) {
    if (op === 'same') {
      flush();
      out.push({ type: 'same', text: a[i], old: head + j + 1, now: head + i + 1 });
      i++;
      j++;
    } else if (op === 'del') dels.push({ type: 'del', text: a[i], now: head + ++i });
    else adds.push({ type: 'add', text: b[j], old: head + ++j });
  }
  flush();

  for (let k = 0; k < tail; k++) {
    const ci = current.length - tail + k;
    const oi = old.length - tail + k;
    out.push({ type: 'same', text: current[ci], old: oi + 1, now: ci + 1 });
  }
  return out;
}

export const splitLines = (text: string): string[] => (text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n'));

export interface DiffCount {
  add: number;
  del: number;
}
export const countChanges = (lines: readonly DiffLine[]): DiffCount => ({ add: lines.filter((l) => l.type === 'add').length, del: lines.filter((l) => l.type === 'del').length });

export type FileStatus = 'same' | 'changed' | 'added' | 'removed';
export interface FileChange extends DiffCount {
  path: string;
  /** Seen from the older version: `added` = would come back, `removed` = would go away. */
  status: FileStatus;
}

/** Every file in either version with what restoring would do to it. */
export function compareFiles(current: ReadonlyMap<string, string>, old: ReadonlyMap<string, string>): FileChange[] {
  const paths = [...new Set([...current.keys(), ...old.keys()])].sort((a, b) => a.localeCompare(b));
  return paths.map((path) => {
    const now = current.get(path);
    const then = old.get(path);
    if (now === undefined) return { path, status: 'added' as const, add: splitLines(then!).length, del: 0 };
    if (then === undefined) return { path, status: 'removed' as const, add: 0, del: splitLines(now).length };
    if (now === then) return { path, status: 'same' as const, add: 0, del: 0 };
    return { path, status: 'changed' as const, ...countChanges(diffLines(splitLines(now), splitLines(then))) };
  });
}

export const totals = (changes: readonly FileChange[]): DiffCount & { files: number } => ({
  files: changes.filter((c) => c.status !== 'same').length,
  add: changes.reduce((n, c) => n + c.add, 0),
  del: changes.reduce((n, c) => n + c.del, 0),
});

export type Row = ({ kind: 'line' } & DiffLine) | { kind: 'fold'; id: number; lines: DiffLine[] };

/** Collapse long unchanged stretches, keeping `keep` lines of context around every change. */
export function foldContext(lines: readonly DiffLine[], keep = 3, minFold = 6): Row[] {
  const rows: Row[] = [];
  let run: DiffLine[] = [];
  let id = 0;
  const flush = (atStart: boolean, atEnd: boolean) => {
    if (!run.length) return;
    const lead = atStart ? 0 : keep;
    const trail = atEnd ? 0 : keep;
    if (run.length < lead + trail + minFold) run.forEach((l) => rows.push({ kind: 'line', ...l }));
    else {
      run.slice(0, lead).forEach((l) => rows.push({ kind: 'line', ...l }));
      rows.push({ kind: 'fold', id: id++, lines: run.slice(lead, run.length - trail) });
      run.slice(run.length - trail).forEach((l) => rows.push({ kind: 'line', ...l }));
    }
    run = [];
  };
  let started = false;
  for (const l of lines) {
    if (l.type === 'same') run.push(l);
    else {
      flush(!started, false);
      started = true;
      rows.push({ kind: 'line', ...l });
    }
  }
  flush(!started, true);
  return rows;
}

// ---- timeline text

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** "Today · 14:32", "Yesterday · 18:04", "Mon · 16:45" (within a week), else "12 Oct · 09:20". */
export function whenLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(d)) / 86_400_000);
  if (days === 0) return `Today · ${time}`;
  if (days === 1) return `Yesterday · ${time}`;
  if (days > 1 && days < 7) return `${DAYS[d.getDay()]} · ${time}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? '' : ' ' + d.getFullYear()} · ${time}`;
}

export interface VersionLike {
  label: string | null;
  auto: boolean;
  authorName: string | null;
}

export const SAFETY_LABEL = 'Before restoring an earlier version';

export type VersionKind = 'named' | 'auto' | 'safety';
export const kindOf = (v: VersionLike): VersionKind => (v.label === SAFETY_LABEL ? 'safety' : v.auto ? 'auto' : 'named');

/** A line of prose for the timeline: who, and what kind of snapshot. */
export function describeVersion(v: VersionLike): string {
  const who = v.authorName ?? '';
  switch (kindOf(v)) {
    case 'named': return who ? `${who} · “${v.label}”` : `“${v.label}”`;
    case 'safety': return who ? `${who} · saved before a restore` : 'Saved before a restore';
    default: return who ? `${who} · auto-saved` : 'Auto-saved';
  }
}
