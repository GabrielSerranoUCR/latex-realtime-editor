import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '../../../core/layout/panel-layout';
import { PanelsMenuComponent } from './panels-menu.component';

function setup(over: { visible?: Partial<typeof DEFAULT_LAYOUT.visible>; popped?: { preview: boolean; log: boolean }; saved?: boolean } = {}) {
  const fixture = TestBed.createComponent(PanelsMenuComponent);
  fixture.componentRef.setInput('visible', { ...DEFAULT_LAYOUT.visible, ...over.visible });
  fixture.componentRef.setInput('popped', over.popped ?? { preview: false, log: false });
  fixture.componentRef.setInput('hasSaved', over.saved ?? false);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const events: string[] = [];
  const c = fixture.componentInstance;
  c.toggle.subscribe((id) => events.push(`toggle:${id}`));
  c.popOut.subscribe((id) => events.push(`pop:${id}`));
  c.reset.subscribe(() => events.push('reset'));
  c.save.subscribe(() => events.push('save'));
  const openIt = () => {
    (host.querySelector('button.chipbtn') as HTMLElement).click();
    fixture.detectChanges();
  };
  const rows = () => Array.from(host.querySelectorAll('.row')).map((r) => `${r.querySelector('.lbl b')!.textContent} ${r.querySelector('.lbl i')!.textContent}`);
  return { fixture, host, events, openIt, rows };
}

describe('PanelsMenuComponent', () => {
  it('opens and closes from its button, outside clicks and Escape', () => {
    const { fixture, host, openIt } = setup();
    expect(host.querySelector('.pop')).toBeNull();
    openIt();
    expect(host.querySelector('.pop')).not.toBeNull();
    expect(host.querySelector('button.chipbtn')!.getAttribute('aria-expanded')).toBe('true');
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(host.querySelector('.pop')).toBeNull();
    openIt();
    host.querySelector('.pop')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(host.querySelector('.pop')).toBeNull();
  });

  it('stays open when you click inside it', () => {
    const { fixture, host, openIt } = setup();
    openIt();
    let reachedDocument = 0;
    const spy = () => reachedDocument++;
    document.addEventListener('click', spy);
    (host.querySelector('.pop h3') as HTMLElement).click();
    document.removeEventListener('click', spy);
    fixture.detectChanges();
    expect(reachedDocument).toBe(0);
    expect(host.querySelector('.pop')).not.toBeNull();
  });

  it('lists the four panels with their state', () => {
    const { openIt, rows } = setup({ visible: { tree: false }, popped: { preview: true, log: false } });
    openIt();
    expect(rows()).toEqual(['Tavern Hall Hidden', 'Source Editor Docked', 'Scroll Preview In its own window', 'Ink Log Hidden']);
  });

  it('emits toggles, pop-outs, reset and save', () => {
    const { host, events, openIt, fixture } = setup();
    openIt();
    const switches = host.querySelectorAll<HTMLInputElement>('input[role=switch]');
    expect(switches).toHaveLength(4);
    switches[2].dispatchEvent(new Event('change', { bubbles: true }));
    const pops = host.querySelectorAll<HTMLButtonElement>('.pop-btn');
    pops[3].click();
    pops[0].click();
    const foots = host.querySelectorAll<HTMLButtonElement>('.foot');
    foots[0].click();
    foots[1].click();
    fixture.detectChanges();
    expect(events).toEqual(['toggle:preview', 'pop:log', 'pop:tree', 'reset', 'save']);
  });

  it('cannot pop out the source editor, and offers to bring a popped panel back', () => {
    const { host, openIt } = setup({ popped: { preview: true, log: false } });
    openIt();
    const pops = Array.from(host.querySelectorAll<HTMLButtonElement>('.pop-btn'));
    expect(pops[1].disabled).toBe(true);
    expect(pops[2].getAttribute('aria-label')).toBe('Bring Scroll Preview back');
    expect(pops[3].getAttribute('aria-label')).toBe('Pop Ink Log out to its own window');
  });

  it('says when a layout is saved', () => {
    const { host, openIt } = setup({ saved: true });
    openIt();
    expect(host.querySelectorAll('.foot')[1].textContent).toContain('saved');
  });
});
