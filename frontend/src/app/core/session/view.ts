export interface Seg {
  text: string;
  /** Part of the text that was just typed (drawn lit up). */
  mark: boolean;
}
export interface ShownLine {
  n: number;
  segs: Seg[];
}
export interface Window {
  lines: ShownLine[];
  totalLines: number;
}

/**
 * A screenful of a file for the timelapse: `size` lines around the position being edited (so a long file stays
 * cheap to draw), with the text just typed marked. Lines are numbered from 1.
 */
export function windowLines(text: string, focus: number, mark: { from: number; to: number } | null, size = 34): Window {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const total = starts.length;
  const at = Math.min(Math.max(0, focus), text.length);
  let lo = 0;
  let hi = total - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  let first = Math.max(0, lo - Math.floor(size * 0.6));
  const end = Math.min(total, first + size);
  first = Math.max(0, end - size);
  const lines: ShownLine[] = [];
  for (let i = first; i < end; i++) {
    const from = starts[i];
    const to = i + 1 < total ? starts[i + 1] - 1 : text.length;
    const line = text.slice(from, to);
    const a = mark ? Math.max(from, mark.from) - from : -1;
    const b = mark ? Math.min(to, mark.to) - from : -1;
    const segs: Seg[] = mark && b > a && a >= 0 ? [{ text: line.slice(0, a), mark: false }, { text: line.slice(a, b), mark: true }, { text: line.slice(b), mark: false }].filter((s) => s.text) : [{ text: line, mark: false }];
    lines.push({ n: i + 1, segs: segs.length ? segs : [{ text: '', mark: false }] });
  }
  return { lines, totalLines: total };
}
