import { describe, expect, it } from 'vitest';
import { PALETTE_FILTERS, shortcutLabel, EMPTY_QUERY_FILES, MAX_PER_SECTION, PaletteItem, PaletteSection, filterPalette, matchScore } from './palette';

const item = (title: string, section: PaletteSection = 'Actions', hint = ''): PaletteItem => ({ id: title, section, icon: '·', title, hint, run: () => {} });

describe('matchScore', () => {
  it('ranks exact, start, word start, inside and scattered matches in that order', () => {
    const s = (t: string) => matchScore(t, 'hall');
    expect(s('Hall')).toBeGreaterThan(s('Hall list'));
    expect(s('Hall list')).toBeGreaterThan(s('Tavern Hall'));
    expect(s('Tavern Hall')).toBeGreaterThan(s('Marshall'));
    expect(s('Marshall')).toBeGreaterThan(s('Hot air lull'));
    expect(matchScore('Compile', 'zzz')).toBe(0);
  });

  it('finds letters in order', () => {
    expect(matchScore('Tavern Hall', 'tvhl')).toBeGreaterThan(0);
    expect(matchScore('Tavern Hall', 'lht')).toBe(0);
  });
});

describe('filterPalette', () => {
  const items = [
    item('Compile'),
    item('Open the Tavern Hall', 'Actions', 'Browse every table and member'),
    item('Toggle Tavern Hall panel'),
    item('chapters/methods.tex', 'Files', 'Hall · tex'),
    item('figures/orbit.png', 'Files', 'Hall · image'),
    item('How do I add a new table?', 'Help'),
  ];

  it('shows everything, grouped Actions, Files, Help, when nothing is typed', () => {
    expect(filterPalette(items, '').map((i) => i.section)).toEqual(['Actions', 'Actions', 'Actions', 'Files', 'Files', 'Help']);
    expect(filterPalette(items, '   ')).toHaveLength(items.length);
  });

  it('keeps only a few files when nothing is typed', () => {
    const many = Array.from({ length: 30 }, (_, i) => item(`f${i}.tex`, 'Files'));
    expect(filterPalette(many, '')).toHaveLength(EMPTY_QUERY_FILES);
    expect(filterPalette(many, 'tex').length).toBeLessThanOrEqual(MAX_PER_SECTION);
  });

  it('every word must match, in the title or the hint', () => {
    expect(filterPalette(items, 'tavern panel').map((i) => i.title)).toEqual(['Toggle Tavern Hall panel']);
    expect(filterPalette(items, 'browse').map((i) => i.title)).toEqual(['Open the Tavern Hall']); // from the hint
    expect(filterPalette(items, 'nothing like this')).toEqual([]);
  });

  it('puts the better title match first and finds across sections', () => {
    const r = filterPalette(items, 'hall');
    expect(r.map((i) => i.title).slice(0, 2)).toEqual(['Open the Tavern Hall', 'Toggle Tavern Hall panel']);
    expect(r.some((i) => i.section === 'Files')).toBe(true); // "Hall · tex" in the hint
    expect(filterPalette(items, 'orbit').map((i) => i.title)).toEqual(['figures/orbit.png']);
  });
});

describe('shortcutLabel', () => {
  it('keeps the Mac symbols on a Mac and spells them out elsewhere', () => {
    expect(shortcutLabel('⌘⇧B', true)).toBe('⌘⇧B');
    expect(shortcutLabel('⌘⇧B', false)).toBe('Ctrl+Shift+B');
    expect(shortcutLabel('⌘⌥1', false)).toBe('Ctrl+Alt+1');
    expect(shortcutLabel('⌘↵', false)).toBe('Ctrl+Enter');
  });
});

describe('narrowing to one kind', () => {
  const many = [
    item('Compile'),
    item('Share'),
    ...Array.from({ length: 12 }, (_, i) => item(`chapter${i}.tex`, 'Files')),
    item('How do I share?', 'Help'),
  ];

  it('shows only that kind, and all of it when nothing is typed', () => {
    expect(filterPalette(many, '', 'Actions').map((i) => i.title)).toEqual(['Compile', 'Share']);
    expect(filterPalette(many, '', 'Files')).toHaveLength(12); // not just the few shown among everything
    expect(filterPalette(many, '', 'Help')).toHaveLength(1);
  });

  it('searches inside the kind only', () => {
    expect(filterPalette(many, 'share').map((i) => i.title)).toEqual(['Share', 'How do I share?']);
    expect(filterPalette(many, 'share', 'Help').map((i) => i.title)).toEqual(['How do I share?']);
    expect(filterPalette(many, 'chapter', 'Files')).toHaveLength(12); // the per-section cap does not apply either
  });

  it('has ⌘1 for all and one key for each kind', () => {
    expect(PALETTE_FILTERS.map((f) => f.key)).toEqual(['1', '2', '3', '4']);
    expect(PALETTE_FILTERS.map((f) => f.only)).toEqual([null, 'Actions', 'Files', 'Help']);
  });
});
