import { Unzip, UnzipInflate, unzipSync } from 'fflate';
import { MAX_ASSET_BYTES, isAssetName } from '../latex/figure';
import { isTextName, placeFile } from './tavern';

/**
 * Importing a `.zip` into a scroll: plan what to seat (folders become tables), then inflate only that,
 * counting the bytes that really come out so a lying header cannot make a zip bomb.
 */

export interface ImportLimits {
  zipBytes: number;
  entries: number;
  assetBytes: number;
  textBytes: number;
  /** Everything inflated together. */
  totalBytes: number;
  /** Folders deep (the server accepts six). */
  depth: number;
}

export const IMPORT_LIMITS: ImportLimits = {
  zipBytes: 100 * 1024 * 1024,
  entries: 1000,
  assetBytes: MAX_ASSET_BYTES,
  textBytes: 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
  depth: 6,
};

export interface ZipEntry {
  name: string;
  /** Uncompressed size as the archive claims it (untrusted). */
  size: number;
}

export interface ImportItem {
  /** The entry's name inside the archive, exactly as stored. */
  entry: string;
  /** Where it will sit in the scroll. */
  path: string;
  table: string;
  kind: 'asset' | 'text';
  size: number;
  /** The tidy name was already taken (or had to be cleaned), so the file lands under another name. */
  renamed: boolean;
}

export interface Skipped {
  name: string;
  reason: string;
}

export interface ImportPlan {
  items: ImportItem[];
  skipped: Skipped[];
}

const mb = (n: number): string => `${+(n / 1024 / 1024).toFixed(1)} MB`;

/** Operating-system litter that should never be listed as "skipped". */
const isJunk = (segments: string[]): boolean => segments.some((s) => s === '__MACOSX' || s.startsWith('.')) || segments[segments.length - 1] === 'Thumbs.db' || segments[segments.length - 1] === 'desktop.ini';

const tidy = (s: string, fallback: string): string => s.replace(/[^\w\- ]+/g, '-').replace(/^[-\s]+|[-\s]+$/g, '').slice(0, 60) || fallback;

/** `taken` = every path already in the scroll (files and assets); it is not modified. */
/** `prefix` seats everything under one table (a zip dropped on a table). */
export function planImport(entries: readonly ZipEntry[], taken: readonly string[], limits: ImportLimits = IMPORT_LIMITS, prefix = ''): ImportPlan {
  const skipped: Skipped[] = [];
  const candidates: Array<{ entry: string; segments: string[]; size: number }> = [];
  for (const e of entries) {
    const name = e.name.replace(/\\/g, '/');
    if (name.endsWith('/')) continue; // a folder: it exists through its files
    const segments = name.split('/').filter((s) => s !== '' && s !== '.');
    if (!segments.length || segments.some((s) => s === '..') || /^[a-zA-Z]:$/.test(segments[0]) || /[\u0000-\u001f]/.test(name)) {
      skipped.push({ name: e.name, reason: 'unsafe path' });
      continue;
    }
    if (isJunk(segments)) continue;
    candidates.push({ entry: e.name, segments, size: e.size });
  }

  // `thesis/main.tex`, `thesis/figures/a.png`: one wrapping folder is not a table of its own
  if (candidates.length && candidates.every((c) => c.segments.length > 1 && c.segments[0] === candidates[0].segments[0])) {
    for (const c of candidates) c.segments = c.segments.slice(1);
  }

  const items: ImportItem[] = [];
  const used = [...taken];
  let total = 0;
  for (const c of candidates) {
    const base = c.segments[c.segments.length - 1];
    const folders = c.segments.slice(0, -1);
    const skip = (reason: string) => skipped.push({ name: c.entry, reason });
    if (items.length >= limits.entries) {
      skip(`more than ${limits.entries} files in the archive`);
      continue;
    }
    const kind = isAssetName(base) ? 'asset' : isTextName(base) ? 'text' : null;
    if (!kind) {
      skip('not a kind of file the tavern seats');
      continue;
    }
    if (folders.length + (prefix ? prefix.split('/').length : 0) > limits.depth) {
      skip(`inside more than ${limits.depth} folders`);
      continue;
    }
    if (c.size === 0) {
      skip('empty');
      continue;
    }
    const cap = kind === 'asset' ? limits.assetBytes : limits.textBytes;
    if (c.size > cap) {
      skip(`larger than ${mb(cap)}`);
      continue;
    }
    if (total + c.size > limits.totalBytes) {
      skip(`the archive would unpack past ${mb(limits.totalBytes)}`);
      continue;
    }
    const table = [prefix, ...folders.map((f) => tidy(f, 'folder'))].filter(Boolean).join('/');
    const path = placeFile(table, base, used);
    const wanted = `${table ? table + '/' : ''}${base}`;
    used.push(path);
    total += c.size;
    items.push({ entry: c.entry, path, table, kind, size: c.size, renamed: path.toLowerCase() !== wanted.toLowerCase() });
  }
  return { items, skipped };
}

/** The archive's table of contents, without inflating anything. Throws if it is not a readable zip. */
export function listZip(data: Uint8Array): ZipEntry[] {
  const out: ZipEntry[] = [];
  unzipSync(data, {
    filter: (f) => {
      out.push({ name: f.name, size: f.originalSize });
      return false;
    },
  });
  return out;
}

export interface Extracted {
  files: Map<string, Uint8Array>;
  /** Entries that could not be inflated (corrupt, or bigger than they said). */
  failed: Map<string, string>;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r));

/** Inflate the planned entries only; enforces `limits` on the bytes that actually come out. */
export async function extractZip(data: Uint8Array, items: readonly ImportItem[], limits: ImportLimits = IMPORT_LIMITS, isCancelled: () => boolean = () => false): Promise<Extracted> {
  const wanted = new Map(items.map((i) => [i.entry, i]));
  const files = new Map<string, Uint8Array>();
  const failed = new Map<string, string>();
  let total = 0;
  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    const item = wanted.get(file.name);
    if (!item) return; // not started, so never inflated
    const cap = item.kind === 'asset' ? limits.assetBytes : limits.textBytes;
    const chunks: Uint8Array[] = [];
    let size = 0;
    let dead = false;
    file.ondata = (err, chunk, final) => {
      if (dead) return;
      if (err) {
        dead = true;
        failed.set(item.entry, 'could not be unpacked');
        return;
      }
      size += chunk.length;
      total += chunk.length;
      if (size > cap || total > limits.totalBytes) {
        dead = true;
        file.terminate();
        failed.set(item.entry, size > cap ? `unpacked larger than ${mb(cap)}` : `the archive unpacked past ${mb(limits.totalBytes)}`);
        return;
      }
      chunks.push(chunk);
      if (final) {
        const whole = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          whole.set(c, at);
          at += c.length;
        }
        files.set(item.entry, whole);
      }
    };
    file.start();
  };
  const STEP = 256 * 1024;
  for (let i = 0; i < data.length; i += STEP) {
    if (isCancelled()) break;
    unzipper.push(data.subarray(i, Math.min(i + STEP, data.length)), i + STEP >= data.length);
    if ((i / STEP) % 8 === 7) await tick(); // let the page breathe on big archives
  }
  for (const item of items) if (!files.has(item.entry) && !failed.has(item.entry) && !isCancelled()) failed.set(item.entry, 'was missing from the archive');
  return { files, failed };
}

/** Text from bytes, or null if it is clearly binary (a NUL byte). */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
}
