import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ViewedVersion } from '../../../core/api/versions.service';
import { DiffViewComponent } from './diff-view.component';

const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n');
const viewed = (files: Record<string, string>): ViewedVersion => ({ info: { id: 'v', label: 'Draft 1', auto: false, createdAt: new Date().toISOString(), authorId: null, authorName: null }, files: new Map(Object.entries(files)) });

function setup(now: Record<string, string>, old: Record<string, string>) {
  const fixture = TestBed.createComponent(DiffViewComponent);
  fixture.componentRef.setInput('viewed', viewed(old));
  fixture.componentRef.setInput('now', new Map(Object.entries(now)));
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  return { fixture, host, rows: () => Array.from(host.querySelectorAll('.ln')).map((r) => `${r.classList.contains('add') ? '+' : r.classList.contains('del') ? '-' : ' '}${r.querySelector('.tx')!.textContent!.trim()}`) };
}

describe('DiffViewComponent', () => {
  it('opens on the first file that differs and shows what restoring would add and remove', () => {
    const { host, rows } = setup({ 'a.tex': 'same', 'b.tex': 'now text\nkeep' }, { 'a.tex': 'same', 'b.tex': 'old text\nkeep' });
    expect(host.querySelector('.tab.on .nm')!.textContent).toBe('b.tex');
    expect(rows()).toEqual(['-now text', '+old text', ' keep']);
    expect(host.querySelector('.pill')!.textContent).toContain('Viewing “Draft 1”');
    expect(host.querySelector('.legend')!.textContent).toContain('Restoring would change 1 file');
    expect(host.querySelector('.tab.on .bd')!.textContent!.replace(/\s+/g, '')).toBe('+1−1');
  });

  it('shows files that would come back or go away', () => {
    const { host, fixture, rows } = setup({ 'live-only.tex': 'x\ny' }, { 'old-only.tex': 'p' });
    const tabs = Array.from(host.querySelectorAll('.tab')).map((t) => t.textContent!.replace(/\s+/g, ''));
    expect(tabs).toEqual(['live-only.texgoesaway', 'old-only.texcomesback']);
    expect(rows()).toEqual(['-x', '-y']);
    (host.querySelectorAll('.tab')[1] as HTMLElement).click();
    fixture.detectChanges();
    expect(rows()).toEqual(['+p']);
  });

  it('folds long unchanged stretches and unfolds on request', () => {
    const body = lines(40);
    const { host, fixture, rows } = setup({ 'a.tex': body + '\nnow' }, { 'a.tex': body + '\nthen' });
    expect(host.querySelectorAll('.fold')).toHaveLength(1);
    const before = rows().length;
    (host.querySelector('.fold') as HTMLElement).click();
    fixture.detectChanges();
    expect(host.querySelectorAll('.fold')).toHaveLength(0);
    expect(rows().length).toBeGreaterThan(before);
  });

  it('says so when nothing differs, and emits back and refresh', () => {
    const { host, fixture } = setup({ 'a.tex': 'x' }, { 'a.tex': 'x' });
    expect(host.querySelector('.legend')!.textContent).toContain('matches the live scroll');
    const events: string[] = [];
    fixture.componentInstance.back.subscribe(() => events.push('back'));
    fixture.componentInstance.refresh.subscribe(() => events.push('refresh'));
    (host.querySelector('.back') as HTMLElement).click();
    (host.querySelector('.link') as HTMLElement).click();
    expect(events).toEqual(['back', 'refresh']);
  });
});
