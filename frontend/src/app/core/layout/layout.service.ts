import { Injectable, signal } from '@angular/core';
import { DEFAULT_LAYOUT, LIMITS, LayoutSizes, PanelId, PanelLayout, Space, Visibility, clampSizes, maxSize, parseLayout } from './panel-layout';

const KEY = 'quill.layout.v1';

export interface Popped {
  preview: boolean;
  log: boolean;
}

/**
 * How this scribe has arranged the editor. Changes apply at once; "Save as my tavern layout" keeps them
 * in this browser for next time, and "Reset" goes back to the designed layout (and forgets the saved one).
 */
@Injectable({ providedIn: 'root' })
export class PanelLayoutService {
  readonly sizes = signal<LayoutSizes>({ ...DEFAULT_LAYOUT.sizes });
  readonly visible = signal<Visibility>({ ...DEFAULT_LAYOUT.visible });
  /** Panels living in their own browser window right now (never saved). */
  readonly popped = signal<Popped>({ preview: false, log: false });
  readonly hasSaved = signal(false);
  /** The workspace's size, so the editor always keeps room. Set by the editor page. */
  readonly space = signal<Space | null>(null);

  constructor() {
    const saved = this.read();
    if (saved) {
      this.sizes.set(saved.sizes);
      this.visible.set(saved.visible);
      this.hasSaved.set(true);
    }
  }

  private read(): PanelLayout | null {
    try {
      const raw = globalThis.localStorage?.getItem(KEY);
      return raw ? parseLayout(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  setSize(key: keyof LayoutSizes, value: number): void {
    this.sizes.update((s) => clampSizes({ ...s, [key]: value }, this.space(), this.visible(), key));
  }

  /** Re-fit to a new workspace size (a smaller window must not squeeze the editor away). */
  refit(): void {
    this.sizes.update((s) => clampSizes(s, this.space(), this.visible()));
  }

  /** The smallest a panel may be, and the most it may take now (what leaves the others their own smallest). */
  limits(key: keyof LayoutSizes): readonly [number, number] {
    return [LIMITS[key][0], maxSize(key, this.space(), this.visible())];
  }

  setVisible(id: PanelId, on: boolean): void {
    this.visible.update((v) => ({ ...v, [id]: on }));
    this.refit();
  }

  toggle(id: PanelId): void {
    this.setVisible(id, !this.visible()[id]);
  }

  setPopped(panel: keyof Popped, on: boolean): void {
    this.popped.update((p) => ({ ...p, [panel]: on }));
    if (on) this.setVisible(panel, true);
  }

  /** Returns false if the browser would not store it (private window, storage blocked). */
  save(): boolean {
    try {
      const layout: PanelLayout = { sizes: this.sizes(), visible: this.visible() };
      globalThis.localStorage.setItem(KEY, JSON.stringify(layout));
      this.hasSaved.set(true);
      return true;
    } catch {
      return false;
    }
  }

  reset(): void {
    this.sizes.set({ ...DEFAULT_LAYOUT.sizes });
    this.visible.set({ ...DEFAULT_LAYOUT.visible });
    try {
      globalThis.localStorage?.removeItem(KEY);
    } catch {
      /* nothing stored, nothing to forget */
    }
    this.hasSaved.set(false);
    this.refit();
  }
}
