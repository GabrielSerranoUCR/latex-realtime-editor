import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionDetail, VersionInfo, VersionsService, ViewedVersion } from '../../../core/api/versions.service';
import { CollabService } from '../../../core/collab/collab.service';
import { SAFETY_LABEL } from '../../../core/collab/diff';
import { HistoryPanelComponent } from './history-panel.component';

const v = (id: string, over: Partial<VersionInfo> = {}): VersionInfo => ({ id, label: null, auto: true, createdAt: new Date(2026, 10, 5, 14, 0).toISOString(), authorId: 'u1', authorName: 'Aelith', ...over });

function setup(canEdit = true) {
  let list: VersionInfo[] = [v('a'), v('b', { label: 'Draft 1', auto: false, authorId: 'u2', authorName: 'Marcus' }), v('c', { label: SAFETY_LABEL, auto: false })];
  const detail = (id: string): VersionDetail => ({ ...v(id), files: { 'main.tex': 'old text\nshared', 'gone.tex': 'only then' } });
  const api = {
    list: vi.fn(async () => list),
    get: vi.fn(async (_s: string, id: string) => detail(id)),
    create: vi.fn(async (_s: string, label: string) => (list = [v('n', { label, auto: false }), ...list], list[0])),
    rename: vi.fn(async (_s: string, id: string, label: string) => (list = list.map((x) => (x.id === id ? { ...x, label, auto: false } : x)), list.find((x) => x.id === id)!)),
    restore: vi.fn(async () => (list = [v('s', { label: SAFETY_LABEL, auto: false }), ...list], undefined)),
  };
  const collab = { sources: () => new Map([['main.tex', 'new text\nshared']]) };
  TestBed.configureTestingModule({ providers: [{ provide: VersionsService, useValue: api }, { provide: CollabService, useValue: collab }] });
  const fixture = TestBed.createComponent(HistoryPanelComponent);
  fixture.componentRef.setInput('scrollId', 'room-1');
  fixture.componentRef.setInput('canEdit', canEdit);
  fixture.componentRef.setInput('meId', 'u1');
  fixture.detectChanges();
  const views: Array<ViewedVersion | null> = [];
  fixture.componentInstance.view.subscribe((x) => views.push(x));
  const host = fixture.nativeElement as HTMLElement;
  host.querySelectorAll('dialog').forEach((d) => {
    d.showModal = () => d.setAttribute('open', '');
    d.close = () => d.removeAttribute('open');
  });
  const entries = () => Array.from(host.querySelectorAll<HTMLElement>('.entry'));
  const flush = async () => { await vi.waitFor(() => expect(api.list).toHaveBeenCalled()); await fixture.whenStable(); fixture.detectChanges(); };
  return { fixture, c: fixture.componentInstance as any, host, api, views, entries, flush };
}

describe('HistoryPanelComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows the current version first, then the snapshots, newest first', async () => {
    const { entries, flush } = setup();
    await flush();
    const text = entries().map((e) => e.textContent!.replace(/\s+/g, ' ').trim());
    expect(text[0]).toContain('Current version');
    expect(text[0]).toContain('Now');
    expect(text[1]).toContain('Aelith · auto-saved');
    expect(text[2]).toContain('Marcus · “Draft 1”');
    expect(text[3]).toContain('saved before a restore');
  });

  it('filters to named snapshots and to mine', async () => {
    const { c, fixture, entries, flush } = setup();
    await flush();
    c.filter.set('named');
    fixture.detectChanges();
    expect(entries()).toHaveLength(1 + 2);
    c.filter.set('mine');
    fixture.detectChanges();
    expect(entries()).toHaveLength(1 + 2); // a and c are Aelith's (u1); b is Marcus's
    expect(entries().some((e) => e.textContent!.includes('Marcus'))).toBe(false);
  });

  it('picking a snapshot reads it and hands it over to be compared with the present', async () => {
    const { c, fixture, views, flush, host } = setup();
    await flush();
    await c.select(c.versions()[1]);
    fixture.detectChanges();
    expect(views.at(-1)?.info.id).toBe('b');
    expect([...views.at(-1)!.files.keys()].sort()).toEqual(['gone.tex', 'main.tex']);
    expect(host.textContent).toContain('Showing changes against the current version');
    expect(host.querySelector('.foot')!.textContent!.replace(/\s+/g, '')).toContain('2files,+2−1');
    expect(host.querySelector('.actions .go')!.textContent).toContain('Restore this version');
    await c.select(null);
    fixture.detectChanges();
    expect(views.at(-1)).toBeNull();
    expect(host.querySelector('.actions .go')!.textContent).toContain('Save a version');
  });

  it('restoring offers an undo that restores the safety copy', async () => {
    const { c, fixture, api, views, flush, host } = setup();
    await flush();
    await c.select(c.versions()[0]);
    await c.doRestore();
    fixture.detectChanges();
    expect(api.restore).toHaveBeenCalledWith('room-1', 'a');
    expect(views.at(-1)).toBeNull();
    expect(host.querySelector('.notice')!.textContent).toContain('Restored');
    const undo = host.querySelector<HTMLElement>('.notice .link')!;
    expect(undo.textContent).toContain('Undo');
    undo.click();
    await vi.waitFor(() => expect(api.restore).toHaveBeenCalledWith('room-1', 's'));
  });

  it('names a snapshot (keeping it) and saves the present as a version', async () => {
    const { c, api, flush, fixture } = setup();
    await flush();
    c.askName(c.versions()[0]);
    c.nameValue.set('  Reviewed  ');
    await c.doName(new Event('submit'));
    expect(api.rename).toHaveBeenCalledWith('room-1', 'a', 'Reviewed');
    c.askName(null);
    c.nameValue.set('Draft 2');
    await c.doName(new Event('submit'));
    expect(api.create).toHaveBeenCalledWith('room-1', 'Draft 2');
    fixture.detectChanges();
    expect(c.versions()[0].label).toBe('Draft 2');
    c.askName(null);
    c.nameValue.set(SAFETY_LABEL);
    await c.doName(new Event('submit'));
    expect(c.nameError()).toMatch(/name of your own/);
  });

  it('lets readers look but not change anything', async () => {
    const { c, host, flush, fixture } = setup(false);
    await flush();
    await c.select(c.versions()[0]);
    fixture.detectChanges();
    expect(host.textContent).toContain('Readers can look back');
    expect(host.querySelector('.actions')).toBeNull();
  });

  it('reports a version that cannot be read and goes back to the live scroll', async () => {
    const { c, api, views, flush, fixture, host } = setup();
    await flush();
    api.get.mockRejectedValueOnce({ status: 404, error: { error: 'not found' } });
    await c.select(c.versions()[0]);
    fixture.detectChanges();
    expect(views.at(-1)).toBeNull();
    expect(host.querySelector('.notice.bad')!.textContent).toContain('not found');
  });
});
