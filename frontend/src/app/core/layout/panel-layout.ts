/** The editor's workspace: which panels are shown, how big they are, and the CSS grid that arranges them. */

export type PanelId = 'tree' | 'source' | 'preview' | 'log';
export type Visibility = Record<PanelId, boolean>;

export interface LayoutSizes {
  /** Width of the Tavern Hall column (px). */
  treeW: number;
  /** Width of the right dock: preview, history or portrait (px). */
  previewW: number;
  /** Height of the ink log (px). */
  logH: number;
}

export interface PanelLayout {
  sizes: LayoutSizes;
  visible: Visibility;
}

export const DEFAULT_LAYOUT: PanelLayout = {
  sizes: { treeW: 236, previewW: 460, logH: 170 },
  visible: { tree: true, source: true, preview: true, log: false },
};

/** Smallest sizes. There is no largest size: a panel may grow until the others would fall below their own smallest (see `maxSize`). */
export const LIMITS = {
  treeW: [160, Infinity],
  previewW: [280, Infinity],
  logH: [84, Infinity],
} as const;

/** A hidden Tavern Hall folds into a narrow rail. */
export const RAIL_W = 44;
/** Thickness of a resize handle (the gap between two panels). */
export const HANDLE = 12;
/** Room the source editor and the top row always keep. */
export const MIN_EDITOR_W = 320;
export const MIN_TOP_H = 200;
/** A popped-out ink log leaves a slim note behind. */
export const LOG_NOTE_H = 64;

export interface Space {
  w: number;
  h: number;
}

const between = (v: number, [lo, hi]: readonly [number, number] | readonly number[]): number => Math.min(hi, Math.max(lo, Math.round(v)));

/** What is taken by everything that is not the panel in question (workspace padding, handles, the rail, the editor's own room). */
const SIDE_PADDING = 24;

/**
 * The most a panel may take: the workspace minus what the others need at their smallest.
 * Unknown workspace size (before the first layout): no limit beyond a sanity cap.
 */
export function maxSize(key: keyof LayoutSizes, space: Space | null, visible: Visibility): number {
  const cap = 20000;
  if (!space || space.w <= 0 || space.h <= 0) return cap;
  if (key === 'logH') return Math.max(LIMITS.logH[0], space.h - SIDE_PADDING - MIN_TOP_H - HANDLE);
  const treeTaken = visible.tree ? LIMITS.treeW[0] + HANDLE : RAIL_W;
  const rightTaken = visible.preview ? LIMITS.previewW[0] + HANDLE : 0;
  const rest = space.w - SIDE_PADDING - MIN_EDITOR_W - HANDLE; // what is left for the panel and what stands beside it
  if (key === 'treeW') return Math.max(LIMITS.treeW[0], rest - rightTaken);
  return Math.max(LIMITS.previewW[0], rest - treeTaken);
}

/**
 * Keep sizes at or above their minimum and, when the workspace size is known, leave the source editor its room.
 * `changed` is the size the scribe is dragging: it may grow until the others reach their minimum, and no further.
 */
export function clampSizes(sizes: LayoutSizes, space: Space | null, visible: Visibility, changed?: keyof LayoutSizes): LayoutSizes {
  const floor = (v: number, [lo]: readonly [number, number]): number => Math.max(lo, Math.round(Number.isFinite(v) ? v : lo));
  let treeW = floor(sizes.treeW, LIMITS.treeW);
  let previewW = floor(sizes.previewW, LIMITS.previewW);
  let logH = floor(sizes.logH, LIMITS.logH);
  if (changed === 'treeW') treeW = Math.min(treeW, maxSize('treeW', space, visible));
  if (changed === 'previewW') previewW = Math.min(previewW, maxSize('previewW', space, visible));
  if (space && space.w > 0) {
    // 24px of workspace padding, plus a handle for each column that is shown beside the editor
    const used = (): number => SIDE_PADDING + (visible.tree ? treeW + HANDLE : RAIL_W) + MIN_EDITOR_W + (visible.preview ? previewW + HANDLE : 0);
    if (used() - space.w > 0) {
      const shrinkPreview = () => (previewW = Math.max(LIMITS.previewW[0], previewW - Math.max(0, used() - space.w)));
      const shrinkTree = () => (treeW = Math.max(LIMITS.treeW[0], treeW - Math.max(0, used() - space.w)));
      if (changed === 'previewW') {
        shrinkTree();
        shrinkPreview();
      } else {
        shrinkPreview();
        shrinkTree();
      }
    }
  }
  if (space && space.h > 0) logH = Math.max(LIMITS.logH[0], Math.min(logH, maxSize('logH', space, visible)));
  return { treeW, previewW, logH };
}

