import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, decodeText, extractZip, listZip, planImport } from './zip-import';

const e = (name: string, size = 100) => ({ name, size });

describe('planImport', () => {
  it('turns folders into tables and top-level files into the main hall', () => {
    const plan = planImport([e('main.tex'), e('chapters/'), e('chapters/intro.tex'), e('figures/orbit.png'), e('refs.bib')], []);
    expect(plan.items.map((i) => [i.path, i.table, i.kind])).toEqual([
      ['main.tex', '', 'text'],
      ['chapters/intro.tex', 'chapters', 'text'],
      ['figures/orbit.png', 'figures', 'asset'],
      ['refs.bib', '', 'text'],
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('unwraps a single wrapping folder (thesis/…)', () => {
    const plan = planImport([e('thesis/main.tex'), e('thesis/figures/a.png')], []);
    expect(plan.items.map((i) => i.path)).toEqual(['main.tex', 'figures/a.png']);
  });

  it('can seat everything under a chosen table', () => {
    const plan = planImport([e('main.tex'), e('figures/a.png')], [], IMPORT_LIMITS, 'appendix');
    expect(plan.items.map((i) => [i.path, i.table])).toEqual([['appendix/main.tex', 'appendix'], ['appendix/figures/a.png', 'appendix/figures']]);
  });

  it('keeps the folder when files also sit at the top level', () => {
    const plan = planImport([e('thesis/main.tex'), e('notes.md')], []);
    expect(plan.items.map((i) => i.path)).toEqual(['thesis/main.tex', 'notes.md']);
  });

  it('silently drops operating-system litter and hidden files', () => {
    const plan = planImport([e('__MACOSX/._main.tex'), e('.DS_Store'), e('.git/config'), e('Thumbs.db'), e('main.tex')], []);
    expect(plan.items.map((i) => i.path)).toEqual(['main.tex']);
    expect(plan.skipped).toEqual([]);
  });

  it('refuses unsafe paths and explains every other skip', () => {
    const plan = planImport([e('../evil.tex'), e('a/../../b.tex'), e('C:/x.tex'), e('run.exe'), e('empty.tex', 0), e('big.png', IMPORT_LIMITS.assetBytes + 1), e('long.tex', IMPORT_LIMITS.textBytes + 1), e('ok.tex')], []);
    expect(plan.items.map((i) => i.path)).toEqual(['ok.tex']);
    expect(Object.fromEntries(plan.skipped.map((s) => [s.name, s.reason]))).toEqual({
      '../evil.tex': 'unsafe path',
      'a/../../b.tex': 'unsafe path',
      'C:/x.tex': 'unsafe path',
      'run.exe': 'not a kind of file the tavern seats',
      'empty.tex': 'empty',
      'big.png': 'larger than 10 MB',
      'long.tex': 'larger than 1 MB',
    });
  });

  it('cleans odd names and renames clashes instead of overwriting', () => {
    const plan = planImport([e('My Notes (v2)/Chapter 1.TEX'), e('My Notes (v2)/Chapter 1.tex'), e('root.tex')], ['My Notes -v2/Chapter 1.tex']);
    expect(plan.items.map((i) => [i.path, i.renamed])).toEqual([['My Notes -v2/Chapter 1-2.tex', true], ['My Notes -v2/Chapter 1-3.tex', true], ['root.tex', false]]);
  });

  it('enforces the entry, depth and total-size limits', () => {
    const limits = { ...IMPORT_LIMITS, entries: 2, depth: 2, totalBytes: 250 };
    const plan = planImport([e('a.tex'), e('b.tex'), e('c.tex'), e('x/y/z/w.tex'), e('big.tex', 200)], [], limits);
    expect(plan.items.map((i) => i.path)).toEqual(['a.tex', 'b.tex']);
    expect(plan.skipped.map((s) => s.reason)).toEqual([expect.stringMatching(/more than 2 files/), expect.stringMatching(/more than 2 files/), expect.stringMatching(/more than 2 files/)]);
    const deep = planImport([e('x/y/z/w.tex'), e('a.tex', 100), e('b.tex', 100), e('c.tex', 100)], [], { ...IMPORT_LIMITS, depth: 2, totalBytes: 250 });
    expect(deep.skipped.map((s) => s.reason)).toEqual([expect.stringMatching(/more than 2 folders/), expect.stringMatching(/past/)]);
  });
});

describe('extractZip', () => {
  const zip = zipSync({
    'main.tex': strToU8('\\documentclass{article}'),
    'figures/a.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    'junk.exe': strToU8('MZ'),
    'huge.tex': new Uint8Array(300_000).fill(65),
  });

  it('lists without inflating and extracts only what was planned', async () => {
    const entries = listZip(zip);
    expect(entries.map((x) => x.name).sort()).toEqual(['figures/a.png', 'huge.tex', 'junk.exe', 'main.tex']);
    const plan = planImport(entries, []);
    const { files, failed } = await extractZip(zip, plan.items.filter((i) => i.entry !== 'huge.tex'));
    expect([...files.keys()].sort()).toEqual(['figures/a.png', 'main.tex']);
    expect(failed.size).toBe(0);
    expect(decodeText(files.get('main.tex')!)).toBe('\\documentclass{article}');
    expect(files.get('figures/a.png')![0]).toBe(0x89);
  });

  it('counts the bytes that really come out, whatever the plan claimed', async () => {
    const plan = planImport(listZip(zip), []);
    const liar = plan.items.map((i) => (i.entry === 'huge.tex' ? { ...i, size: 10 } : i)); // pretend it is tiny
    const { files, failed } = await extractZip(zip, liar, { ...IMPORT_LIMITS, textBytes: 100_000 });
    expect(files.has('huge.tex')).toBe(false);
    expect(failed.get('huge.tex')).toMatch(/larger than/);
    expect(files.has('main.tex')).toBe(true);
  });

  it('stops when the archive unpacks past the total', async () => {
    const plan = planImport(listZip(zip), []);
    const { failed } = await extractZip(zip, plan.items, { ...IMPORT_LIMITS, totalBytes: 1000 });
    expect(failed.get('huge.tex')).toMatch(/past/);
  });

  it('rejects something that is not a zip', () => {
    expect(() => listZip(strToU8('definitely not a zip file at all'))).toThrow();
  });

  it('treats binary content as not text', () => {
    expect(decodeText(new Uint8Array([65, 0, 66]))).toBeNull();
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 72, 105]))).toBe('Hi');
  });
});
