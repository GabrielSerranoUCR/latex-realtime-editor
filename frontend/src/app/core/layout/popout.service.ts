import { Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { CompileService, Diagnostic } from '../api/compile.service';
import { PanelLayoutService } from './layout.service';
import { PopPanel, PopoutMessage, channelName, parseMessage, popoutUrl, windowName } from './popout-protocol';

const FEATURES: Record<PopPanel, string> = {
  preview: 'popup=yes,width=784,height=924',
  log: 'popup=yes,width=760,height=440',
};

/**
 * Panels that live in their own browser window. The main window owns the compile state and mirrors it to the
 * popped-out pages over a BroadcastChannel; the pages say "dock me" or "jump to this error" back.
 */
@Injectable({ providedIn: 'root' })
export class PopoutService {
  private readonly layout = inject(PanelLayoutService);
  private readonly compile = inject(CompileService);

  private channel: BroadcastChannel | null = null;
  private scrollId: string | null = null;
  private readonly windows: Partial<Record<PopPanel, Window>> = {};
  private watcher: ReturnType<typeof setInterval> | undefined;
  private readonly onPageHide = () => this.closeAll();

  /** A popped-out ink log asked to show an error in the editor. */
  readonly jump = new Subject<Diagnostic>();
  /** The browser refused to open a window (a pop-up blocker). */
  readonly blocked = signal(false);

  /** Start listening for the scroll that is open. */
  attach(scrollId: string): void {
    this.detach();
    this.scrollId = scrollId;
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(channelName(scrollId));
      this.channel.onmessage = (e: MessageEvent) => {
        const m = parseMessage(e.data);
        if (m) this.receive(m);
      };
    }
    window.addEventListener('pagehide', this.onPageHide);
  }

  detach(): void {
    this.closeAll();
    this.channel?.close();
    this.channel = null;
    this.scrollId = null;
    window.removeEventListener('pagehide', this.onPageHide);
  }

  private receive(m: PopoutMessage): void {
    switch (m.type) {
      case 'hello':
        this.broadcast(); // a window just opened (or reloaded): bring it up to date
        break;
      case 'dock':
        this.dock(m.panel);
        break;
      case 'jump':
        this.jump.next(m.diagnostic);
        break;
    }
  }

  /** Send the current compile state to every popped-out page. */
  broadcast(): void {
    if (!this.channel || !this.isAnyPopped()) return;
    this.channel.postMessage({ type: 'snapshot', snapshot: this.compile.snapshot() } satisfies PopoutMessage);
  }

  isAnyPopped(): boolean {
    return Object.keys(this.windows).length > 0;
  }

  /** Open the panel in its own window (or bring that window forward). Returns false if it was blocked. */
  open(panel: PopPanel): boolean {
    if (!this.scrollId) return false;
    const w = window.open(popoutUrl(this.scrollId, panel), windowName(this.scrollId, panel), FEATURES[panel]);
    if (!w) {
      this.blocked.set(true);
      return false;
    }
    this.blocked.set(false);
    this.windows[panel] = w;
    this.layout.setPopped(panel, true);
    w.focus?.();
    this.watcher ??= setInterval(() => this.reap(), 1000);
    return true;
  }

  /** Bring the panel back into the editor and close its window. */
  dock(panel: PopPanel): void {
    const w = this.windows[panel];
    delete this.windows[panel];
    try {
      w?.close();
    } catch {
      /* already gone */
    }
    this.layout.setPopped(panel, false);
    if (!this.isAnyPopped() && this.watcher) {
      clearInterval(this.watcher);
      this.watcher = undefined;
    }
  }

  /** A window the scribe closed by hand docks its panel again. */
  private reap(): void {
    for (const panel of Object.keys(this.windows) as PopPanel[]) if (this.windows[panel]?.closed) this.dock(panel);
  }

  closeAll(): void {
    for (const panel of Object.keys(this.windows) as PopPanel[]) this.dock(panel);
  }
}
