import { DiffLine, countChanges, diffLines, splitLines } from './diff';
import type { EditProposal } from '../api/scrolls.service';

/** The most lines of a change shown at once in the review list (the rest is "… N more lines"). */
export const PREVIEW_LINES = 30;

export interface ProposalView {
  /** One line saying what it does: "Changes 2 places in main.tex". */
  title: string;
  lines: DiffLine[];
  /** Lines left out of `lines` for length. */
  hidden: number;
}

const pad = (text: string | null): string[] => splitLines(text ?? '');

/** What a person reviewing a proposal sees: a short title and the lines that go and come, as a diff. */
export function viewProposal(p: Pick<EditProposal, 'kind' | 'path' | 'oldText' | 'newText' | 'replaceAll' | 'content'>): ProposalView {
  let lines: DiffLine[];
  let title: string;
  if (p.kind === 'edit') {
    lines = diffLines(pad(p.oldText), pad(p.newText)); // (diffLines reads "current vs an older version", so the new text plays the older one: its lines are the additions)
    title = `${p.replaceAll ? 'Changes every match of a passage in' : 'Changes a passage in'} ${p.path}`;
  } else if (p.kind === 'write') {
    lines = pad(p.content).map((text, i) => ({ type: 'add' as const, text, old: i + 1 }));
    title = `Writes ${p.path} (the whole file)`;
  } else {
    lines = [];
    title = `Deletes ${p.path}`;
  }
  const hidden = Math.max(0, lines.length - PREVIEW_LINES);
  return { title, lines: lines.slice(0, PREVIEW_LINES), hidden };
}

// ---- the review: a proposal drawn like `git diff`, against the file as it is now

export interface ReviewHunk {
  /** "@@ -12,7 +12,8 @@": where it sits in the file now and in the file once accepted. */
  header: string;
  rows: ReviewRow[];
}

export interface ReviewRow {
  type: 'same' | 'add' | 'del';
  text: string;
  /** Line number in the file now (same, del). */
  now?: number;
  /** Line number once accepted (same, add). */
  next?: number;
}

export interface Review {
  path: string;
  /** What happens to the file: changed, created, rewritten (whole-file write over an existing file) or deleted. */
  action: 'edit' | 'create' | 'rewrite' | 'delete';
  title: string;
  add: number;
  del: number;
  hunks: ReviewHunk[];
  /** Why the change cannot be drawn exactly (the text moved on, or the file is not here): the plain snippet is shown instead. */
  stale: string | null;
  /** The snippet fallback, used when `stale` is set. */
  fallback: ProposalView | null;
}

const CONTEXT = 3;

/** The lines of a file as git counts them: a final line break ends the last line, it does not start another. */
const fileLines = (text: string): string[] => splitLines(text.endsWith('\n') ? text.slice(0, -1) : text);

