import { Injectable, signal } from '@angular/core';
import { DEFAULT_PREFS, Prefs, ThemeId, parsePrefs } from './prefs';

const KEY = 'quill.prefs.v1';

/** The scribe's preferences as signals; every change is validated, applied at once and kept in this browser. */
@Injectable({ providedIn: 'root' })
export class PreferencesService {
  readonly prefs = signal<Prefs>({ ...DEFAULT_PREFS });
  /** False when the browser would not keep them (private window, storage blocked): they last until the tab closes. */
  readonly persistent = signal(true);

  constructor() {
    try {
      const raw = globalThis.localStorage?.getItem(KEY);
      if (raw) this.prefs.set(parsePrefs(JSON.parse(raw)));
    } catch {
      /* damaged or unavailable: start from the defaults */
    }
    applyTheme(this.prefs().theme);
  }

  update(patch: Partial<Prefs>): void {
    const next = parsePrefs({ ...this.prefs(), ...patch });
    this.prefs.set(next);
    applyTheme(next.theme);
    try {
      globalThis.localStorage.setItem(KEY, JSON.stringify(next));
      this.persistent.set(true);
    } catch {
      this.persistent.set(false);
    }
  }

  reset(): void {
    this.update({ ...DEFAULT_PREFS });
  }
}

/** Dress the whole page as the chosen hall (the stylesheet swaps its colours on this attribute). */
export function applyTheme(theme: ThemeId): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (theme === 'tavern') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
