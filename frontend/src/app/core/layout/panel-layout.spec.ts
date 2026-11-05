import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, HANDLE, LIMITS, MIN_EDITOR_W, RAIL_W, clampSizes, gridFor, parseLayout, stepSize } from './panel-layout';

const all = DEFAULT_LAYOUT.visible;
const grid = (over: Partial<Parameters<typeof gridFor>[0]> = {}) => gridFor({ sizes: DEFAULT_LAYOUT.sizes, visible: all, rightDock: true, logPopped: false, ...over });

describe('gridFor', () => {
  it('lays out the default workspace like the design: tree | editor | preview over the ink log, with handles between', () => {
    const g = grid();
    expect(g.columns).toBe('236px 12px minmax(0, 1fr) 12px 460px');
    expect(g.rows).toBe('minmax(0, 1fr) 12px 170px');
    expect(g.areas).toBe("'tree ht source hp preview' 'hl hl hl hl hl' 'log log log log log'");
    expect(g.handles).toEqual({ tree: true, right: true, log: true });
    expect(g.empty).toBe(false);
  });

  it('folds a hidden Tavern Hall into a rail and drops its handle', () => {
    const g = grid({ visible: { ...all, tree: false } });
    expect(g.columns).toBe(`${RAIL_W}px minmax(0, 1fr) 12px 460px`);
    expect(g.areas.split(' ')[0]).toBe("'tree");
    expect(g.handles.tree).toBe(false);
  });

  it('gives the flexible column to the right dock when the source editor is hidden', () => {
    const g = grid({ visible: { ...all, source: false } });
    expect(g.columns).toBe('236px 12px minmax(0, 1fr)');
    expect(g.handles.right).toBe(false);
  });

  it('drops the dock when there is nothing to show in it and keeps one flexible column', () => {
    const g = grid({ rightDock: false });
    expect(g.columns).toBe('236px 12px minmax(0, 1fr)');
    expect(g.columns.match(/minmax/g)).toHaveLength(1);
  });

  it('shows a hint column when only the rail or tree is left', () => {
    const g = grid({ visible: { tree: false, source: false, preview: false, log: false }, rightDock: false });
    expect(g.empty).toBe(true);
    expect(g.columns).toBe(`${RAIL_W}px minmax(0, 1fr)`);
    expect(g.rows).toBe('minmax(0, 1fr)');
  });

  it('removes the log row when the ink log is hidden, and shrinks it to a note when popped out', () => {
    expect(grid({ visible: { ...all, log: false } }).areas).toBe("'tree ht source hp preview'");
    const popped = grid({ logPopped: true });
    expect(popped.rows).toBe('minmax(0, 1fr) 0px 64px');
    expect(popped.handles.log).toBe(false);
  });

  it('every area name used in a row has a column, and every column is used', () => {
    for (const visible of [all, { ...all, tree: false }, { ...all, source: false }, { ...all, log: false }]) {
      for (const rightDock of [true, false]) {
        const g = grid({ visible, rightDock });
        const rows = g.areas.match(/'[^']+'/g)!.map((r) => r.replace(/'/g, '').split(' '));
        expect(new Set(rows.map((r) => r.length)).size).toBe(1);
        expect(rows[0].length).toBe(g.columns.split(/ (?![^(]*\))/).length);
      }
    }
  });
});

describe('clampSizes', () => {
  it('keeps every size within its limits', () => {
    const s = clampSizes({ treeW: 10, previewW: 5000, logH: 2 }, null, all);
    expect(s).toEqual({ treeW: LIMITS.treeW[0], previewW: LIMITS.previewW[1], logH: LIMITS.logH[0] });
  });
  it('leaves the editor its room by shrinking the other column first', () => {
    const space = { w: 1000, h: 800 };
    const fromPreview = clampSizes({ treeW: 300, previewW: 700, logH: 170 }, space, all, 'previewW');
    expect(fromPreview.previewW).toBeLessThan(700);
    expect(24 + fromPreview.treeW + HANDLE + MIN_EDITOR_W + fromPreview.previewW + HANDLE).toBeLessThanOrEqual(1000);
    const fromTree = clampSizes({ treeW: 480, previewW: 460, logH: 170 }, space, all, 'treeW');
    expect(fromTree.treeW).toBeLessThanOrEqual(480);
    expect(fromTree.treeW + fromTree.previewW).toBeLessThan(480 + 460);
  });
  it('does not let the ink log eat the top row', () => {
    expect(clampSizes({ treeW: 236, previewW: 460, logH: 600 }, { w: 1400, h: 600 }, all).logH).toBe(600 - 24 - 200 - 12);
  });
  it('rounds to whole pixels', () => expect(clampSizes({ treeW: 200.6, previewW: 400.4, logH: 100.5 }, null, all)).toEqual({ treeW: 201, previewW: 400, logH: 101 }));
});

describe('parseLayout', () => {
  const good = { sizes: { treeW: 300, previewW: 500, logH: 200 }, visible: { tree: true, source: true, preview: false, log: true } };
  it('accepts a well-formed layout', () => expect(parseLayout(good)).toEqual(good));
  it.each([
    ['null', null], ['a string', 'x'], ['no sizes', { visible: good.visible }],
    ['a size out of range', { ...good, sizes: { ...good.sizes, treeW: 5 } }],
    ['NaN', { ...good, sizes: { ...good.sizes, logH: NaN } }],
    ['a string size', { ...good, sizes: { ...good.sizes, previewW: '500' } }],
    ['a missing flag', { ...good, visible: { tree: true, source: true, preview: true } }],
    ['a non-boolean flag', { ...good, visible: { ...good.visible, log: 1 } }],
  ])('rejects %s', (_, raw) => expect(parseLayout(raw)).toBeNull());
  it('ignores extra fields', () => expect(parseLayout({ ...good, evil: '<script>' })).toEqual(good));
});

describe('stepSize', () => {
  it('steps by 16 (64 with shift) and jumps to the ends', () => {
    expect(stepSize(300, 'ArrowRight', false, LIMITS.treeW)).toBe(316);
    expect(stepSize(300, 'ArrowLeft', true, LIMITS.treeW)).toBe(236);
    expect(stepSize(300, 'Home', false, LIMITS.treeW)).toBe(160);
    expect(stepSize(300, 'End', false, LIMITS.treeW)).toBe(480);
    expect(stepSize(300, 'a', false, LIMITS.treeW)).toBeNull();
  });
});
