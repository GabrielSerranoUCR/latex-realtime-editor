import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { PaletteItem } from '../../../core/palette/palette';
import { CommandPaletteComponent } from './command-palette.component';

// the test DOM has no modal dialogs: give it a simple open/close
const proto = HTMLDialogElement.prototype as any;
proto.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
proto.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };

function setup() {
  const ran: string[] = [];
  const mk = (id: string, title: string, section: PaletteItem['section'] = 'Actions'): PaletteItem => ({ id, section, icon: '·', title, hint: '', run: () => ran.push(id) });
  const fixture = TestBed.createComponent(CommandPaletteComponent);
  fixture.componentRef.setInput('items', [mk('hall', 'Open the Tavern Hall'), mk('panel', 'Toggle Tavern Hall panel'), mk('share', 'Share this scroll'), mk('f', 'main.tex', 'Files')]);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const input = () => host.querySelector('input') as HTMLInputElement;
  const titles = () => Array.from(host.querySelectorAll('li[role=option] b')).map((b) => b.textContent);
  const press = (key: string, extra: KeyboardEventInit = {}) => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
    fixture.detectChanges();
  };
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  };
  return { fixture, host, ran, input, titles, press, type, c: fixture.componentInstance };
}

describe('CommandPaletteComponent', () => {
  it('opens with everything listed under its headings, and Escape closes it', () => {
    const t = setup();
    t.c.open();
    t.fixture.detectChanges();
    expect(t.host.querySelector('dialog')!.hasAttribute('open')).toBe(true);
    expect(Array.from(t.host.querySelectorAll('.sec')).map((s) => s.textContent)).toEqual(['Actions', 'Files']);
    expect(t.titles()).toHaveLength(4);
    expect(t.c.isOpen).toBe(true);
    t.c.close();
    expect(t.c.isOpen).toBe(false);
  });

  it('typing narrows the list, Enter runs the first match and closes', () => {
    const t = setup();
    t.c.open();
    t.type('share');
    expect(t.titles()).toEqual(['Share this scroll']);
    t.press('Enter');
    expect(t.ran).toEqual(['share']);
    expect(t.c.isOpen).toBe(false);
  });

  it('the arrow keys move through the list and wrap round', () => {
    const t = setup();
    t.c.open();
    t.fixture.detectChanges();
    expect(t.host.querySelector('li.on b')!.textContent).toBe('Open the Tavern Hall');
    t.press('ArrowDown');
    expect(t.host.querySelector('li.on b')!.textContent).toBe('Toggle Tavern Hall panel');
    t.press('ArrowUp');
    t.press('ArrowUp');
    expect(t.host.querySelector('li.on b')!.textContent).toBe('main.tex'); // wrapped to the end
    t.press('Enter');
    expect(t.ran).toEqual(['f']);
  });

  it('⌘↵ runs the command and keeps the menu open', () => {
    const t = setup();
    t.c.open();
    t.press('Enter', { metaKey: true });
    expect(t.ran).toEqual(['hall']);
    expect(t.c.isOpen).toBe(true);
  });

  it('says so when nothing matches, and Enter then does nothing', () => {
    const t = setup();
    t.c.open();
    t.type('zzzqqq');
    expect(t.host.querySelector('.none')!.textContent).toContain('zzzqqq');
    t.press('Enter');
    expect(t.ran).toEqual([]);
  });

  it('a click runs the row, and toggle opens and closes', () => {
    const t = setup();
    t.c.toggle();
    t.fixture.detectChanges();
    (t.host.querySelectorAll('li[role=option]')[2] as HTMLElement).click();
    expect(t.ran).toEqual(['share']);
    expect(t.c.isOpen).toBe(false);
    t.c.toggle();
    expect(t.c.isOpen).toBe(true);
  });

  it('⌘2 to ⌘4 narrow the list to one kind and ⌘1 brings everything back', () => {
    const t = setup();
    t.c.open();
    t.fixture.detectChanges();
    t.press('3', { metaKey: true });
    expect(t.titles()).toEqual(['main.tex']);
    expect(t.host.querySelector('.kinds .on')!.textContent).toContain('Files');
    t.press('2', { ctrlKey: true }); // Ctrl does the same
    expect(t.titles()).toEqual(['Open the Tavern Hall', 'Toggle Tavern Hall panel', 'Share this scroll']);
    t.press('4', { metaKey: true });
    expect(t.host.querySelector('.none')!.textContent).toContain('Nothing of this kind');
    t.press('1', { metaKey: true });
    expect(t.titles()).toHaveLength(4);
    expect(t.c.isOpen).toBe(true);
  });

  it('the kind buttons work with a click, and opening again starts from everything', () => {
    const t = setup();
    t.c.open();
    t.fixture.detectChanges();
    (t.host.querySelectorAll('.kinds button')[2] as HTMLElement).click();
    t.fixture.detectChanges();
    expect(t.titles()).toEqual(['main.tex']);
    t.c.close();
    t.c.open();
    t.fixture.detectChanges();
    expect(t.titles()).toHaveLength(4);
  });

  it('Option/Alt+1 to 4 filter too (Safari keeps ⌘1–4 for its tabs), even by physical key', () => {
    const t = setup();
    t.c.open();
    t.fixture.detectChanges();
    // on a Mac the Option key changes the letter ("¡" for 1), so the physical key is what counts
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '¡', code: 'Digit1', altKey: true, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '£', code: 'Digit3', altKey: true, bubbles: true, cancelable: true }));
    t.fixture.detectChanges();
    expect(t.titles()).toEqual(['main.tex']);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '&', code: 'Digit1', metaKey: true, bubbles: true, cancelable: true })); // AZERTY ⌘1
    t.fixture.detectChanges();
    expect(t.titles()).toHaveLength(4);
    // with ⌘ and Option together, or with Shift, nothing happens
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', code: 'Digit3', altKey: true, metaKey: true, bubbles: true }));
    t.fixture.detectChanges();
    expect(t.titles()).toHaveLength(4);
  });
});

describe('CommandPaletteComponent keeps the highlighted row in view', () => {
  it('scrolls to the row that is highlighted now, not the one before', () => {
    const scrolled: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
    try {
      const t = setup();
      t.c.open();
      t.fixture.detectChanges();
      t.press('ArrowDown');
      t.press('ArrowDown');
      t.press('ArrowDown'); // the last of the four
      expect(scrolled).toEqual(['pal-1', 'pal-2', 'pal-3']);
      expect(t.host.querySelector('li.on')!.id).toBe('pal-3');
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
});