/** What the browser's storage hands back is not to be trusted: take only well-formed layouts. */
export function parseLayout(raw: unknown): PanelLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { sizes?: Record<string, unknown>; visible?: Record<string, unknown> };
  const num = (v: unknown, lim: readonly [number, number]): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= lim[0] && v <= 20000 ? Math.round(v) : null);
  const treeW = num(r.sizes?.['treeW'], LIMITS.treeW);
  const previewW = num(r.sizes?.['previewW'], LIMITS.previewW);
  const logH = num(r.sizes?.['logH'], LIMITS.logH);
  const ids: PanelId[] = ['tree', 'source', 'preview', 'log'];
  if (treeW === null || previewW === null || logH === null || !ids.every((id) => typeof r.visible?.[id] === 'boolean')) return null;
  const visible = Object.fromEntries(ids.map((id) => [id, r.visible![id] as boolean])) as Visibility;
  return { sizes: { treeW, previewW, logH }, visible };
}

export interface GridInput {
  sizes: LayoutSizes;
  visible: Visibility;
  /** The right dock has something to show: the preview, or a history/portrait panel standing in for it. */
  rightDock: boolean;
  /** The ink log is open in its own window (it leaves a slim note). */
  logPopped: boolean;
}

export interface Grid {
  columns: string;
  rows: string;
  areas: string;
  /** Which resize handles exist. */
  handles: { tree: boolean; right: boolean; log: boolean };
  /** True when nothing but the rail remains: the workspace shows a hint instead. */
  empty: boolean;
}

/** The workspace's CSS grid. Exactly one column is flexible (the source editor, else the right dock, else a hint). */
export function gridFor({ sizes, visible, rightDock, logPopped }: GridInput): Grid {
  const cols: Array<{ area: string; size: string }> = [{ area: 'tree', size: visible.tree ? `${sizes.treeW}px` : `${RAIL_W}px` }];
  const hasSource = visible.source;
  const treeHandle = visible.tree && (hasSource || rightDock);
  if (treeHandle) cols.push({ area: 'ht', size: `${HANDLE}px` });
  if (hasSource) cols.push({ area: 'source', size: 'minmax(0, 1fr)' });
  const rightHandle = hasSource && rightDock;
  if (rightHandle) cols.push({ area: 'hp', size: `${HANDLE}px` });
  if (rightDock) cols.push({ area: 'preview', size: hasSource ? `${sizes.previewW}px` : 'minmax(0, 1fr)' });
  const empty = !hasSource && !rightDock;
  if (empty) cols.push({ area: 'empty', size: 'minmax(0, 1fr)' });

  const topAreas = cols.map((c) => c.area);
  const rows = [{ areas: topAreas, size: 'minmax(0, 1fr)' }];
  const logHandle = visible.log;
  if (logHandle) {
    rows.push({ areas: topAreas.map(() => (logPopped ? 'gap' : 'hl')), size: logPopped ? '0px' : `${HANDLE}px` });
    rows.push({ areas: topAreas.map(() => 'log'), size: logPopped ? `${LOG_NOTE_H}px` : `${sizes.logH}px` });
  }
  return {
    columns: cols.map((c) => c.size).join(' '),
    rows: rows.map((r) => r.size).join(' '),
    areas: rows.map((r) => `'${r.areas.join(' ')}'`).join(' '),
    handles: { tree: treeHandle, right: rightHandle, log: logHandle && !logPopped },
    empty,
  };
}

/** Next value for a keyboard step on a handle. */
export function stepSize(value: number, key: string, shift: boolean, lim: readonly [number, number]): number | null {
  const step = shift ? 64 : 16;
  if (key === 'Home') return lim[0];
  if (key === 'End') return lim[1];
  if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowUp') return value + step * (key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1);
  return null;
}
