export interface TreeNode {
  name: string;
  /** Full project path; for directories this is the directory path without trailing slash. */
  path: string;
  kind: 'dir' | 'file';
  children: TreeNode[];
}

/**
 * Turn flat project paths (`chapters/intro.tex`) into a sorted directory tree. `folders` are directories that
 * exist on their own, even with nothing in them yet (every part of such a path is a directory).
 */
export function buildFileTree(paths: readonly string[], folders: readonly string[] = []): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'dir', children: [] };
  for (const f of folders) {
    let node = root;
    f.split('/').filter(Boolean).forEach((part, i, parts) => {
      const path = parts.slice(0, i + 1).join('/');
      let child = node.children.find((c) => c.name === part && c.kind === 'dir');
      if (!child) {
        child = { name: part, path, kind: 'dir', children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');
      let child = node.children.find((c) => c.name === part && c.kind === (isFile ? 'file' : 'dir'));
      if (!child) {
        child = { name: part, path, kind: isFile ? 'file' : 'dir', children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

/** Project paths must stay relative and tidy: they end up on the compile server's disk. */
export function isValidProjectPath(path: string): boolean {
  if (!path || path.length > 200 || path.startsWith('/') || path.endsWith('/')) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && /^[\w.\- ]+$/.test(seg));
}
