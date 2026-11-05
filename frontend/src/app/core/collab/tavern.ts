import { AssetInfo, extOf } from '../latex/figure';

/** Pure model of the Tavern Hall: files become *members* seated at *tables* (directories). */

export type MemberKind = 'source' | 'image' | 'pdf' | 'bib' | 'style' | 'note' | 'other';
export type HallFilter = 'all' | 'sources' | 'images' | 'bibliography';

export interface Member {
  path: string;
  name: string;
  /** Directory path ('' = the main hall, i.e. top level). */
  table: string;
  kind: MemberKind;
  ext: string;
  asset: AssetInfo | null;
  /** Bytes. */
  size: number;
  main: boolean;
}

export interface Table {
  path: string;
  /** What the plaque says: `figures/` or `main hall`. */
  label: string;
  members: Member[];
}

/** Data type of a member being dragged to another table: that is a move, never a new file. */
export const MEMBER_DRAG_TYPE = 'application/x-quill-member';

export const TEXT_EXTENSIONS = ['tex', 'bib', 'sty', 'cls', 'def', 'md', 'txt'] as const;
export const isTextName = (name: string): boolean => (TEXT_EXTENSIONS as readonly string[]).includes(extOf(name));

export function memberKind(path: string): MemberKind {
  const e = extOf(path);
  if (e === 'tex') return 'source';
  if (e === 'bib') return 'bib';
  if (['sty', 'cls', 'def'].includes(e)) return 'style';
  if (['md', 'txt'].includes(e)) return 'note';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'eps'].includes(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  return 'other';
}

export const tableOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const joinPath = (table: string, name: string): string => (table ? `${table}/${name}` : name);
export const tableLabel = (table: string): string => (table ? `${table}/` : 'main hall');

/** Group files, assets and empty tables into tables. The main hall comes first, the rest alphabetically. */
export function buildTables(files: readonly string[], assets: readonly AssetInfo[], extraTables: readonly string[], sizes: ReadonlyMap<string, number>, main: string): Table[] {
  const byTable = new Map<string, Member[]>();
  const seat = (m: Member) => {
    const list = byTable.get(m.table) ?? [];
    list.push(m);
    byTable.set(m.table, list);
  };
  for (const path of files) seat({ path, name: baseName(path), table: tableOf(path), kind: memberKind(path), ext: extOf(path), asset: null, size: sizes.get(path) ?? 0, main: path === main });
  for (const a of assets) seat({ path: a.path, name: baseName(a.path), table: tableOf(a.path), kind: memberKind(a.path), ext: extOf(a.path), asset: a, size: a.size, main: false });
  for (const t of extraTables) if (!byTable.has(t)) byTable.set(t, []);
  // every ancestor directory of a seated table exists too, so nesting stays visible
  return [...byTable.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([path, members]) => ({ path, label: tableLabel(path), members: members.sort((a, b) => (a.main ? -1 : b.main ? 1 : a.name.localeCompare(b.name))) }));
}

export interface StoolLayout {
  /** Side of the square cell the table, rug and stools live in. */
  cell: number;
  radius: number;
  /** Width available for each stool's name so neighbours never overlap. */
  labelW: number;
  /** Centre of each stool relative to the cell's top-left. */
  points: Array<{ x: number; y: number }>;
}

/**
 * Members sit evenly around the table starting at the top (as in the design: 135px ring in a 360px cell).
 * Crowded tables widen the ring so stools keep about 100px between them, and the cell grows with it.
 */
export function stoolLayout(n: number): StoolLayout {
  const radius = Math.max(135, (100 * n) / (2 * Math.PI));
  const cell = Math.max(360, Math.ceil((2 * (radius + 45)) / 4) * 4);
  const c = cell / 2;
  const spacing = n > 1 ? (2 * Math.PI * radius) / n : 120;
  const labelW = Math.max(56, Math.min(120, Math.floor(spacing) - 4));
  const points = Array.from({ length: n }, (_, i) => {
    const a = (-90 + (360 * i) / Math.max(n, 1)) * (Math.PI / 180);
    return { x: +(c + radius * Math.cos(a)).toFixed(2), y: +(c + radius * Math.sin(a)).toFixed(2) };
  });
  return { cell, radius, labelW, points };
}

const FILTER_KINDS: Record<Exclude<HallFilter, 'all'>, MemberKind[]> = {
  sources: ['source', 'style', 'note'],
  images: ['image', 'pdf'],
  bibliography: ['bib'],
};

/** Search + chip filter for the list view; tables with no match disappear (empty tables only show unfiltered). */
export function filterTables(tables: readonly Table[], query: string, filter: HallFilter): Table[] {
  const q = query.trim().toLowerCase();
  const active = q !== '' || filter !== 'all';
  return tables
    .map((t) => ({ ...t, members: t.members.filter((m) => (filter === 'all' || FILTER_KINDS[filter].includes(m.kind)) && (!q || m.path.toLowerCase().includes(q))) }))
    .filter((t) => !active || t.members.length > 0);
}

