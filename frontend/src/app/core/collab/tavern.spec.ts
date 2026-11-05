import { describe, expect, it } from 'vitest';
import type { AssetInfo } from '../latex/figure';
import { buildTables, copyPath, filterTables, memberKind, stoolLayout, tableNameError, usedIn } from './tavern';

const a = (path: string, size = 100): AssetInfo => ({ path, size, mime: 'image/png', sha256: 'x' });

describe('buildTables', () => {
  const tables = buildTables(['main.tex', 'chapters/b.tex', 'chapters/a.tex', 'refs.bib'], [a('figures/orbit.png', 84_000)], ['appendix'], new Map([['main.tex', 4096]]), 'main.tex');

  it('puts the main hall first and the rest alphabetically, including empty tables', () => {
    expect(tables.map((t) => t.label)).toEqual(['main hall', 'appendix/', 'chapters/', 'figures/']);
    expect(tables.find((t) => t.path === 'appendix')!.members).toEqual([]);
  });
  it('seats the main file first and merges assets with sources', () => {
    expect(tables[0].members.map((m) => `${m.name}${m.main ? '*' : ''}`)).toEqual(['main.tex*', 'refs.bib']);
    expect(tables[0].members[0].size).toBe(4096);
    const fig = tables.find((t) => t.path === 'figures')!.members[0];
    expect(fig).toMatchObject({ kind: 'image', size: 84_000 });
    expect(fig.asset).not.toBeNull();
  });
  it('sorts members by name', () => expect(tables.find((t) => t.path === 'chapters')!.members.map((m) => m.name)).toEqual(['a.tex', 'b.tex']));
});

describe('stoolLayout', () => {
  it('starts at the top and spreads evenly on a 135px ring in a 360px cell', () => {
    const l = stoolLayout(4);
    expect(l.cell).toBe(360);
    expect(l.points).toEqual([{ x: 180, y: 45 }, { x: 315, y: 180 }, { x: 180, y: 315 }, { x: 45, y: 180 }]);
  });
  it('matches the design for five members (second stool at the right of the top)', () => {
    const p = stoolLayout(5).points[1];
    expect(p.x).toBeCloseTo(308.4, 0);
    expect(p.y).toBeCloseTo(138.3, 0);
  });
  it('grows the cell for crowded tables so stools never overlap', () => {
    const l = stoolLayout(30);
    expect(l.cell).toBeGreaterThan(360);
    const d = Math.hypot(l.points[0].x - l.points[1].x, l.points[0].y - l.points[1].y);
    expect(d).toBeGreaterThanOrEqual(68);
  });
  it('keeps a full table (ten stools) roomy: wider ring, bigger cell, names that fit', () => {
    const l = stoolLayout(10);
    expect(l.radius).toBeGreaterThan(135);
    expect(l.cell).toBeGreaterThan(360);
    expect(l.labelW).toBeLessThan(120);
    const d = Math.hypot(l.points[0].x - l.points[1].x, l.points[0].y - l.points[1].y);
    expect(d).toBeGreaterThanOrEqual(96);
    expect(stoolLayout(5).labelW).toBe(120);
  });
  it('handles empty and single tables', () => {
    expect(stoolLayout(0).points).toEqual([]);
    expect(stoolLayout(1).points).toEqual([{ x: 180, y: 45 }]);
  });
});

describe('filterTables', () => {
  const tables = buildTables(['main.tex', 'refs.bib', 'sty/p.sty'], [a('figures/orbit.png')], ['empty'], new Map(), 'main.tex');
  it('keeps everything, including empty tables, when unfiltered', () => expect(filterTables(tables, '', 'all')).toHaveLength(tables.length));
  it('filters by chip and hides tables without matches', () => {
    expect(filterTables(tables, '', 'images').map((t) => t.path)).toEqual(['figures']);
    expect(filterTables(tables, '', 'bibliography')[0].members[0].name).toBe('refs.bib');
    expect(filterTables(tables, '', 'sources').flatMap((t) => t.members.map((m) => m.name))).toEqual(['main.tex', 'p.sty']);
  });
  it('searches the whole path, case-insensitively', () => expect(filterTables(tables, 'ORBIT', 'all').flatMap((t) => t.members.map((m) => m.path))).toEqual(['figures/orbit.png']));
});