/** Group a full line diff into git-style hunks with `CONTEXT` lines around every change. */
export function toHunks(lines: readonly DiffLine[], context = CONTEXT): ReviewHunk[] {
  const rows: ReviewRow[] = lines.map((l) => ({ type: l.type, text: l.text, now: l.type === 'add' ? undefined : l.now, next: l.type === 'del' ? undefined : l.old }));
  const changed = rows.map((r, i) => (r.type === 'same' ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return [];
  const spans: [number, number][] = [];
  for (const i of changed) {
    const from = Math.max(0, i - context);
    const to = Math.min(rows.length - 1, i + context);
    const last = spans[spans.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else spans.push([from, to]);
  }
  return spans.map(([from, to]) => {
    const part = rows.slice(from, to + 1);
    const nowRows = part.filter((r) => r.type !== 'add');
    const nextRows = part.filter((r) => r.type !== 'del');
    const start = (list: ReviewRow[], key: 'now' | 'next', before: number): number => (list.length ? (list[0][key] ?? 0) : before);
    // git writes an empty side as "N,0" where N is the line it follows
    const precedingNow = rows.slice(0, from).filter((r) => r.type !== 'add').length;
    const precedingNext = rows.slice(0, from).filter((r) => r.type !== 'del').length;
    const a = start(nowRows, 'now', precedingNow);
    const b = start(nextRows, 'next', precedingNext);
    return { header: `@@ -${a},${nowRows.length} +${b},${nextRows.length} @@`, rows: part };
  });
}

/** The text of a file after an edit, or why the edit no longer fits. */
export function applyEdit(current: string, oldText: string, newText: string, all: boolean): { text: string } | { error: string } {
  if (!oldText) return { error: 'The passage to replace is empty.' };
  const parts = current.split(oldText);
  const count = parts.length - 1;
  if (count === 0) return { error: 'The passage this edit replaces is no longer in the file, so it can no longer be applied.' };
  if (count > 1 && !all) return { error: `The passage now appears ${count} times, so the edit is ambiguous.` };
  return { text: parts.join(newText) };
}

/**
 * A proposal drawn the way `git diff` draws a change: the file as it is now against the file once accepted, with line
 * numbers, hunks and three lines of context. `current` is the file's text now (null if there is no such file).
 */
export function reviewProposal(p: Pick<EditProposal, 'kind' | 'path' | 'oldText' | 'newText' | 'replaceAll' | 'content'>, current: string | null): Review {
  const base = { path: p.path, stale: null as string | null, fallback: null as ProposalView | null };
  const finish = (action: Review['action'], title: string, before: string, after: string): Review => {
    const lines = diffLines(fileLines(before), fileLines(after));
    const { add, del } = countChanges(lines);
    return { ...base, action, title, add, del, hunks: toHunks(lines) };
  };
  const failed = (action: Review['action'], title: string, why: string): Review => ({ ...base, action, title, add: 0, del: 0, hunks: [], stale: why, fallback: viewProposal(p) });

  if (p.kind === 'edit') {
    const title = `Changes ${p.path}`;
    if (current === null) return failed('edit', title, `${p.path} is not in the scroll any more.`);
    const done = applyEdit(current, p.oldText ?? '', p.newText ?? '', p.replaceAll);
    return 'error' in done ? failed('edit', title, done.error) : finish('edit', title, current, done.text);
  }
  if (p.kind === 'write') {
    return current === null ? finish('create', `Creates ${p.path}`, '', p.content ?? '') : finish('rewrite', `Rewrites ${p.path}`, current, p.content ?? '');
  }
  return current === null ? failed('delete', `Deletes ${p.path}`, `${p.path} is not in the scroll any more.`) : finish('delete', `Deletes ${p.path}`, current, '');
}

// ---- the same hunks laid out side by side: the file now on the left, the file once accepted on the right

export interface SideCell {
  no: number;
  text: string;
}

export interface SideRow {
  /** Left: the file now. Missing where the change only adds. */
  left: (SideCell & { del: boolean }) | null;
  /** Right: once accepted. Missing where the change only removes. */
  right: (SideCell & { add: boolean }) | null;
}

/** Lay a hunk out in two columns: a run of removed lines sits across from the run of added lines that follows it. */
export function sideBySide(rows: readonly ReviewRow[]): SideRow[] {
  const out: SideRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.type === 'same') {
      out.push({ left: { no: r.now ?? 0, text: r.text, del: false }, right: { no: r.next ?? 0, text: r.text, add: false } });
      i++;
      continue;
    }
    const dels: ReviewRow[] = [];
    const adds: ReviewRow[] = [];
    while (i < rows.length && rows[i].type === 'del') dels.push(rows[i++]);
    while (i < rows.length && rows[i].type === 'add') adds.push(rows[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = dels[k];
      const a = adds[k];
      out.push({
        left: d ? { no: d.now ?? 0, text: d.text, del: true } : null,
        right: a ? { no: a.next ?? 0, text: a.text, add: true } : null,
      });
    }
  }
  return out;
}