export interface Usage {
  file: string;
  line: number;
}

/** Where a member is mentioned in the sources (`\includegraphics{figures/orbit}`, `\input{…}`, `\bibliography{…}`). */
export function usedIn(sources: ReadonlyMap<string, string>, target: string, limit = 3): Usage[] {
  const noExt = target.replace(/\.[^./]+$/, '');
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[{,\\s])(${esc(target)}|${esc(noExt)})(?=[},\\s]|$)`);
  const out: Usage[] = [];
  for (const [file, text] of sources) {
    if (file === target) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && out.length < limit; i++) {
      const code = lines[i].replace(/(^|[^\\])%.*$/, '$1');
      if (re.test(code)) out.push({ file, line: i + 1 });
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** Message or null. Table names are one folder level of letters, numbers, dashes and underscores. */
export function tableNameError(name: string, parent: string, existing: readonly string[]): string | null {
  const n = name.trim();
  if (!n) return 'Give the table a name.';
  if (n.length > 40) return 'Keep the name under 40 characters.';
  if (!/^[\w-]+$/.test(n)) return 'Use letters, numbers, dashes and underscores only.';
  if (existing.includes(joinPath(parent, n))) return `A table called “${joinPath(parent, n)}/” already exists.`;
  return null;
}

/** Name for a copy: `a.png` -> `a-copy.png` -> `a-copy-2.png`. */
export function copyPath(path: string, taken: readonly string[]): string {
  const dir = tableOf(path);
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const used = new Set(taken);
  let candidate = joinPath(dir, `${stem}-copy${ext}`);
  for (let i = 2; used.has(candidate); i++) candidate = joinPath(dir, `${stem}-copy-${i}${ext}`);
  return candidate;
}

/** Where a dropped or uploaded file lands: `<table>/<tidy name>`, numbered if the name is taken. */
export function placeFile(table: string, fileName: string, taken: readonly string[]): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^\w\- ]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file';
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const used = new Set(taken);
  const name = (n: number) => `${stem}${n > 1 ? `-${n}` : ''}${ext ? '.' + ext : ''}`;
  let n = 1;
  while (used.has(joinPath(table, name(n)))) n++;
  return joinPath(table, name(n));
}

/** Tables new files go to when nobody picked one: pictures and PDFs to `figures`, text to the main hall. */
export const defaultTable = (fileName: string): string => (['image', 'pdf'].includes(memberKind(fileName)) ? 'figures' : '');

// ---- the map: tables laid out in the world, a pannable and zoomable viewport over it

/** `screen = world * k + (x, y)`. */
export interface MapView {
  x: number;
  y: number;
  k: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;
export const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** Grid cells in a square spiral from the middle: (0,0), (1,0), (1,1), (0,1), (-1,1), … */
export function spiralCells(n: number): Array<{ col: number; row: number }> {
  const out: Array<{ col: number; row: number }> = n > 0 ? [{ col: 0, row: 0 }] : [];
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let col = 0;
  let row = 0;
  let dir = 0;
  let len = 1;
  while (out.length < n) {
    for (let rep = 0; rep < 2 && out.length < n; rep++) {
      for (let i = 0; i < len && out.length < n; i++) {
        col += dirs[dir][0];
        row += dirs[dir][1];
        out.push({ col, row });
      }
      dir = (dir + 1) % 4;
    }
    len++;
  }
  return out;
}

/** Top-left of every table's cell: the first (the main hall) in the middle, the rest spiralling out. */
export function placeTables(cells: readonly number[], gap = 40): Rect[] {
  const pitch = Math.max(0, ...cells) + gap;
  return spiralCells(cells.length).map(({ col, row }, i) => ({ x: col * pitch - cells[i] / 2, y: row * pitch - cells[i] / 2, w: cells[i], h: cells[i] }));
}

/** Clear space kept between two tables, in world units. */
export const TABLE_GAP = 24;
/** The spacing of the original spiral layout, kept so an untouched hall looks as it always did. */
const SPIRAL_GAP = 40;
/** Tables may not be carried further than this from the middle of the hall. */
export const HALL_RADIUS = 2600;

export interface Spot {
  /** Centre of the table. */
  x: number;
  y: number;
}

/** Do two round tables (centre + radius) get closer than `gap`? */
const crowd = (a: Spot, ra: number, b: Spot, rb: number, gap: number): boolean => Math.hypot(a.x - b.x, a.y - b.y) < ra + rb + gap - 0.5;

/**
 * Move a table out of everyone's way: if it overlaps another round table it is pushed straight away
 * from it until the two just have `gap` between them (so a dragged table slides around the others).
 * `others` are the tables that stay put; the result is also kept inside the hall's walls.
 */
export function pushClear(at: Spot, cell: number, others: ReadonlyArray<{ spot: Spot; cell: number }>, gap = TABLE_GAP): Spot {
  let { x, y } = at;
  for (let pass = 0; pass < 24; pass++) {
    let moved = false;
    for (const o of others) {
      const dx = x - o.spot.x;
      const dy = y - o.spot.y;
      const want = cell / 2 + o.cell / 2 + gap;
      const d = Math.hypot(dx, dy);
      if (d >= want - 0.5) continue;
      // exactly on top of each other: step off to the right
      const ux = d < 1e-6 ? 1 : dx / d;
      const uy = d < 1e-6 ? 0 : dy / d;
      x = o.spot.x + ux * want;
      y = o.spot.y + uy * want;
      moved = true;
    }
    const r = Math.hypot(x, y);
    if (r > HALL_RADIUS) {
      x = (x / r) * HALL_RADIUS;
      y = (y / r) * HALL_RADIUS;
      moved = true;
    }
    if (!moved) break;
  }
  const clear = (p: Spot) => !others.some((o) => crowd(p, cell / 2, o.spot, o.cell / 2, gap)) && Math.hypot(p.x, p.y) <= HALL_RADIUS + 0.5;
  if (clear({ x, y })) return { x, y };
  // squeezed between tables with no room to slide: take the nearest free spot around where it was dropped
  for (let ring = 1; ring <= 80; ring++) {
    const r = ring * 40;
    for (let a = 0; a < 24; a++) {
      const p = { x: at.x + Math.cos((a / 24) * 2 * Math.PI) * r, y: at.y + Math.sin((a / 24) * 2 * Math.PI) * r };
      if (clear(p)) return p;
    }
  }
  return { x, y };
}

/**
 * The carried table goes where the hand puts it and shoves any table it touches away along the line between
 * their middles; a shoved table shoves its own neighbours in turn. Returns the carried table's place (kept
 * within the walls) and the new places of every table that had to move.
 */
export function pushAway(carried: Spot, cell: number, others: ReadonlyArray<{ key: string; spot: Spot; cell: number }>, gap = TABLE_GAP): { spot: Spot; moved: Map<string, Spot> } {
  const wall = (p: Spot): Spot => {
    const r = Math.hypot(p.x, p.y);
    return r > HALL_RADIUS ? { x: (p.x / r) * HALL_RADIUS, y: (p.y / r) * HALL_RADIUS } : p;
  };
  const at = wall(carried);
  const spots = new Map(others.map((o) => [o.key, { ...o.spot }]));
  const cells = new Map(others.map((o) => [o.key, o.cell]));
  const queue: Array<{ spot: Spot; cell: number }> = [{ spot: at, cell }];
  let guard = 0;
  while (queue.length && guard++ < 400) {
    const pusher = queue.shift()!;
    for (const [key, sp] of spots) {
      if (sp === pusher.spot) continue; // a table does not push itself
      const oc = cells.get(key)!;
      const want = pusher.cell / 2 + oc / 2 + gap;
      const dx = sp.x - pusher.spot.x;
      const dy = sp.y - pusher.spot.y;
      const d = Math.hypot(dx, dy);
      if (d >= want - 0.5) continue;
      const ux = d < 1e-6 ? 1 : dx / d;
      const uy = d < 1e-6 ? 0 : dy / d;
      const next = wall({ x: pusher.spot.x + ux * want, y: pusher.spot.y + uy * want });
      sp.x = next.x;
      sp.y = next.y;
      queue.push({ spot: sp, cell: oc });
    }
  }
  const moved = new Map<string, Spot>();
  for (const o of others) {
    const now = spots.get(o.key)!;
    if (Math.abs(now.x - o.spot.x) > 0.01 || Math.abs(now.y - o.spot.y) > 0.01) moved.set(o.key, now);
  }
  // against the walls a pushed table may have nowhere to go: then the carried one gives way instead
  const settled = others.map((o) => ({ spot: spots.get(o.key)!, cell: o.cell }));
  return { spot: pushClear(at, cell, settled, gap), moved };
}

/**
 * Where every table stands. Tables the scribes have moved keep their saved centre; the rest take the
 * first free spot of the old spiral (so a hall nobody has rearranged looks exactly as before). Nobody
 * overlaps: a saved spot that has become crowded (a table grew) is nudged clear.
 */
export function layoutTables(cells: readonly number[], paths: readonly string[], saved: Readonly<Record<string, Spot>>, gap = TABLE_GAP): Rect[] {
  const placed: Array<{ spot: Spot; cell: number }> = [];
  const out: Rect[] = new Array(cells.length);
  const put = (i: number, spot: Spot) => {
    placed.push({ spot, cell: cells[i] });
    out[i] = { x: spot.x - cells[i] / 2, y: spot.y - cells[i] / 2, w: cells[i], h: cells[i] };
  };
  // moved tables first: they hold their ground
  const loose: number[] = [];
  cells.forEach((_, i) => {
    const s = saved[paths[i]];
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) put(i, pushClear(s, cells[i], placed, gap));
    else loose.push(i);
  });
  // the rest go to the first spiral spot with room
  const pitch = Math.max(0, ...cells) + SPIRAL_GAP;
  let cursor = 0;
  const spiral = spiralCells(cells.length + placed.length + 1);
  for (const i of loose) {
    for (;;) {
      const cell = spiral[cursor++] ?? { col: cursor, row: 0 };
      const spot = { x: cell.col * pitch, y: cell.row * pitch };
      if (!placed.some((o) => crowd(spot, cells[i] / 2, o.spot, o.cell / 2, gap))) {
        put(i, spot);
        break;
      }
    }
  }
  return out;
}

export function boundsOf(rects: readonly Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Zoom and pan so `b` fills the viewport (never magnified past `maxK`). */
export function fitView(b: Rect, vw: number, vh: number, pad = 48, maxK = 1): MapView {
  if (b.w <= 0 || b.h <= 0) return { x: vw / 2, y: vh / 2, k: 1 };
  const k = Math.min(maxK, clampZoom(Math.min((vw - 2 * pad) / b.w, (vh - 2 * pad) / b.h)));
  return { k, x: vw / 2 - (b.x + b.w / 2) * k, y: vh / 2 - (b.y + b.h / 2) * k };
}

/** Zoom by `factor`, keeping the world point under the screen point (px, py) where it is. */
export function zoomAt(v: MapView, factor: number, px: number, py: number): MapView {
  const k = clampZoom(v.k * factor);
  const wx = (px - v.x) / v.k;
  const wy = (py - v.y) / v.k;
  return { k, x: px - wx * k, y: py - wy * k };
}

/** How far past the outermost tables the view may wander, in world units: the hall has walls. */
export const MAP_MARGIN = 360;

/**
 * Keep the view inside the hall: the middle of the screen may not leave the tables' area (grown by
 * MAP_MARGIN), and you cannot zoom out further than shows all of it. An empty hall is left alone.
 */
export function clampView(v: MapView, b: Rect, vw: number, vh: number, margin = MAP_MARGIN): MapView {
  if (b.w <= 0 || b.h <= 0 || vw <= 0 || vh <= 0) return v;
  const aw = b.w + 2 * margin;
  const ah = b.h + 2 * margin;
  const kMin = Math.min(0.6, Math.max(MIN_ZOOM, Math.min(vw / aw, vh / ah)));
  const k = Math.max(kMin, v.k);
  const cx = Math.min(b.x + b.w + margin, Math.max(b.x - margin, (vw / 2 - v.x) / v.k));
  const cy = Math.min(b.y + b.h + margin, Math.max(b.y - margin, (vh / 2 - v.y) / v.k));
  return { k, x: vw / 2 - cx * k, y: vh / 2 - cy * k };
}

export function centerOn(v: MapView, wx: number, wy: number, vw: number, vh: number, k = v.k): MapView {
  return { k, x: vw / 2 - wx * k, y: vh / 2 - wy * k };
}

/** The part of the world on screen, grown by `margin` world units. */
export function visibleRect(v: MapView, vw: number, vh: number, margin = 0): Rect {
  return { x: -v.x / v.k - margin, y: -v.y / v.k - margin, w: vw / v.k + 2 * margin, h: vh / v.k + 2 * margin };
}

export const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export interface SeatPlan {
  seated: Member[];
  /** Members without a stool; they wait on the bench ("+N"). */
  overflow: number;
}

/**
 * A table seats at most `max` stools. When there are more members, the last stool is the bench and the
 * rest go to the main file, the selected member, anyone a scribe is working in, then alphabetical order.
 */
export function seatPlan(members: readonly Member[], selected: string | null, hot: ReadonlySet<string>, max = 10): SeatPlan {
  if (members.length <= max) return { seated: [...members], overflow: 0 };
  const slots = max - 1;
  const ranked = members.map((m, i) => ({ m, i, p: m.main ? 0 : m.path === selected ? 1 : hot.has(m.path) ? 2 : 3 })).sort((a, b) => a.p - b.p || a.i - b.i);
  const seated = ranked.slice(0, slots).sort((a, b) => a.i - b.i).map((r) => r.m);
  return { seated, overflow: members.length - slots };
}
