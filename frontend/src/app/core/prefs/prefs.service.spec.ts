import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS } from './prefs';
import { PreferencesService } from './prefs.service';

describe('PreferencesService', () => {
  let store: Map<string, string>;
  let failing = false;
  const fresh = () => {
    TestBed.resetTestingModule();
    return TestBed.inject(PreferencesService);
  };
  beforeEach(() => {
    store = new Map();
    failing = false;
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (failing) throw new Error('blocked');
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts with the defaults', () => expect(fresh().prefs()).toEqual(DEFAULT_PREFS));

  it('applies a change at once and keeps it for next time', () => {
    const p = fresh();
    p.update({ fontSize: 18, wrapLines: false });
    expect(p.prefs()).toMatchObject({ fontSize: 18, wrapLines: false, lineNumbers: true });
    expect(fresh().prefs()).toMatchObject({ fontSize: 18, wrapLines: false });
  });

  it('validates what it is given', () => {
    const p = fresh();
    p.update({ fontSize: 999, fontFamily: 'nope' as never });
    expect(p.prefs().fontSize).toBe(28);
    expect(p.prefs().fontFamily).toBe('jetbrains');
  });

  it('ignores damaged storage', () => {
    store.set('quill.prefs.v1', '{not json');
    expect(fresh().prefs()).toEqual(DEFAULT_PREFS);
    store.set('quill.prefs.v1', JSON.stringify({ fontSize: 'big', bell: true }));
    expect(fresh().prefs()).toMatchObject({ fontSize: 15, bell: true });
  });

  it('keeps working for this visit when the browser will not store anything', () => {
    const p = fresh();
    failing = true;
    p.update({ bell: true });
    expect(p.prefs().bell).toBe(true);
    expect(p.persistent()).toBe(false);
    failing = false;
    p.update({ bell: false });
    expect(p.persistent()).toBe(true);
  });

  it('resets to the defaults', () => {
    const p = fresh();
    p.update({ fontSize: 20, autoCompile: true });
    p.reset();
    expect(p.prefs()).toEqual(DEFAULT_PREFS);
  });
});
