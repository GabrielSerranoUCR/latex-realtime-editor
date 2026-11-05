import { describe, expect, it } from 'vitest';
import { PendingImportService, titleFromZip } from './pending-import';

describe('PendingImportService', () => {
  it('hands the file over once, only for its own scroll', () => {
    const p = new PendingImportService();
    const f = new File(['x'], 'a.zip');
    p.hold('s1', f);
    expect(p.has('s1')).toBe(true);
    expect(p.has('s2')).toBe(false);
    expect(p.has(null)).toBe(false);
    expect(p.take('s2')).toBeNull();
    expect(p.take('s1')).toBe(f);
    expect(p.has('s1')).toBe(false);
  });
});

describe('titleFromZip', () => {
  it('turns an archive name into a scroll title', () => {
    expect(titleFromZip('thesis-final_v2.zip')).toBe('thesis final v2');
    expect(titleFromZip('.zip')).toBe('Imported scroll');
    expect(titleFromZip('x'.repeat(300) + '.zip').length).toBe(120);
  });
});