describe('usedIn', () => {
  const sources = new Map([
    ['main.tex', '\\documentclass{article}\n% \\includegraphics{figures/orbit.png}\n\\includegraphics[width=1cm]{figures/orbit}\n\\bibliography{refs}\n\\input{chapters/intro}'],
    ['chapters/intro.tex', 'see figures/orbit.png here'],
  ]);
  it('finds mentions with and without extension and ignores comments', () => {
    expect(usedIn(sources, 'figures/orbit.png')).toEqual([{ file: 'main.tex', line: 3 }, { file: 'chapters/intro.tex', line: 1 }]);
    expect(usedIn(sources, 'refs.bib')).toEqual([{ file: 'main.tex', line: 4 }]);
    expect(usedIn(sources, 'chapters/intro.tex')).toEqual([{ file: 'main.tex', line: 5 }]);
  });
  it('does not match longer names', () => expect(usedIn(new Map([['m.tex', '\\input{figures/orbit2}']]), 'figures/orbit.png')).toEqual([]));
});

describe('names', () => {
  it('validates table names', () => {
    expect(tableNameError('appendix', '', [])).toBeNull();
    expect(tableNameError('', '', [])).toMatch(/name/);
    expect(tableNameError('a b', '', [])).toMatch(/letters/);
    expect(tableNameError('figures', '', ['figures'])).toMatch(/already/);
    expect(tableNameError('x', 'figures', ['figures/x'])).toMatch(/already/);
  });
  it('names copies without clashing', () => {
    expect(copyPath('figures/orbit.png', [])).toBe('figures/orbit-copy.png');
    expect(copyPath('figures/orbit.png', ['figures/orbit-copy.png'])).toBe('figures/orbit-copy-2.png');
    expect(copyPath('main.tex', [])).toBe('main-copy.tex');
  });
  it('classifies kinds', () => expect(['a.tex', 'a.bib', 'a.sty', 'a.md', 'a.png', 'a.pdf', 'a.zip'].map(memberKind)).toEqual(['source', 'bib', 'style', 'note', 'image', 'pdf', 'other']));
});

import { defaultTable, placeFile } from './tavern';

describe('placeFile', () => {
  it('places into the table, tidies the name and avoids clashes', () => {
    expect(placeFile('chapters', 'My Chapter (v2).TEX', [])).toBe('chapters/My Chapter -v2.tex');
    expect(placeFile('', 'refs.bib', ['refs.bib', 'refs-2.bib'])).toBe('refs-3.bib');
    expect(placeFile('figures', 'C:\\x\\a.png', ['figures/a.png'])).toBe('figures/a-2.png');
  });
  it('picks default tables', () => expect(['a.png', 'a.pdf', 'a.tex', 'a.bib'].map(defaultTable)).toEqual(['figures', 'figures', '', '']));
});

import { HALL_RADIUS, pushAway, MAP_MARGIN, TABLE_GAP, layoutTables, pushClear, MapView, boundsOf, centerOn, clampView, fitView, intersects, placeTables, seatPlan, spiralCells, visibleRect, zoomAt } from './tavern';

describe('map geometry', () => {
  it('spirals out from the middle without repeating a cell', () => {
    const cells = spiralCells(20);
    expect(cells.slice(0, 6)).toEqual([{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 1, row: 1 }, { col: 0, row: 1 }, { col: -1, row: 1 }, { col: -1, row: 0 }]);
    expect(new Set(cells.map((c) => `${c.col},${c.row}`)).size).toBe(20);
    expect(spiralCells(0)).toEqual([]);
  });
  it('centres the first table on the origin and never overlaps', () => {
    const r = placeTables([360, 360, 500, 360]);
    expect(r[0]).toMatchObject({ x: -180, y: -180 });
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) expect(intersects(r[i], r[j])).toBe(false);
  });
  it('fits everything and keeps it centred, never magnifying past 1', () => {
    const b = boundsOf(placeTables([360, 360, 360, 360, 360]));
    const v = fitView(b, 1000, 700);
    expect(v.k).toBeLessThan(1);
    const vis = visibleRect(v, 1000, 700);
    expect(vis.x).toBeLessThanOrEqual(b.x);
    expect(vis.x + vis.w).toBeGreaterThanOrEqual(b.x + b.w);
    expect(fitView(boundsOf(placeTables([360])), 2000, 1400).k).toBe(1);
    expect(fitView({ x: 0, y: 0, w: 0, h: 0 }, 800, 600).k).toBe(1);
  });
  it('zooms around the cursor and clamps', () => {
    const v: MapView = { x: 100, y: 50, k: 1 };
    const z = zoomAt(v, 2, 300, 250);
    expect(z.k).toBe(2);
    expect((300 - z.x) / z.k).toBeCloseTo((300 - v.x) / v.k);
    expect((250 - z.y) / z.k).toBeCloseTo((250 - v.y) / v.k);
    expect(zoomAt(v, 100, 0, 0).k).toBe(2);
    expect(zoomAt(v, 0.001, 0, 0).k).toBe(0.2);
  });
  it('centres on a world point', () => {
    const v = centerOn({ x: 0, y: 0, k: 1 }, 500, 300, 800, 600, 0.5);
    expect(v.k).toBe(0.5);
    expect(500 * 0.5 + v.x).toBe(400);
    expect(300 * 0.5 + v.y).toBe(300);
  });
});

