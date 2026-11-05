import { describe, expect, it } from 'vitest';
import { buildFileTree, isValidProjectPath } from './file-tree';

describe('buildFileTree', () => {
  it('groups paths by directory, directories first, alphabetical', () => {
    const tree = buildFileTree(['main.tex', 'chapters/b.tex', 'chapters/a.tex', 'figures/orbit.png', 'refs.bib']);
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(['dir:chapters', 'dir:figures', 'file:main.tex', 'file:refs.bib']);
    expect(tree[0].children.map((c) => c.path)).toEqual(['chapters/a.tex', 'chapters/b.tex']);
  });

  it('handles nested directories', () => {
    const [dir] = buildFileTree(['a/b/c.tex']);
    expect(dir.children[0].children[0]).toMatchObject({ name: 'c.tex', path: 'a/b/c.tex', kind: 'file' });
  });
});

describe('buildFileTree with empty folders', () => {
  it('shows a folder that has nothing in it yet', () => {
    const tree = buildFileTree(['main.tex'], ['drafts']);
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(['dir:drafts', 'file:main.tex']);
    expect(tree[0].children).toEqual([]);
  });
  it('does not duplicate a folder that also holds files, and nests folders inside folders', () => {
    const tree = buildFileTree(['chapters/a.tex'], ['chapters', 'chapters/old/2024']);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c) => `${c.kind}:${c.name}`)).toEqual(['dir:old', 'file:a.tex']);
    expect(tree[0].children[0].children[0]).toMatchObject({ kind: 'dir', name: '2024', path: 'chapters/old/2024' });
  });
});

describe('isValidProjectPath', () => {
  it.each(['main.tex', 'chapters/intro.tex', 'figures/my plot-1.png'])('accepts %s', (p) => expect(isValidProjectPath(p)).toBe(true));
  it.each(['', '/etc/passwd', '../x.tex', 'a/../b.tex', 'a//b.tex', 'dir/', 'a/b\\c.tex', 'x'.repeat(201)])('rejects %j', (p) => expect(isValidProjectPath(p)).toBe(false));
});
