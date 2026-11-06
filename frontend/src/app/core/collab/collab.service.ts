import { parseAssistants } from './assistant-kind';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Awareness } from 'y-protocols/awareness';
import { PendingImportService } from './pending-import';
import * as Y from 'yjs';
import type { TextChange } from '../session/session';
import type { ProjectSource } from '../latex/completions';
import type { AssetInfo } from '../latex/figure';
import { isValidProjectPath } from './file-tree';
import { RefUpdate, updateReferences } from './refs';
import { AuthService } from '../auth/auth.service';
import { PreferencesService } from '../prefs/prefs.service';
import { CollabUser } from './user';
import { ConnectionStatus, WsProvider } from './ws-provider';

export interface Peer {
  clientId: number;
  user: CollabUser;
  /** The project file this scribe has open (null while they look at the Tavern Hall). */
  file: string | null;
}

const STARTER = String.raw`\documentclass[12pt]{article}
\usepackage{amsmath, amssymb}
\usepackage{graphicx}

\title{Welcome to the Gilded Quill}
\author{The scribes of this table}

\begin{document}
\maketitle

\section{Introduction}
Everyone at this table edits the same scroll, live.
Try typing together: the ground state of the harmonic oscillator has energy
\begin{equation}
  E_0 = \tfrac{1}{2}\hbar\omega .
\end{equation}

\end{document}
`;

/**
 * Owns the Yjs document of the open scroll.
 *
 * Document model (mirrored by the Rust server's compile endpoint):
 *   - `files`  Y.Map<Y.Text>   project path -> file contents
 *   - `meta`   Y.Map<unknown>  `main` = entry file (default `main.tex`)
 */
@Injectable({ providedIn: 'root' })
export class CollabService {
  private readonly auth = inject(AuthService);
  private readonly prefsService = inject(PreferencesService);
  private readonly pendingImport = inject(PendingImportService);
  private doc: Y.Doc | null = null;
  private provider: WsProvider | null = null;
  private cleanups: Array<() => void> = [];

  readonly roomId = signal<string | null>(null);
  /** Counts edits to text files made in *this* browser (not by other scribes): what auto-compile waits on. */
  readonly localEdits = signal(0);
  /** The open scroll's Yjs document (for features that keep their own data in it, like margin notes). */
  readonly ydoc = signal<Y.Doc | null>(null);
  readonly status = signal<ConnectionStatus>('offline');
  readonly synced = signal(false);
  readonly peers = signal<Peer[]>([]);
  /** How other scribes see you: your account's name and cursor colour. */
  readonly me = computed<CollabUser>(() => {
    const u = this.auth.user();
    const color = u?.color ?? '#C9A04A';
    return { name: u?.displayName ?? 'A scribe', color, colorLight: color + '33' };
  });
  readonly files = signal<string[]>([]);
  /** Tables (directories) that exist on their own, even with nobody seated yet. Shared through the document. */
  readonly tables = signal<string[]>([]);
  /** Goes up whenever any file's text changes (by anyone): search results use it to know when to look again. */
  readonly docVersion = signal(0);
  /** Where scribes have put tables on the Tavern Hall map (centres, shared and saved with the scroll). */
  readonly tableSpots = signal<Record<string, { x: number; y: number }>>({});
  /** Images and PDFs, live: the server publishes them into the `assets` map after each upload. */
  readonly assets = signal<AssetInfo[]>([]);
  readonly mainFile = signal('main.tex');
  /** Timestamp of the latest successful build, shared through the document so every scribe's preview follows. */
  readonly lastBuild = signal<number | null>(null);
  /** How many edits proposed by an assistant wait for a person to accept them (kept up to date by the server). */
  readonly pendingEdits = signal(0);
  /** Names of AI assistants (through MCP) working in this scroll right now. */
  readonly assistants = signal<{ name: string; agent: string | null }[]>([]);
  readonly activeFile = signal<string | null>(null);
  readonly awareness = signal<Awareness | null>(null);

  /** Read-only view of the project's files for autocompletion (always reflects live edits). */
  readonly project: ProjectSource = {
    paths: () => this.files(),
    read: (path) => this.doc?.getMap<Y.Text>('files').get(path)?.toString() ?? '',
    assets: () => this.assets(),
    assetUrl: (path) => `/api/scrolls/${this.roomId()}/assets/${path.split('/').map(encodeURIComponent).join('/')}`,
  };

  /** Y.Text of the active file (null while the file list is still syncing). */
  readonly activeText = computed(() => {
    const path = this.activeFile();
    this.files(); // re-evaluate when files appear/disappear
    return path && this.doc ? (this.doc.getMap<Y.Text>('files').get(path) ?? null) : null;
  });