describe('seatPlan', () => {
  const many = buildTables(Array.from({ length: 25 }, (_, i) => `chapters/c${String(i).padStart(2, '0')}.tex`), [], [], new Map(), 'chapters/c07.tex')[0].members;
  it('seats everyone when the table is not crowded', () => expect(seatPlan(many.slice(0, 10), null, new Set())).toEqual({ seated: many.slice(0, 10), overflow: 0 }));
  it('caps the stools and sends the rest to the bench', () => {
    const plan = seatPlan(many, null, new Set());
    expect(plan.seated).toHaveLength(9);
    expect(plan.overflow).toBe(16);
  });
  it('keeps the main file, the selection and busy files on a stool, in table order', () => {
    const plan = seatPlan(many, 'chapters/c24.tex', new Set(['chapters/c20.tex']));
    const names = plan.seated.map((m) => m.name);
    expect(names).toContain('c07.tex');
    expect(names).toContain('c24.tex');
    expect(names).toContain('c20.tex');
    expect(names).toEqual([...names].sort((a, b) => (a === 'c07.tex' ? -1 : b === 'c07.tex' ? 1 : a.localeCompare(b))));
  });
});

describe('the hall has walls (clampView)', () => {
  const hall = { x: 0, y: 0, w: 1000, h: 600 };
  const centreOf = (v: MapView, vw: number, vh: number) => ({ x: (vw / 2 - v.x) / v.k, y: (vh / 2 - v.y) / v.k });

  it('leaves a view inside the hall alone', () => {
    const v = { x: 200, y: 100, k: 1 };
    expect(clampView(v, hall, 1000, 700)).toEqual(v);
  });

  it('stops panning past the margin on every side', () => {
    const far = clampView({ x: -50000, y: 50000, k: 1 }, hall, 1000, 700);
    const c = centreOf(far, 1000, 700);
    expect(c.x).toBeCloseTo(hall.w + MAP_MARGIN);
    expect(c.y).toBeCloseTo(-MAP_MARGIN);
    const other = centreOf(clampView({ x: 50000, y: -50000, k: 1 }, hall, 1000, 700), 1000, 700);
    expect(other.x).toBeCloseTo(-MAP_MARGIN);
    expect(other.y).toBeCloseTo(hall.h + MAP_MARGIN);
  });

  it('does not let you zoom out beyond the whole hall', () => {
    const v = clampView({ x: 0, y: 0, k: 0.2 }, hall, 1000, 700);
    expect(v.k).toBeGreaterThan(0.2);
    const world = { w: 1000 + 2 * MAP_MARGIN, h: 600 + 2 * MAP_MARGIN };
    expect(Math.min(1000 / world.w, 700 / world.h)).toBeLessThanOrEqual(v.k + 1e-9);
  });

  it('leaves an empty hall or an unmeasured screen alone', () => {
    const v = { x: 5, y: 5, k: 0.2 };
    expect(clampView(v, { x: 0, y: 0, w: 0, h: 0 }, 1000, 700)).toBe(v);
    expect(clampView(v, hall, 0, 0)).toBe(v);
  });
});

