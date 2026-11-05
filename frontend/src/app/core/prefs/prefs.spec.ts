import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, isQuiet, parsePrefs } from './prefs';

describe('parsePrefs', () => {
  it('gives the defaults for nothing, junk and non-objects', () => {
    for (const raw of [undefined, null, 'x', 5, [], {}]) expect(parsePrefs(raw)).toEqual(DEFAULT_PREFS);
  });
  it('keeps good values and clamps numbers', () => {
    const p = parsePrefs({ fontSize: 99, lineHeight: 3, fontFamily: 'system', wrapLines: false, quietHours: 'nights', autoCompile: true });
    expect(p).toMatchObject({ fontSize: 28, lineHeight: 14, fontFamily: 'system', wrapLines: false, quietHours: 'nights', autoCompile: true });
  });
  it('replaces each bad value with its own default and ignores unknown fields', () => {
    const p = parsePrefs({ fontSize: '16', lineHeight: NaN, fontFamily: 'comic', quietHours: 'always', bell: 'yes', lineNumbers: 0, evil: '<script>', fontSize2: 1 });
    expect(p.fontSize).toBe(DEFAULT_PREFS.fontSize);
    expect(p.lineHeight).toBe(DEFAULT_PREFS.lineHeight);
    expect(p.fontFamily).toBe('jetbrains');
    expect(p.quietHours).toBe('off');
    expect(p.bell).toBe(false);
    expect(p.lineNumbers).toBe(true);
    expect(Object.keys(p)).toEqual(Object.keys(DEFAULT_PREFS));
  });
  it('rounds fractional sizes', () => expect(parsePrefs({ fontSize: 15.6 }).fontSize).toBe(16));
});

describe('isQuiet', () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 5, h, m);
  it('is never quiet when off', () => expect([0, 12, 23].map((h) => isQuiet('off', at(h)))).toEqual([false, false, false]));
  it('covers the evening window across midnight', () => {
    expect([19, 20, 23, 3, 7, 8, 12].map((h) => isQuiet('evenings', at(h)))).toEqual([false, true, true, true, true, false, false]);
  });
  it('covers the night window', () => {
    expect([21, 22, 2, 6, 7, 7.5].map((h) => isQuiet('nights', at(Math.floor(h), h % 1 ? 30 : 0)))).toEqual([false, true, true, true, false, false]);
  });

  it('keeps a known theme and falls back to the tavern for anything else', () => {
    expect(parsePrefs({ theme: 'royal' }).theme).toBe('royal');
    expect(parsePrefs({ theme: 'caves' }).theme).toBe('caves');
    for (const bad of ['neon', 3, null, undefined]) expect(parsePrefs({ theme: bad }).theme).toBe('tavern');
  });
});
