import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompileService, Diagnostic } from '../api/compile.service';
import { PanelLayoutService } from './layout.service';
import { PopoutService } from './popout.service';

/** An in-memory BroadcastChannel: every instance with the same name hears every other one. */
class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  constructor(public name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(data: unknown) {
    for (const c of FakeChannel.all) if (c !== this && c.name === this.name && !c.closed) c.onmessage?.({ data } as MessageEvent);
  }
  close() {
    this.closed = true;
  }
}

class FakeWindow {
  closed = false;
  close = vi.fn(() => void (this.closed = true));
  focus = vi.fn();
}

describe('PopoutService', () => {
  let opened: Array<{ url: string; name: string; features: string; win: FakeWindow }>;
  let refuse: boolean;
  const setup = () => {
    TestBed.resetTestingModule();
    const svc = TestBed.inject(PopoutService);
    svc.attach('room-1');
    return { svc, layout: TestBed.inject(PanelLayoutService), compile: TestBed.inject(CompileService) };
  };
  const popup = () => {
    const other = new FakeChannel('quill-popout-room-1');
    const got: unknown[] = [];
    other.onmessage = (e) => got.push(e.data);
    return { other, got };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeChannel.all = [];
    opened = [];
    refuse = false;
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    vi.spyOn(window, 'open').mockImplementation(((url: string, name: string, features: string) => {
      if (refuse) return null;
      const win = new FakeWindow();
      opened.push({ url, name, features, win });
      return win as unknown as Window;
    }) as typeof window.open);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens a panel in its own window and marks it popped (and visible)', () => {
    const { svc, layout } = setup();
    layout.setVisible('preview', false);
    expect(svc.open('preview')).toBe(true);
    expect(opened[0]).toMatchObject({ url: '/scroll/room-1/popout/preview', name: 'quill-preview-room-1' });
    expect(opened[0].features).toContain('popup');
    expect(layout.popped().preview).toBe(true);
    expect(layout.visible().preview).toBe(true);
    expect(svc.blocked()).toBe(false);
  });

  it('reports a blocked pop-up and leaves the panel docked', () => {
    const { svc, layout } = setup();
    refuse = true;
    expect(svc.open('log')).toBe(false);
    expect(svc.blocked()).toBe(true);
    expect(layout.popped().log).toBe(false);
  });

  it('docks a panel: closes its window and clears the flag', () => {
    const { svc, layout } = setup();
    svc.open('log');
    svc.dock('log');
    expect(opened[0].win.close).toHaveBeenCalled();
    expect(layout.popped().log).toBe(false);
    expect(svc.isAnyPopped()).toBe(false);
  });

  it('docks by itself when the scribe closes the window by hand', () => {
    const { svc, layout } = setup();
    svc.open('preview');
    opened[0].win.closed = true;
    vi.advanceTimersByTime(1100);
    expect(layout.popped().preview).toBe(false);
  });

  it('brings a new window up to date when it says hello, and keeps mirroring changes', () => {
    const { svc, compile } = setup();
    const { other, got } = popup();
    svc.open('log');
    compile.state.set('ok');
    other.postMessage({ type: 'hello', panel: 'log' });
    expect(got.at(-1)).toMatchObject({ type: 'snapshot', snapshot: { state: 'ok' } });
    compile.state.set('failed');
    svc.broadcast();
    expect(got.at(-1)).toMatchObject({ snapshot: { state: 'failed' } });
  });

  it('says nothing when nothing is popped out', () => {
    const { svc } = setup();
    const { got } = popup();
    svc.broadcast();
    expect(got).toEqual([]);
  });

  it('docks when the window asks to be docked, and passes error jumps on', () => {
    const { svc, layout } = setup();
    const { other } = popup();
    const jumps: Diagnostic[] = [];
    svc.jump.subscribe((d) => jumps.push(d));
    svc.open('preview');
    other.postMessage({ type: 'dock', panel: 'preview' });
    expect(layout.popped().preview).toBe(false);
    other.postMessage({ type: 'jump', diagnostic: { severity: 'error', file: 'a.tex', line: 4, message: 'bad' } });
    expect(jumps).toEqual([{ severity: 'error', file: 'a.tex', line: 4, column: null, message: 'bad' }]);
  });

  it('ignores malformed messages', () => {
    const { svc, layout } = setup();
    const { other } = popup();
    svc.open('preview');
    other.postMessage({ type: 'dock', panel: 'editor' });
    other.postMessage('garbage');
    expect(layout.popped().preview).toBe(true);
  });

  it('closes every window when it lets go of the scroll', () => {
    const { svc, layout } = setup();
    svc.open('preview');
    svc.open('log');
    svc.detach();
    expect(opened.every((o) => o.win.close.mock.calls.length > 0)).toBe(true);
    expect(layout.popped()).toEqual({ preview: false, log: false });
  });
});
