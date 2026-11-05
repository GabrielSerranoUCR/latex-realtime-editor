import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetsService } from '../../core/api/assets.service';
import { CollabService } from '../../core/collab/collab.service';
import { ImportDialogComponent } from './import-dialog.component';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const fileOf = (name: string, bytes: Uint8Array) => ({ name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }) as unknown as File;

function setup() {
  const added = new Map<string, string>();
  const uploaded: string[] = [];
  const collab = {
    roomId: signal<string | null>('room-1'),
    files: signal<string[]>(['main.tex']),
    assets: signal<Array<{ path: string }>>([]),
    addTextFile: vi.fn((path: string, text: string) => (added.has(path) ? 'exists' : (added.set(path, text), null))),
  };
  const assets = { upload: vi.fn<(room: string, path: string) => Promise<unknown>>(async (_room, path) => void uploaded.push(path)) };
  TestBed.configureTestingModule({ providers: [{ provide: CollabService, useValue: collab }, { provide: AssetsService, useValue: assets }] });
  const fixture = TestBed.createComponent(ImportDialogComponent);
  fixture.componentRef.setInput('scrollId', 'room-1');
  fixture.detectChanges();
  const el = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
  el.showModal = () => el.setAttribute('open', '');
  el.close = () => el.removeAttribute('open');
  return { fixture, c: fixture.componentInstance as any, el, collab, assets, added, uploaded };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('ImportDialogComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('seats text and pictures at their tables and reports what it skipped', async () => {
    const { c, el, added, uploaded } = setup();
    const zip = zipSync({ 'a/chapters/one.tex': strToU8('One'), 'a/figures/p.png': png, 'a/run.exe': strToU8('MZ'), 'a/main.tex': strToU8('clash') });
    const done = c.run(fileOf('bundle.zip', zip));
    await vi.waitFor(() => expect(c.phase()).toBe('done'));
    expect(el.hasAttribute('open')).toBe(true);
    expect([...added.keys()]).toEqual(expect.arrayContaining(['chapters/one.tex', 'main-2.tex']));
    expect(uploaded).toEqual(['figures/p.png']);
    const s = c.summary();
    expect(s).toMatchObject({ seated: 3, failed: 0, renamed: 1 });
    expect(s.skipped).toEqual([{ name: 'a/run.exe', reason: 'not a kind of file the tavern seats' }]);
    c.close();
    expect(await done).toMatchObject({ seated: 3 });
    expect(el.hasAttribute('open')).toBe(false);
  });

  it('marks a failed upload without stopping the rest', async () => {
    const { c, assets, added } = setup();
    assets.upload.mockRejectedValueOnce({ status: 413, error: { error: 'Files are limited.' } });
    const zip = zipSync({ 'p.png': png, 'n.tex': strToU8('Note') });
    c.run(fileOf('x.zip', zip));
    await vi.waitFor(() => expect(c.phase()).toBe('done'));
    expect(c.summary()).toMatchObject({ seated: 1, failed: 1 });
    expect(added.has('n.tex')).toBe(true);
    expect(c.rows().find((r: any) => r.item.path === 'figures/p.png' || r.item.path === 'p.png').state).toBe('failed');
  });

  it('explains an archive it cannot read and adds nothing', async () => {
    const { c, collab } = setup();
    c.run(fileOf('bad.zip', strToU8('not a zip at all, sorry')));
    await vi.waitFor(() => expect(c.phase()).toBe('error'));
    expect(c.error()).toMatch(/readable \.zip/);
    expect(collab.addTextFile).not.toHaveBeenCalled();
  });

  it('refuses a huge archive up front', async () => {
    const { c } = setup();
    const big = { name: 'big.zip', size: 101 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File;
    c.run(big);
    await vi.waitFor(() => expect(c.phase()).toBe('error'));
    expect(c.error()).toMatch(/larger than 100 MB/);
  });

  it('stops seating when cancelled and leaves what is already there', async () => {
    const { c, assets } = setup();
    const releases: Array<() => void> = [];
    assets.upload.mockImplementation(() => new Promise<unknown>((r) => releases.push(() => r(undefined))));
    const zip = zipSync({ 'a.png': png, 'b.png': png, 'c.png': png, 'd.png': png, 'e.png': png });
    c.run(fileOf('many.zip', zip));
    await vi.waitFor(() => expect(c.phase()).toBe('seating'));
    c.cancel();
    releases.forEach((r) => r());
    await settle();
    await vi.waitFor(() => expect(c.phase()).toBe('cancelled'));
    expect(c.rows().some((r: any) => r.state === 'pending')).toBe(true);
    expect(assets.upload.mock.calls.length).toBeLessThan(5);
  });

  it('reports an empty archive as done with nothing seated', async () => {
    const { c } = setup();
    c.run(fileOf('empty.zip', zipSync({ '__MACOSX/x': strToU8('x'), 'notes.docx': strToU8('x') })));
    await vi.waitFor(() => expect(c.phase()).toBe('done'));
    expect(c.summary()).toMatchObject({ seated: 0 });
    expect(c.summary().skipped).toHaveLength(1);
  });
});