describe('tables that move and never overlap', () => {
  const overlaps = (rects: Array<{ x: number; y: number; w: number }>) => {
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const d = Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.w / 2 - (b.y + b.w / 2));
        if (d < a.w / 2 + b.w / 2 + TABLE_GAP - 1) return true;
      }
    }
    return false;
  };

  it('an untouched hall is laid out exactly as the spiral always did', () => {
    const cells = [300, 300, 380, 300, 300];
    expect(layoutTables(cells, ['', 'a', 'b', 'c', 'd'], {})).toEqual(placeTables(cells));
  });

  it('a moved table keeps the spot that was saved', () => {
    const cells = [300, 300];
    const rects = layoutTables(cells, ['', 'figures'], { figures: { x: 900, y: -400 } });
    expect(rects[1]).toEqual({ x: 750, y: -550, w: 300, h: 300 });
    expect(overlaps(rects)).toBe(false);
  });

  it('the others go around a moved table instead of landing on it', () => {
    const cells = [300, 300, 300, 300];
    // somebody parked "a" right where the spiral would put the next table
    const rects = layoutTables(cells, ['', 'a', 'b', 'c'], { a: { x: 340, y: 0 } });
    expect(overlaps(rects)).toBe(false);
    expect(rects[1].x + 150).toBe(340);
  });

  it('a saved spot that has become crowded is nudged clear, not left overlapping', () => {
    const rects = layoutTables([300, 300], ['', 'x'], { '': { x: 0, y: 0 }, x: { x: 10, y: 10 } });
    expect(overlaps(rects)).toBe(false);
  });

  it('pushClear slides a table to just touching distance, in the direction it came from', () => {
    const others = [{ spot: { x: 0, y: 0 }, cell: 300 }];
    const s = pushClear({ x: 100, y: 0 }, 300, others);
    expect(s.y).toBeCloseTo(0);
    expect(s.x).toBeCloseTo(300 + TABLE_GAP);
    expect(pushClear({ x: 0, y: 0 }, 300, others).x).toBeCloseTo(300 + TABLE_GAP); // exactly on top: steps aside
    expect(pushClear({ x: 900, y: 900 }, 300, others)).toEqual({ x: 900, y: 900 }); // already clear: untouched
  });

  it('pushClear resolves squeezed spots among several tables and keeps within the walls', () => {
    const others = [
      { spot: { x: -250, y: 0 }, cell: 300 },
      { spot: { x: 250, y: 0 }, cell: 300 },
    ];
    const s = pushClear({ x: 0, y: 0 }, 300, others);
    // there is no room between them: it ends up clear of both, somewhere close by
    for (const o of others) expect(Math.hypot(s.x - o.spot.x, s.y - o.spot.y)).toBeGreaterThanOrEqual(300 + TABLE_GAP - 1);
    expect(Math.hypot(s.x, s.y)).toBeLessThan(900);
    const far = pushClear({ x: 90000, y: -90000 }, 300, []);
    expect(Math.hypot(far.x, far.y)).toBeLessThanOrEqual(HALL_RADIUS + 1e-6);
  });
});

describe('tables push each other (pushAway)', () => {
  const t = (key: string, x: number, y: number, cell = 300) => ({ key, spot: { x, y }, cell });
  const gapOf = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) - 300;

  it('leaves everyone alone when nothing is touched', () => {
    const r = pushAway({ x: 2000, y: 0 }, 300, [t('a', 0, 0), t('b', 400, 0)]);
    expect(r.spot).toEqual({ x: 2000, y: 0 });
    expect(r.moved.size).toBe(0);
  });

  it('shoves a touched table away from the carried one, to just touching distance', () => {
    const r = pushAway({ x: 100, y: 0 }, 300, [t('a', 300, 0)]);
    expect(r.spot).toEqual({ x: 100, y: 0 }); // the carried table goes where the hand puts it
    expect(r.moved.get('a')!.x).toBeCloseTo(100 + 300 + TABLE_GAP);
    expect(r.moved.get('a')!.y).toBeCloseTo(0);
  });

  it('a shoved table shoves the next one in turn (a row of tables)', () => {
    const r = pushAway({ x: -100, y: 0 }, 300, [t('a', 200, 0), t('b', 524, 0), t('c', 848, 0)]); // a row, each just touching the next
    const pos = (k: string) => r.moved.get(k) ?? { x: { a: 200, b: 524, c: 848 }[k]!, y: 0 };
    expect(gapOf(r.spot, pos('a'))).toBeGreaterThanOrEqual(TABLE_GAP - 1);
    expect(gapOf(pos('a'), pos('b'))).toBeGreaterThanOrEqual(TABLE_GAP - 1);
    expect(gapOf(pos('b'), pos('c'))).toBeGreaterThanOrEqual(TABLE_GAP - 1);
    expect(r.moved.has('a') && r.moved.has('b') && r.moved.has('c')).toBe(true); // the shove travels down the whole row
  });

  it('nobody ends up overlapping even when the carried table is dropped in the middle of a cluster', () => {
    const others = [t('a', 0, 0), t('b', 340, 0), t('c', 0, 340), t('d', 340, 340)];
    const r = pushAway({ x: 170, y: 170 }, 300, others);
    const all = [{ key: '*', spot: r.spot }, ...others.map((o) => ({ key: o.key, spot: r.moved.get(o.key) ?? o.spot }))];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) expect(gapOf(all[i].spot, all[j].spot)).toBeGreaterThanOrEqual(TABLE_GAP - 2);
    }
  });

  it('pushed tables stay within the walls; the carried table gives way if they cannot move', () => {
    const edge = HALL_RADIUS - 10;
    const r = pushAway({ x: edge - 200, y: 0 }, 300, [t('a', edge, 0)]);
    for (const p of r.moved.values()) expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(HALL_RADIUS + 1e-6);
    const a = r.moved.get('a') ?? { x: edge, y: 0 };
    expect(gapOf(r.spot, a)).toBeGreaterThanOrEqual(TABLE_GAP - 2);
  });
});
