import { describe, expect, it } from 'vitest';
import { checkUpload, figureSnippet, formatBytes, hasGraphicx, isLatexIncludable, labelFor, suggestAssetPath } from './figure';

describe('suggestAssetPath', () => {
  it('sanitises and places under figures/', () => {
    expect(suggestAssetPath('My Orbit (final).PNG', [])).toBe('figures/My Orbit -final.png');
    expect(suggestAssetPath('C:\\x\\a.jpg', [])).toBe('figures/a.jpg');
  });
  it('avoids clashes', () => {
    expect(suggestAssetPath('orbit.png', ['figures/orbit.png', 'figures/orbit-2.png'])).toBe('figures/orbit-3.png');
  });
  it('yields a path the server accepts', () => {
    expect(suggestAssetPath('..png', [])).toMatch(/^figures\/[\w\- ]+\.png$/);
  });
});

describe('checkUpload', () => {
  it('accepts supported files', () => expect(checkUpload({ name: 'a.PNG', size: 10 })).toBeNull());
  it.each([
    [{ name: 'a.exe', size: 10 }, /not supported/],
    [{ name: 'a.png', size: 0 }, /empty/],
    [{ name: 'a.png', size: 11 * 1024 * 1024 }, /larger/],
  ])('rejects %j', (f, re) => expect(checkUpload(f)).toMatch(re));
});

describe('figureSnippet', () => {
  it('builds the figure from the design (centred, [htbp] subset, caption, label)', () => {
    expect(figureSnippet({ path: 'figures/o.png', width: 0.7, placement: ['h', 't'], caption: 'Orbit & 50% more', label: 'fig:o' })).toBe(
      '\\begin{figure}[ht]\n  \\centering\n  \\includegraphics[width=0.7\\textwidth]{figures/o.png}\n  \\caption{Orbit \\& 50\\% more}\n  \\label{fig:o}\n\\end{figure}\n',
    );
  });
  it('supports alignment, short caption, cm and original size', () => {
    const s = figureSnippet({ path: 'a.pdf', width: null, align: 'right', caption: 'Long', shortCaption: 'Short' });
    expect(s).toContain('\\raggedleft');
    expect(s).toContain('\\includegraphics{a.pdf}');
    expect(s).toContain('\\caption[Short]{Long}');
    expect(figureSnippet({ path: 'a.png', width: 8, unit: 'cm' })).toContain('[width=8cm]');
  });
  it('omits empty caption, clamps width, falls back to htbp', () => {
    const s = figureSnippet({ path: 'a.pdf', width: 5, caption: '  ', placement: [] });
    expect(s).toContain('[htbp]');
    expect(s).toContain('width=1\\textwidth');
    expect(s).not.toContain('caption');
  });
  it('can skip the figure environment', () => {
    expect(figureSnippet({ path: 'a.png', width: 0.5, float: false, caption: 'ignored' })).toBe('{\\centering\n  \\includegraphics[width=0.5\\textwidth]{a.png}\n}\n');
  });
});

describe('misc', () => {
  it('labelFor', () => expect(labelFor('figures/My Orbit 1.png')).toBe('fig:my-orbit-1'));
  it('formatBytes', () => expect([formatBytes(12), formatBytes(2048), formatBytes(5 * 1024 * 1024)]).toEqual(['12 B', '2.0 KB', '5.0 MB']));
  it('isLatexIncludable', () => expect([isLatexIncludable('a.svg'), isLatexIncludable('a.PNG')]).toEqual([false, true]));
  it('hasGraphicx', () => {
    expect(hasGraphicx('\\usepackage{amsmath, graphicx}')).toBe(true);
    expect(hasGraphicx('\\usepackage[demo]{graphicx}')).toBe(true);
    expect(hasGraphicx('% \\usepackage{x}')).toBe(false);
  });
});
