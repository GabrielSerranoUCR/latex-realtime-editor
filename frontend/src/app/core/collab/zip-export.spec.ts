import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { archiveName, buildArchive } from './zip-export';

describe('archiveName', () => {
  it('makes a safe file name from a title', () => {
    expect(archiveName('Thesis – Chapter 4')).toBe('Thesis-Chapter-4.zip');
    expect(archiveName('  Café déjà vu  ')).toBe('Cafe-deja-vu.zip');
    expect(archiveName('a/b\\c:d*e?')).toBe('a-b-c-d-e.zip');
    expect(archiveName('…')).toBe('scroll.zip');
    expect(archiveName('x'.repeat(200)).length).toBe(84);
  });
});

describe('buildArchive', () => {
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

  it('holds every text file and picture at its own path, byte for byte', () => {
    const zip = unzipSync(
      buildArchive(
        [
          { path: 'main.tex', text: 'Hola ¿qué tal? ✓\n' },
          { path: 'chapters/intro.tex', text: 'x' },
        ],
        [{ path: 'figures/orbit.png', bytes: png }],
      ),
    );
    expect(Object.keys(zip).sort()).toEqual(['chapters/intro.tex', 'figures/orbit.png', 'main.tex']);
    expect(strFromU8(zip['main.tex'])).toBe('Hola ¿qué tal? ✓\n');
    expect(Array.from(zip['figures/orbit.png'])).toEqual(Array.from(png));
  });

  it('keeps tables that hold nothing as empty folders, but not the ones that hold files', () => {
    const zip = unzipSync(buildArchive([{ path: 'chapters/a.tex', text: 'x' }], [], ['drafts', 'chapters']));
    expect(Object.keys(zip).sort()).toEqual(['chapters/a.tex', 'drafts/']);
    expect(zip['drafts/'].length).toBe(0);
  });

  it('is a valid, empty archive for an empty scroll', () => {
    expect(Object.keys(unzipSync(buildArchive([], [])))).toEqual([]);
  });
});
