import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollabService } from '../../core/collab/collab.service';
import { ModalsService } from '../../core/notify/modals.service';
import { ToastService } from '../../core/notify/toast.service';
import { PreferencesService } from '../../core/prefs/prefs.service';
import { SettingsModalComponent } from './settings-modal.component';

function setup(over: { canEdit?: boolean; scroll?: boolean } = {}) {
  const collab = { files: signal(['main.tex', 'chapters/intro.tex', 'refs.bib']), mainFile: signal('main.tex'), setMain: vi.fn(() => true) };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: CollabService, useValue: collab }] });
  const modals = TestBed.inject(ModalsService);
  if (over.scroll !== false) modals.scrollContext.set({ canEdit: over.canEdit ?? true });
  const fixture = TestBed.createComponent(SettingsModalComponent);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const prefs = TestBed.inject(PreferencesService);
  const toasts = TestBed.inject(ToastService);
  const open = async (tab: 'compiler' | 'editor' | 'collaboration' = 'compiler') => {
    modals.openSettings(tab);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const type = (sel: string, value: string) => {
    const el = host.querySelector(sel) as HTMLInputElement;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  };
  const toggles = () => host.querySelectorAll<HTMLInputElement>('qq-toggle input');
  const click = (el: Element | null) => {
    (el as HTMLElement).click();
    fixture.detectChanges();
  };
  const save = () => {
    (host.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
  };
  return { fixture, collab, modals, prefs, toasts, host, open, type, toggles, click, save };
}

describe('SettingsModalComponent', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
    };
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens on the tab asked for, with the current values', async () => {
    const t = setup();
    t.prefs.update({ autoCompile: true, showWarnings: false });
    await t.open('compiler');
    expect(t.host.querySelector('dialog')!.hasAttribute('open')).toBe(true);
    expect(t.host.querySelector('[role=tab][aria-selected=true]')!.textContent).toContain('Compiler');
    expect((t.host.querySelector('select[name=main]') as HTMLSelectElement).value).toBe('main.tex');
    expect(Array.from(t.host.querySelectorAll('select[name=main] option')).map((o) => o.textContent)).toEqual(['main.tex', 'chapters/intro.tex']);
    expect(Array.from(t.toggles()).map((c) => c.checked)).toEqual([true, false]);
    expect(t.host.querySelector('.static')!.textContent).toContain('Tectonic');
  });

  it('lets scribes pick another main document and saves it for the whole table', async () => {
    const t = setup();
    await t.open();
    const sel = t.host.querySelector('select[name=main]') as HTMLSelectElement;
    sel.value = 'chapters/intro.tex';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    t.fixture.detectChanges();
    t.save();
    expect(t.collab.setMain).toHaveBeenCalledWith('chapters/intro.tex');
    expect(t.toasts.toasts().at(-1)?.text).toContain('settings are saved');
    expect(t.modals.settings()).toBeNull();
  });

  it('does not touch the main document for readers or when it did not change', async () => {
    const reader = setup({ canEdit: false });
    await reader.open();
    expect((reader.host.querySelector('select[name=main]') as HTMLSelectElement).disabled).toBe(true);
    expect(reader.host.querySelector('.field small')!.textContent).toContain('Only scribes and the owner');
    reader.save();
    expect(reader.collab.setMain).not.toHaveBeenCalled();
    const same = setup();
    await same.open();
    same.save();
    expect(same.collab.setMain).not.toHaveBeenCalled();
  });

  it('leaves out the scroll\'s own settings when no scroll is open', async () => {
    const t = setup({ scroll: false });
    await t.open();
    expect(t.host.querySelector('select[name=main]')).toBeNull();
    expect(t.toggles().length).toBe(2);
  });

  it('saves the compiler behaviour for this browser', async () => {
    const t = setup();
    await t.open();
    t.click(t.toggles()[0]);
    t.click(t.toggles()[1]);
    t.save();
    expect(t.prefs.prefs()).toMatchObject({ autoCompile: true, showWarnings: false });
  });

  it('edits the writing desk with a live sample, and the values are kept within sane limits', async () => {
    const t = setup();
    await t.open('editor');
    const sample = t.host.querySelector('.sample') as HTMLElement;
    expect(sample.style.fontSize).toBe('15px');
    t.type('input[name=size]', '20');
    t.type('input[name=lh]', '30');
    const font = t.host.querySelector('select[name=font]') as HTMLSelectElement;
    font.value = 'courier';
    font.dispatchEvent(new Event('change', { bubbles: true }));
    t.fixture.detectChanges();
    expect(sample.style.fontSize).toBe('20px');
    expect(sample.style.lineHeight).toBe('30px');
    expect(sample.style.fontFamily).toContain('Courier');
    t.click(t.toggles()[1]); // wrap off
    t.click(t.toggles()[3]); // spell-check on
    t.save();
    expect(t.prefs.prefs()).toMatchObject({ fontFamily: 'courier', fontSize: 20, lineHeight: 30, wrapLines: false, spellcheck: true, lineNumbers: true, autoClose: true });
  });

  it('clamps silly font sizes and survives an emptied box', async () => {
    const t = setup();
    await t.open('editor');
    t.type('input[name=size]', '500');
    t.type('input[name=lh]', '');
    t.save();
    expect(t.prefs.prefs().fontSize).toBe(28);
    expect(t.prefs.prefs().lineHeight).toBe(24);
  });

  it('saves the presence settings', async () => {
    const t = setup();
    await t.open('collaboration');
    t.click(t.toggles()[0]);
    t.save();
    expect(t.prefs.prefs()).toMatchObject({ showOthersCursors: false, showNameFlags: true });
  });

  it('throws nothing away on Cancel', async () => {
    const t = setup();
    await t.open('editor');
    t.type('input[name=size]', '22');
    t.click(Array.from(t.host.querySelectorAll('.foot .btn')).find((b) => b.textContent!.trim() === 'Cancel') ?? null);
    expect(t.prefs.prefs().fontSize).toBe(15);
    expect(t.modals.settings()).toBeNull();
    await t.open('editor');
    expect((t.host.querySelector('input[name=size]') as HTMLInputElement).value).toBe('15');
  });

  it('is not shut by the late "close" event of an earlier closing when reopened straight away', async () => {
    const t = setup();
    await t.open('compiler');
    t.modals.closeSettings();
    t.fixture.detectChanges(); // we close the dialog; the browser will report it a moment later
    t.modals.openSettings('editor'); // asked again before that report and before the page has acted on it
    t.host.querySelector('dialog')!.dispatchEvent(new Event('close')); // the late report
    t.fixture.detectChanges();
    await t.fixture.whenStable();
    expect(t.modals.settings()).toBe('editor');
    expect(t.host.querySelector('dialog')!.hasAttribute('open')).toBe(true);
  });

  it('still lets the browser close it (Escape): the state follows', async () => {
    const t = setup();
    await t.open('compiler');
    const dlg = t.host.querySelector('dialog')!;
    dlg.removeAttribute('open'); // what Escape does
    dlg.dispatchEvent(new Event('close'));
    expect(t.modals.settings()).toBeNull();
  });

  it('moves between tabs with the arrow keys', async () => {
    const t = setup();
    await t.open();
    const strip = t.host.querySelector('.modal-tabs') as HTMLElement;
    strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    t.fixture.detectChanges();
    expect(t.host.querySelector('[role=tab][aria-selected=true]')!.textContent).toContain('Editor');
    expect(t.host.querySelector('.lede')!.textContent).toContain('writing desk');
  });
});
