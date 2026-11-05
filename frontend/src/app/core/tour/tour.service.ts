import { Injectable, signal } from '@angular/core';

const KEY = 'quill.tour.v1';

/** Whether the tour is on screen, and whether this browser has seen it (kept in this browser only). */
@Injectable({ providedIn: 'root' })
export class TourService {
  readonly active = signal(false);
  /** Bumped by every start, so the overlay begins at the first step each time. */
  readonly run = signal(0);

  /** Has the tour been finished or skipped before? Unknown (storage blocked) counts as seen: never nag. */
  seen(): boolean {
    try {
      return globalThis.localStorage?.getItem(KEY) !== null;
    } catch {
      return true;
    }
  }

  /**
   * Should the tour open by itself? Once per browser, never for automated browsers (they would find the
   * page covered), and `?tour=1` asks for it explicitly.
   */
  shouldAutoStart(search = globalThis.location?.search ?? '', webdriver = globalThis.navigator?.webdriver === true): boolean {
    if (new URLSearchParams(search).get('tour') === '1') return true;
    return !webdriver && !this.seen();
  }

  start(): void {
    this.run.update((n) => n + 1);
    this.active.set(true);
  }

  /** Finished or skipped: remember it, so it does not open by itself again. */
  end(): void {
    this.active.set(false);
    try {
      globalThis.localStorage?.setItem(KEY, new Date().toISOString());
    } catch {
      /* the browser would not keep it: the tour may show again next time, which is harmless */
    }
  }
}
