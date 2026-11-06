import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelLayoutService } from './layout.service';
import { DEFAULT_LAYOUT } from './panel-layout';

class MemoryStorage {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

describe('PanelLayoutService', () => {
  let store: MemoryStorage;
  const fresh = () => {
    TestBed.resetTestingModule();
    return TestBed.inject(PanelLayoutService);
  };
  beforeEach(() => {
    store = new MemoryStorage();
    vi.stubGlobal('localStorage', store);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts with the designed layout', () => {
    const l = fresh();
    expect(l.sizes()).toEqual(DEFAULT_LAYOUT.sizes);
    expect(l.visible()).toEqual(DEFAULT_LAYOUT.visible);
    expect(l.hasSaved()).toBe(false);
  });

  it('clamps sizes to their limits and to the room the editor needs', () => {
    const l = fresh();
    l.setSize('treeW', 9999); // no workspace measured yet: only the sanity cap applies
    expect(l.sizes().treeW).toBe(9999);
    l.space.set({ w: 1600, h: 900 });
    l.setSize('treeW', 9999); // now it may take what leaves the preview and the editor their smallest
    expect(l.sizes().treeW).toBe(1600 - 24 - 320 - 12 - (280 + 12));
    expect(l.sizes().previewW).toBe(280);
    l.reset();
    l.setSize('logH', 1);
    expect(l.sizes().logH).toBe(84);
    l.space.set({ w: 900, h: 700 });
    l.setSize('previewW', 800);
    expect(l.sizes().previewW).toBeLessThan(800);
    expect(24 + l.sizes().treeW + 12 + 320 + l.sizes().previewW + 12).toBeLessThanOrEqual(900);
  });

  it('refits when the window shrinks', () => {
    const l = fresh();
    l.space.set({ w: 1600, h: 900 });
    l.setSize('previewW', 700);
    l.space.set({ w: 1000, h: 900 });
    l.refit();
    expect(24 + l.sizes().treeW + 12 + 320 + l.sizes().previewW + 12).toBeLessThanOrEqual(1000);
  });

  it('shows and hides panels; popping out makes a panel visible', () => {
    const l = fresh();
    l.toggle('preview');
    expect(l.visible().preview).toBe(false);
    l.setPopped('preview', true);
    expect(l.visible().preview).toBe(true);
    expect(l.popped().preview).toBe(true);
    l.setPopped('preview', false);
    expect(l.popped().preview).toBe(false);
  });

  it('saves the layout for next time and resets it back', () => {
    const l = fresh();
    l.setSize('treeW', 300);
    l.toggle('log'); // the log starts hidden: showing it is what gets saved
    expect(l.save()).toBe(true);
    expect(l.hasSaved()).toBe(true);

    const next = fresh();
    expect(next.sizes().treeW).toBe(300);
    expect(next.visible().log).toBe(true);
    expect(next.hasSaved()).toBe(true);

    next.reset();
    expect(next.sizes()).toEqual(DEFAULT_LAYOUT.sizes);
    expect(next.visible()).toEqual(DEFAULT_LAYOUT.visible);
    expect(next.hasSaved()).toBe(false);
    expect(fresh().sizes().treeW).toBe(DEFAULT_LAYOUT.sizes.treeW);
  });

  it('never saves what is popped out', () => {
    const l = fresh();
    l.setPopped('log', true);
    l.save();
    expect(store.getItem('quill.layout.v1')).not.toContain('popped');
    expect(fresh().popped()).toEqual({ preview: false, log: false });
  });

  it('ignores a damaged or hostile saved layout', () => {
    for (const bad of ['not json', '{"sizes":{"treeW":"wide"},"visible":{}}', JSON.stringify({ sizes: { treeW: 99999, previewW: 1, logH: 1 }, visible: {} })]) {
      store.setItem('quill.layout.v1', bad);
      expect(fresh().sizes()).toEqual(DEFAULT_LAYOUT.sizes);
    }
  });

  it('says so when the browser will not store the layout', () => {
    const l = fresh();
    store.setItem = () => {
      throw new Error('blocked');
    };
    expect(l.save()).toBe(false);
    expect(l.hasSaved()).toBe(false);
  });
});
