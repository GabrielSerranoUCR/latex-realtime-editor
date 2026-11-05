import { type Zippable, strToU8, zipSync } from 'fflate';

/** A file name for the archive from the scroll's title: "Thesis – Chapter 4" becomes "Thesis-Chapter-4.zip". */
export function archiveName(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._ -]+/g, ' ')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${base || 'scroll'}.zip`;
}

/**
 * Every file of a scroll as a .zip, folders and all: text files as written, pictures and PDFs as bytes, and
 * tables (folders) that hold nothing as empty folders, so importing it again gives the same scroll back.
 */
export function buildArchive(texts: ReadonlyArray<{ path: string; text: string }>, assets: ReadonlyArray<{ path: string; bytes: Uint8Array }>, emptyFolders: readonly string[] = []): Uint8Array {
  const entries: Zippable = {};
  for (const f of texts) entries[f.path] = strToU8(f.text);
  // pictures and PDFs are already compressed: stored as they are
  for (const a of assets) entries[a.path] = [a.bytes, { level: 0 }];
  const hasFiles = new Set(Object.keys(entries).flatMap((p) => p.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
  for (const dir of emptyFolders) if (!hasFiles.has(dir)) entries[`${dir}/`] = new Uint8Array();
  return zipSync(entries, { level: 6 });
}
