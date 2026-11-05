import { DiffLine, diffLines, splitLines } from './diff';
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
