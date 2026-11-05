import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AssetInfo } from '../../../core/latex/figure';
import { InsertImageDialogComponent } from './insert-image-dialog.component';

const assets: AssetInfo[] = [
  { path: 'figures/orbit.png', size: 100, mime: 'image/png', sha256: 'a'.repeat(64) },
  { path: 'figures/flow.svg', size: 100, mime: 'image/svg+xml', sha256: 'b'.repeat(64) },
  { path: 'figures/plot.pdf', size: 100, mime: 'application/pdf', sha256: 'c'.repeat(64) },
];

function setup() {
  const fixture = TestBed.createComponent(InsertImageDialogComponent);
  fixture.componentRef.setInput('scrollId', 'room-1');
  fixture.componentRef.setInput('assets', assets);
  fixture.detectChanges();
  const emitted: string[] = [];
  fixture.componentInstance.insert.subscribe((s) => emitted.push(s));
  const el = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
  el.showModal = () => el.setAttribute('open', '');
  el.close = () => el.removeAttribute('open');
  return { fixture, c: fixture.componentInstance as any, el, emitted };
}

describe('InsertImageDialogComponent', () => {
  beforeAll(() => TestBed.configureTestingModule({ providers: [provideHttpClient()] }));

  it('offers only images LaTeX can include (no svg)', () => {
    const { c } = setup();
    expect(c.includable().map((a: AssetInfo) => a.path)).toEqual(['figures/orbit.png', 'figures/plot.pdf']);
  });

  it('opens on the chosen image with the design defaults and a derived label', () => {
    const { fixture, c } = setup();
    fixture.componentInstance.open('figures/plot.pdf');
    expect(c.path()).toBe('figures/plot.pdf');
    expect(c.label()).toBe('fig:plot');
    expect(c.latex()).toContain('\\begin{figure}[ht]');
    expect(c.latex()).toContain('\\includegraphics[width=0.7\\textwidth]{figures/plot.pdf}');
  });

  it('keeps a hand-edited label when switching image', () => {
    const { fixture, c } = setup();
    fixture.componentInstance.open();
    c.setLabel('fig:mine');
    c.select('figures/plot.pdf');
    expect(c.label()).toBe('fig:mine');
  });

  it('converts between fractional and cm widths and handles Original', () => {
    const { fixture, c } = setup();
    fixture.componentInstance.open();
    c.setUnit('cm');
    expect(c.width()).toBe(9.8);
    expect(c.latex()).toContain('[width=9.8cm]');
    c.setUnit('\\linewidth');
    expect(c.width()).toBe(0.7);
    c.preset(null);
    expect(c.latex()).toContain('\\includegraphics{figures/orbit.png}');
  });

  it('emits the snippet and closes on submit', () => {
    const { fixture, c, el, emitted } = setup();
    fixture.componentInstance.open();
    c.caption.set('Orbits');
    c.submit();
    expect(emitted[0]).toContain('\\caption{Orbits}');
    expect(el.hasAttribute('open')).toBe(false);
  });

  it('warns when graphicx is missing from the main file', () => {
    const { fixture, c } = setup();
    fixture.componentRef.setInput('source', '\\documentclass{article}');
    expect(c.needsGraphicx()).toBe(true);
    fixture.componentRef.setInput('source', '\\usepackage{graphicx}');
    expect(c.needsGraphicx()).toBe(false);
  });
});