  constructor() {
    // What the rest of the table sees of you: who you are, which file you are in, and whether you are
    // there at all ("Appear as present" off makes you invisible, though you still see everyone).
    effect(() => {
      const awareness = this.awareness();
      const file = this.activeFile();
      const me = this.me();
      const present = this.prefsService.prefs().appearPresent && !this.silent;
      if (!awareness) return;
      if (!present) {
        if (awareness.getLocalState() !== null) awareness.setLocalState(null);
        return;
      }
      if (awareness.getLocalState() === null) awareness.setLocalState({ user: me, file });
      else {
        awareness.setLocalStateField('user', me);
        awareness.setLocalStateField('file', file);
      }
    });
  }

  /** Scribes (other than you) sitting at each file, for presence badges. */
  readonly seated = computed(() => {
    const map = new Map<string, Peer[]>();
    for (const p of this.peers()) if (p.file) map.set(p.file, [...(map.get(p.file) ?? []), p]);
    return map;
  });

  /** True for a window that only looks (a popped-out panel, the hall page): it never appears among the scribes. */
  private silent = false;

  /** `observer`: join without appearing at the table (another window of yours must not look like a new scribe). */
  connect(roomId: string, serverUrl = defaultWsBase(), observer = false): void {
    if (this.roomId() === roomId && this.provider) return;
    this.disconnect();
    this.silent = observer;

    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    if (!observer) awareness.setLocalStateField('user', this.me());
    const provider = new WsProvider(`${serverUrl}/ws/${encodeURIComponent(roomId)}`, doc, awareness);
    this.doc = doc;
    this.provider = provider;
    this.ydoc.set(doc);
    this.roomId.set(roomId);
    this.awareness.set(awareness);

    const filesMap = doc.getMap<Y.Text>('files');
    const meta = doc.getMap<unknown>('meta');
    const refreshFiles = () => {
      const names = Array.from(filesMap.keys()).sort();
      this.files.set(names);
      const active = this.activeFile();
      if (!active || !names.includes(active)) {
        this.activeFile.set(names.includes(this.mainFile()) ? this.mainFile() : (names[0] ?? null));
      }
    };
    const assetsMap = doc.getMap<{ size: number; mime: string; sha256: string }>('assets');
    const refreshAssets = () => {
      const list: AssetInfo[] = [];
      assetsMap.forEach((v, path) => list.push({ path, size: v?.size ?? 0, mime: v?.mime ?? '', sha256: v?.sha256 ?? '' }));
      this.assets.set(list.sort((a, b) => a.path.localeCompare(b.path)));
    };
    const tablesMap = doc.getMap<boolean>('tables');
    const refreshTables = () => this.tables.set(Array.from(tablesMap.keys()).sort());
    const spotsMap = doc.getMap<{ x: number; y: number }>('layout');
    const refreshSpots = () => {
      const out: Record<string, { x: number; y: number }> = {};
      spotsMap.forEach((v, k) => {
        if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) out[k] = { x: v.x, y: v.y };
      });
      this.tableSpots.set(out);
    };
    const refreshMeta = () => {
      this.mainFile.set((meta.get('main') as string | undefined) ?? 'main.tex');
      this.lastBuild.set((meta.get('lastBuild') as number | undefined) ?? null);
      this.pendingEdits.set(Number(meta.get('pendingEdits') ?? 0) || 0);
      const bots = meta.get('assistants');
      this.assistants.set(parseAssistants(bots));
    };
    const refreshPeers = () => {
      const out: Peer[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId !== doc.clientID && state['user']) out.push({ clientId, user: state['user'] as CollabUser, file: typeof state['file'] === 'string' ? (state['file'] as string) : null });
      });
      this.peers.set(out);
    };
    filesMap.observe(refreshFiles);
    const noteLocalEdit = (events: Array<Y.YEvent<any>>, txn: Y.Transaction) => {
      if (txn.local) this.localEdits.update((n) => n + 1);
      this.docVersion.update((n) => n + 1);
      if (this.changeListeners.size) this.report(events, filesMap);
    };
    filesMap.observeDeep(noteLocalEdit);
    assetsMap.observe(refreshAssets);
    tablesMap.observe(refreshTables);
    spotsMap.observe(refreshSpots);
    meta.observe(refreshMeta);
    awareness.on('change', refreshPeers);
    this.cleanups.push(
      () => filesMap.unobserve(refreshFiles),
      () => filesMap.unobserveDeep(noteLocalEdit),
      () => assetsMap.unobserve(refreshAssets),
      () => tablesMap.unobserve(refreshTables),
      () => spotsMap.unobserve(refreshSpots),
      () => meta.unobserve(refreshMeta),
      () => awareness.off('change', refreshPeers),
    );

    const statusSub = provider.status$.subscribe((s) => this.status.set(s));
    const syncedSub = provider.synced$.subscribe((s) => {
      this.synced.set(s);
      if (s) this.seedIfEmpty(doc);
    });
    this.cleanups.push(() => statusSub.unsubscribe(), () => syncedSub.unsubscribe());
    refreshFiles();
    refreshAssets();
    refreshTables();
    refreshSpots();
    refreshMeta();
  }

  disconnect(): void {
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    this.provider?.destroy();
    this.doc?.destroy();
    this.provider = this.doc = null;
    this.ydoc.set(null);
    this.roomId.set(null);
    this.awareness.set(null);
    this.status.set('offline');
    this.synced.set(false);
    this.peers.set([]);
    this.files.set([]);
    this.assets.set([]);
    this.tables.set([]);
    this.lastBuild.set(null);
    this.activeFile.set(null);
  }

  /** A file moved or was renamed: point the sources that name it at its new place. */
  updateReferences(from: string, to: string): RefUpdate {
    return this.doc ? updateReferences(this.doc, from, to) : { references: 0, files: 0 };
  }

  /** Make another text file the one that is compiled (anyone who can write may). */
  setMain(path: string): boolean {
    if (!this.doc || !this.files().includes(path)) return false;
    this.doc.getMap<unknown>('meta').set('main', path);
    return true;
  }

  openFile(path: string): void {
    if (this.files().includes(path)) this.activeFile.set(path);
  }

  /** Returns an error message, or null on success. */
  createFile(path: string, content = ''): string | null {
    const doc = this.doc;
    if (!doc) return 'Not connected to a scroll.';
    if (!isValidProjectPath(path)) return 'Use a relative path such as chapters/intro.tex.';
    const files = doc.getMap<Y.Text>('files');
    if (files.has(path)) return `“${path}” already exists.`;
    doc.transact(() => {
      const text = new Y.Text();
      text.insert(0, content);
      files.set(path, text);
    });
    this.activeFile.set(path);
    return null;
  }

  deleteFile(path: string): void {
    const doc = this.doc;
    if (!doc || path === this.mainFile()) return;
    doc.getMap<Y.Text>('files').delete(path);
  }

  /** Bytes of every text file, for the Tavern Hall (a snapshot: call again after edits). */
  fileSizes(): Map<string, number> {
    const enc = new TextEncoder();
    const out = new Map<string, number>();
    this.doc?.getMap<Y.Text>('files').forEach((text, path) => out.set(path, enc.encode(text.toString()).length));
    return out;
  }

  /** Every text file's contents, for "used in" lookups. */
  sources(): Map<string, string> {
    const out = new Map<string, string>();
    this.doc?.getMap<Y.Text>('files').forEach((text, path) => out.set(path, text.toString()));
    return out;
  }

  /** Create an (empty) table. Returns an error message, or null. */
  createTable(path: string): string | null {
    const doc = this.doc;
    if (!doc) return 'Not connected to a scroll.';
    if (!isValidProjectPath(path)) return 'Use letters, numbers, dashes and underscores.';
    doc.getMap<boolean>('tables').set(path, true);
    return null;
  }

  /** Forget an empty table (seated members keep it alive on their own). */
  removeTable(path: string): void {
    this.doc?.getMap<boolean>('tables').delete(path);
    this.doc?.getMap('layout').delete(path);
  }

  private readonly changeListeners = new Set<(c: TextChange) => void>();

  /** Hear about every change to the scroll's text files, by anyone, as small edits (the session recorder uses this). */
  watchChanges(listener: (c: TextChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Turn the document's change events into plain edits (a position, how much went, what came). */
  private report(events: Array<Y.YEvent<any>>, filesMap: Y.Map<Y.Text>): void {
    const emit = (c: TextChange) => this.changeListeners.forEach((l) => l(c));
    for (const ev of events) {
      if (ev instanceof Y.YTextEvent) {
        const path = String(ev.path[0] ?? '');
        let pos = 0;
        for (const d of ev.delta) {
          if (typeof d.retain === 'number') pos += d.retain;
          else if (typeof d.delete === 'number') emit({ kind: 'e', path, pos, del: d.delete, ins: '' });
          else if (typeof d.insert === 'string') {
            emit({ kind: 'e', path, pos, del: 0, ins: d.insert });
            pos += d.insert.length;
          }
        }
      } else if (ev instanceof Y.YMapEvent && ev.target === filesMap) {
        for (const [key, change] of ev.changes.keys) {
          if (change.action === 'add') emit({ kind: 'c', path: key, text: filesMap.get(key)?.toString() ?? '' });
          else if (change.action === 'delete') emit({ kind: 'd', path: key });
          else if (change.action === 'update') {
            emit({ kind: 'd', path: key });
            emit({ kind: 'c', path: key, text: filesMap.get(key)?.toString() ?? '' });
          }
        }
      }
    }
  }

  /** The current text of a file (null if there is no such file). */
  fileText(path: string): string | null {
    return this.doc?.getMap<Y.Text>('files').get(path)?.toString() ?? null;
  }

  /**
   * Change a file in one go: `edits` are given from the end towards the start (so none shifts the next),
   * and everyone at the table sees them as a single change. Returns false if the file is gone.
   */
  applyEdits(path: string, edits: ReadonlyArray<{ from: number; to: number; insert: string }>): boolean {
    const doc = this.doc;
    const text = doc?.getMap<Y.Text>('files').get(path);
    if (!doc || !text) return false;
    doc.transact(() => {
      for (const e of edits) {
        if (e.to > e.from) text.delete(e.from, e.to - e.from);
        if (e.insert) text.insert(e.from, e.insert);
      }
    });
    return true;
  }

  /** Put several tables down at once (a table and the ones it pushed along). */
  moveTables(spots: ReadonlyMap<string, { x: number; y: number }>): void {
    const doc = this.doc;
    if (!doc) return;
    doc.transact(() => spots.forEach((spot, path) => this.moveTable(path, spot)));
  }

  /** Put a table down at this centre; everyone's map follows and the place is kept with the scroll. */
  moveTable(path: string, spot: { x: number; y: number }): void {
    if (!Number.isFinite(spot.x) || !Number.isFinite(spot.y)) return;
    this.doc?.getMap<{ x: number; y: number }>('layout').set(path, { x: Math.round(spot.x), y: Math.round(spot.y) });
  }

  /** Move or rename a text file (its contents are copied; the old path is removed). Returns an error message, or null. */
  renameFile(from: string, to: string): string | null {
    const doc = this.doc;
    if (!doc) return 'Not connected to a scroll.';
    if (!isValidProjectPath(to)) return 'Use a relative path such as chapters/intro.tex.';
    if (from === to) return null;
    const files = doc.getMap<Y.Text>('files');
    const source = files.get(from);
    if (!source) return `“${from}” is no longer here.`;
    if (files.has(to) || this.assets().some((a) => a.path === to)) return `“${to}” already exists.`;
    const wasMain = from === this.mainFile();
    doc.transact(() => {
      const text = new Y.Text();
      text.insert(0, source.toString());
      files.set(to, text);
      files.delete(from);
      if (wasMain) doc.getMap<unknown>('meta').set('main', to);
    });
    return null;
  }

  /** Copy a text file to a new path. Returns an error message, or null. */
  duplicateFile(from: string, to: string): string | null {
    const text = this.doc?.getMap<Y.Text>('files').get(from);
    if (!text) return `“${from}” is no longer here.`;
    return this.createFileQuietly(to, text.toString());
  }

  private createFileQuietly(path: string, content: string): string | null {
    const doc = this.doc;
    if (!doc) return 'Not connected to a scroll.';
    if (!isValidProjectPath(path)) return 'Use a relative path such as chapters/intro.tex.';
    const files = doc.getMap<Y.Text>('files');
    if (files.has(path) || this.assets().some((a) => a.path === path)) return `“${path}” already exists.`;
    doc.transact(() => {
      const text = new Y.Text();
      text.insert(0, content);
      files.set(path, text);
    });
    return null;
  }

  /** Add a text file without switching to it (used when files are dropped on the Tavern Hall). */
  addTextFile(path: string, content: string): string | null {
    return this.createFileQuietly(path, content);
  }

  /** Tell everyone at the table that a new PDF is ready (the server ignores this from readers). */
  announceBuild(builtAt: number): void {
    this.doc?.getMap<unknown>('meta').set('lastBuild', builtAt);
  }

  /** First scribe to arrive at an empty table seeds the starter file. */
  private seedIfEmpty(doc: Y.Doc): void {
    const files = doc.getMap<Y.Text>('files');
    const meta = doc.getMap<unknown>('meta');
    if (files.size > 0 || meta.get('seeded')) return;
    if (this.pendingImport.has(this.roomId())) return; // a .zip is about to be unpacked here instead
    doc.transact(() => {
      const text = new Y.Text();
      text.insert(0, STARTER);
      files.set('main.tex', text);
      meta.set('main', 'main.tex');
      meta.set('seeded', true);
    });
  }
}

function defaultWsBase(): string {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}`;
}
