import { Component, DestroyRef, ElementRef, HostListener, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AssetsService } from '../../core/api/assets.service';
import { ScrollSummary, ScrollsService, canWrite } from '../../core/api/scrolls.service';
import { AuthService, apiMessage } from '../../core/auth/auth.service';
import { ToastService } from '../../core/notify/toast.service';
import { ModalsService } from '../../core/notify/modals.service';
import { PendingImportService } from '../../core/collab/pending-import';
import { CollabService, Peer } from '../../core/collab/collab.service';
import { isValidProjectPath } from '../../core/collab/file-tree';
import { HallFilter, MEMBER_DRAG_TYPE, MAX_ZOOM, MIN_ZOOM, MapView, Member, Rect, Table, baseName, boundsOf, buildTables, centerOn, clampView, layoutTables, pushAway, copyPath, defaultTable, filterTables, fitView, intersects, isTextName, joinPath, placeFile, seatPlan, stoolLayout, tableNameError, tableOf, usedIn, visibleRect, zoomAt } from '../../core/collab/tavern';
import { ACCEPT_ATTR, checkUpload, extOf, isAssetName, isPreviewableImage } from '../../core/latex/figure';
import { PortraitPanelComponent } from '../editor/ui/portrait-panel.component';
import { ImportDialogComponent } from './import-dialog.component';
import { MemberIconComponent } from './member-icon.component';
import { TextPortraitComponent } from './text-portrait.component';

const MAX_TEXT_BYTES = 1024 * 1024;

type HallView = 'tavern' | 'list';

/** The Tavern Hall: every file of a scroll seated at tables (directories), with a portrait of whoever is selected. */
@Component({
  selector: 'qq-hall-page',
  imports: [FormsModule, RouterLink, ImportDialogComponent, MemberIconComponent, PortraitPanelComponent, TextPortraitComponent],
  templateUrl: './hall.page.html',
  styleUrl: './hall.page.scss',
})
export class HallPage {
  /** Route param `:id` (bound via withComponentInputBinding). */
  readonly id = input.required<string>();
  /** `?mode=list` opens the list view (the command menu links to it). */
  readonly mode = input<string>();

  protected readonly collab = inject(CollabService);
  protected readonly auth = inject(AuthService);
  protected readonly modals = inject(ModalsService);
  private readonly scrolls = inject(ScrollsService);
  private readonly assetsApi = inject(AssetsService);
  private readonly router = inject(Router);
  private readonly pendingImport = inject(PendingImportService);
  private readonly toasts = inject(ToastService);

  private readonly picker = viewChild.required<ElementRef<HTMLInputElement>>('picker');
  private readonly importer = viewChild.required(ImportDialogComponent);
  private readonly mapEl = viewChild<ElementRef<HTMLElement>>('map');
  private readonly benchDlg = viewChild.required<ElementRef<HTMLDialogElement>>('benchDlg');
  private readonly newTableDlg = viewChild.required<ElementRef<HTMLDialogElement>>('newTableDlg');
  private readonly renameDlg = viewChild.required<ElementRef<HTMLDialogElement>>('renameDlg');
  private readonly removeDlg = viewChild.required<ElementRef<HTMLDialogElement>>('removeDlg');

  protected readonly accept = ACCEPT_ATTR + ',.tex,.bib,.sty,.cls,.def,.md,.txt,.zip';
  protected readonly view = signal<HallView>('tavern');
  protected readonly scroll = signal<ScrollSummary | null>(null);
  protected readonly canEdit = computed(() => canWrite(this.scroll()?.role));
  protected readonly selected = signal<string | null>(null);
  protected readonly notice = signal<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  protected readonly busy = signal(0);
  protected readonly dragging = signal(false);
  /** A member is being dragged to another table (a move, not an upload). */
  protected readonly moving = signal<string | null>(null);
  protected readonly dropTable = signal<string | null>(null);
  protected readonly menu = signal<{ x: number; y: number; path: string; sub: boolean } | null>(null);

  // list view
  protected readonly query = signal('');
  protected readonly filter = signal<HallFilter>('all');
  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());
  protected readonly filters: Array<{ key: HallFilter; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'sources', label: 'Sources' },
    { key: 'images', label: 'Images' },
    { key: 'bibliography', label: 'Bibliography' },
  ];

  // dialogs
  protected readonly tableName = signal('');
  protected readonly tableParent = signal('');
  protected readonly tableError = signal<string | null>(null);
  private pendingMove: string | null = null;
  protected readonly renaming = signal<string | null>(null);
  protected readonly renameValue = signal('');
  protected readonly renameError = signal<string | null>(null);
  protected readonly removing = signal<string | null>(null);

  private readonly sizes = signal<Map<string, number>>(new Map());
  private fitted = false;
  private pan: { id: number; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null;
  private smoothTimer: ReturnType<typeof setTimeout> | undefined;

  // the bench: everyone at a crowded table
  protected readonly bench = signal<Table | null>(null);
  protected readonly benchQuery = signal('');
  protected readonly benchList = computed(() => {
    const t = this.bench();
    const q = this.benchQuery().trim().toLowerCase();
    return t ? t.members.filter((m) => !q || m.name.toLowerCase().includes(q)) : [];
  });

  protected readonly tables = computed<Table[]>(() => buildTables(this.collab.files(), this.collab.assets(), this.collab.tables(), this.sizes(), this.collab.mainFile()));
  /** Every table placed on the map, with the members who have a stool (crowded tables keep the rest on a bench). */
  protected readonly items = computed(() => {
    const selected = this.selected();
    const hot = new Set(this.collab.seated().keys());
    const planned = this.tables().map((table) => {
      const plan = seatPlan(table.members, selected, hot);
      return { table, plan, layout: stoolLayout(plan.seated.length + (plan.overflow ? 1 : 0)) };
    });
    const rects = layoutTables(planned.map((p) => p.layout.cell), planned.map((p) => p.table.path), this.collab.tableSpots());
    // the table being carried follows the pointer, and the tables it shoves move with it
    const carried = this.carried();
    return planned.map((p, i) => {
      const r = rects[i];
      const spot = carried?.path === p.table.path ? carried.spot : carried?.pushed.get(p.table.path);
      return spot ? { ...p, rect: { ...r, x: spot.x - r.w / 2, y: spot.y - r.h / 2 } } : { ...p, rect: r };
    });
  });
  /** A table being dragged to a new place: where its centre is right now (already kept clear of the others). */
  protected readonly carried = signal<{ path: string; spot: { x: number; y: number }; pushed: Map<string, { x: number; y: number }> } | null>(null);
  private tableDrag: { id: number; path: string; dx: number; dy: number; cell: number; sx: number; sy: number; moved: boolean; others: Array<{ key: string; spot: { x: number; y: number }; cell: number }>; pushed: Map<string, { x: number; y: number }> } | null = null;
  protected readonly mapView = signal<MapView>({ x: 0, y: 0, k: 1 });
  protected readonly mapSize = signal({ w: 0, h: 0 });
  protected readonly smooth = signal(false);
  protected readonly panning = signal(false);
  /** Only tables near the screen are drawn, so a big hall stays fast. */
  protected readonly visibleItems = computed(() => {
    const { w, h } = this.mapSize();
    if (!w) return this.items().slice(0, 12);
    const vis = visibleRect(this.mapView(), w, h, 240);
    return this.items().filter((i) => intersects(i.rect, vis));
  });
  protected readonly worldTransform = computed(() => {
    const v = this.mapView();
    return `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
  });
  protected readonly zoomPct = computed(() => Math.round(this.mapView().k * 100));
  protected readonly far = computed(() => this.mapView().k < 0.55);
  protected readonly mini = computed(() => {
    const items = this.items();
    const { w, h } = this.mapSize();
    const b = boundsOf(items.map((i) => i.rect));
    const W = 176;
    const H = 116;
    const pad = 300;
    const scale = Math.min(W / (b.w + 2 * pad), H / (b.h + 2 * pad));
    const ox = (W - (b.w + 2 * pad) * scale) / 2 - (b.x - pad) * scale;
    const oy = (H - (b.h + 2 * pad) * scale) / 2 - (b.y - pad) * scale;
    const vis = visibleRect(this.mapView(), w || 1, h || 1);
    return {
      W, H, scale, ox, oy,
      dots: items.map((i) => ({ path: i.table.path, x: i.rect.x * scale + ox, y: i.rect.y * scale + oy, d: Math.max(6, i.rect.w * scale) })),
      view: { x: vis.x * scale + ox, y: vis.y * scale + oy, w: vis.w * scale, h: vis.h * scale },
    };
  });
  protected readonly isEmpty = computed(() => this.collab.synced() && this.tables().length === 0);
  protected readonly memberCount = computed(() => this.tables().reduce((n, t) => n + t.members.length, 0));
  protected readonly members = computed(() => new Map(this.tables().flatMap((t) => t.members.map((m) => [m.path, m] as const))));
  protected readonly current = computed(() => {
    const path = this.selected();
    return path ? (this.members().get(path) ?? null) : null;
  });
  protected readonly usage = computed(() => {
    const m = this.current();
    this.collab.files();
    return m ? usedIn(this.collab.sources(), m.path) : [];
  });
  protected readonly text = computed(() => {
    const m = this.current();
    this.collab.files();
    return m && !m.asset ? this.collab.project.read(m.path) : '';
  });
  protected readonly mates = computed(() => {
    const m = this.current();
    if (!m?.asset) return [];
    return this.collab.assets().filter((a) => tableOf(a.path) === m.table && isPreviewableImage(a.mime));
  });
  protected readonly listTables = computed(() => filterTables(this.tables(), this.query(), this.filter()));
  protected readonly menuMember = computed(() => {
    const m = this.menu();
    return m ? (this.members().get(m.path) ?? null) : null;
  });
  protected readonly moveTargets = computed(() => {
    const here = this.menuMember()?.table ?? '';
    const all = new Set(['', ...this.tables().map((t) => t.path)]);
    return [...all].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))).map((path) => ({ path, label: path ? `${path}/` : 'main hall', current: path === here }));
  });
  protected readonly parentChoices = computed(() => [{ path: '', label: 'The main hall (top level)' }, ...this.tables().filter((t) => t.path).map((t) => ({ path: t.path, label: `${t.path}/` }))]);

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.enter(id));
    });
    // keep the map's size up to date while the map is on screen
    effect((onCleanup) => {
      const el = this.mapEl()?.nativeElement;
      if (!el) return;
      const measure = () => this.mapSize.set({ w: el.clientWidth, h: el.clientHeight });
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      onCleanup(() => ro.disconnect());
    });
    // first look: the whole hall in view
    effect(() => {
      const { w } = this.mapSize();
      if (!this.fitted && w > 0 && this.collab.synced() && this.items().length) untracked(() => {
        this.fitted = true;
        this.fit(false);
      });
    });
    // selecting something that is off screen (after an upload, a move, the bench) brings it into view
    effect(() => {
      const m = this.current();
      if (!m) return;
      untracked(() => {
        const { w, h } = this.mapSize();
        const item = this.items().find((i) => i.table.path === m.table);
        if (!w || !item) return;
        const vis = visibleRect(this.mapView(), w, h, -60);
        if (!intersects(vis, item.rect)) this.glideTo(item.rect, Math.max(this.mapView().k, 0.6));
      });
    });
    // text sizes are a snapshot of the document: refresh when the set of files changes
    effect(() => {
      this.collab.files();
      this.sizes.set(this.collab.fileSizes());
    });
    // somebody removed the selected member
    effect(() => {
      const sel = this.selected();
      if (sel && this.collab.synced() && !this.members().has(sel)) untracked(() => this.selected.set(null));
    });
    // the browser hides why a socket failed: if the session expired, go and sign in again
    effect((onCleanup) => {
      if (this.collab.status() !== 'offline' || !this.collab.roomId()) return;
      const timer = setTimeout(async () => {
        await this.auth.checkSession(); // a refusal brings up "Your session has ended" over the page
      }, 6000);
      onCleanup(() => clearTimeout(timer));
    });
    effect(() => {
      if (this.mode() === 'list') untracked(() => this.view.set('list'));
    });
    // a scroll just made from a .zip: unpack it as soon as the table is ready, then open the scroll
    effect(() => {
      const id = this.id();
      if (this.collab.synced() && this.collab.roomId() === id && this.scroll() && this.pendingImport.has(id)) {
        const file = this.pendingImport.take(id);
        if (file) untracked(() => void this.importNewScroll(id, file));
      }
    });
    inject(DestroyRef).onDestroy(() => this.collab.disconnect());
  }

  private async enter(id: string): Promise<void> {
    this.scroll.set(null);
    try {
      this.scroll.set(await this.scrolls.get(id));
      this.collab.connect(id, undefined, true); // this window only looks: it is not another scribe at the table
    } catch (e) {
      // the session ended: the "session ended" screen takes over; there is nothing to redirect
      if ((e as { status?: number })?.status === 401) return;
      // a scroll that exists but is not yours: the "You need a seat" page; anything else: not found
      const door = await this.scrolls.door(id).catch(() => null);
      await this.router.navigateByUrl(door && !door.member ? `/request/${id}` : '/404', { replaceUrl: true });
    }
  }

  // ---- the map: pan, zoom, jump
  private setView(v: MapView, smooth = false): void {
    clearTimeout(this.smoothTimer);
    this.smooth.set(smooth);
    const { w, h } = this.mapSize();
    this.mapView.set(clampView(v, boundsOf(this.items().map((i) => i.rect)), w, h));
    if (smooth) this.smoothTimer = setTimeout(() => this.smooth.set(false), 420);
  }
  private glideTo(rect: Rect, k: number): void {
    const { w, h } = this.mapSize();
    this.setView(centerOn(this.mapView(), rect.x + rect.w / 2, rect.y + rect.h / 2, w, h, k), true);
  }
  protected fit(smooth = true): void {
    const { w, h } = this.mapSize();
    // keep clear of the drop door and zoom controls along the bottom, so no table ends up hiding behind them
    this.setView(fitView(boundsOf(this.items().map((i) => i.rect)), w, Math.max(240, h - 130)), smooth);
  }
  protected zoomBy(factor: number): void {
    const { w, h } = this.mapSize();
    this.setView(zoomAt(this.mapView(), factor, w / 2, h / 2), true);
  }
  protected resetZoom(): void {
    const { w, h } = this.mapSize();
    const v = this.mapView();
    this.setView(zoomAt(v, 1 / v.k, w / 2, h / 2), true);
  }
  protected goTo(path: string): void {
    const item = this.items().find((i) => i.table.path === path);
    if (item) this.glideTo(item.rect, 1);
  }
  protected onWheel(e: WheelEvent): void {
    e.preventDefault();
    const el = this.mapEl()?.nativeElement;
    if (!el) return;
    const v = this.mapView();
    if (e.ctrlKey || e.metaKey) {
      const box = el.getBoundingClientRect();
      this.setView(zoomAt(v, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01)), e.clientX - box.left, e.clientY - box.top));
    } else {
      const line = e.deltaMode === 1 ? 16 : 1;
      this.setView({ ...v, x: v.x - e.deltaX * line, y: v.y - e.deltaY * line });
    }
  }
  /** The world point under a pointer event. */
  private worldAt(e: PointerEvent): { x: number; y: number } {
    const box = this.mapEl()!.nativeElement.getBoundingClientRect();
    const v = this.mapView();
    return { x: (e.clientX - box.left - v.x) / v.k, y: (e.clientY - box.top - v.y) / v.k };
  }

  /** Pressing on a table's round top (scribes only) picks the table up instead of panning the map. */
  private startTableDrag(e: PointerEvent): boolean {
    if (!this.canEdit() || !this.mapEl()) return false;
    const w = this.worldAt(e);
    const hit = this.items().find((i) => {
      const r = i.rect;
      return Math.hypot(w.x - (r.x + r.w / 2), w.y - (r.y + r.h / 2)) <= r.w / 2 - 6;
    });
    if (!hit) return false;
    const r = hit.rect;
    this.tableDrag = { id: e.pointerId, path: hit.table.path, dx: w.x - (r.x + r.w / 2), dy: w.y - (r.y + r.h / 2), cell: r.w, sx: e.clientX, sy: e.clientY, moved: false, others: this.items().filter((i) => i.table.path !== hit.table.path).map((i) => ({ key: i.table.path, spot: { x: i.rect.x + i.rect.w / 2, y: i.rect.y + i.rect.h / 2 }, cell: i.rect.w })), pushed: new Map() };
    this.mapEl()!.nativeElement.setPointerCapture(e.pointerId);
    return true;
  }

  private moveTableDrag(e: PointerEvent): void {
    const d = this.tableDrag;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
    d.moved = true;
    this.panning.set(true);
    const w = this.worldAt(e);
    // a table that has been shoved stays where it was shoved: the others are measured from where they are now,
    // so carrying the table away again (even out past the edge) never lets them drift back
    const r = pushAway({ x: w.x - d.dx, y: w.y - d.dy }, d.cell, d.others);
    for (const [key, spot] of r.moved) {
      const o = d.others.find((x) => x.key === key);
      if (o) o.spot = spot;
      d.pushed.set(key, spot);
    }
    this.carried.set({ path: d.path, spot: r.spot, pushed: new Map(d.pushed) });
  }

  private endTableDrag(e: PointerEvent): void {
    const d = this.tableDrag;
    if (!d || d.id !== e.pointerId) return;
    this.tableDrag = null;
    this.panning.set(false);
    this.mapEl()?.nativeElement.releasePointerCapture(e.pointerId);
    const c = this.carried();
    this.carried.set(null);
    if (d.moved && c && this.canEdit()) this.collab.moveTables(new Map([[c.path, c.spot], ...c.pushed]));
    else if (!d.moved) this.selected.set(null);
  }

  protected panStart(e: PointerEvent): void {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.member, .hud, .minimap, .rm')) return;
    if (this.startTableDrag(e)) return;
    const v = this.mapView();
    this.pan = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y, moved: false };
    this.mapEl()?.nativeElement.setPointerCapture(e.pointerId);
  }
  protected panMove(e: PointerEvent): void {
    if (this.tableDrag) return this.moveTableDrag(e);
    const p = this.pan;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.sx;
    const dy = e.clientY - p.sy;
    if (!p.moved && Math.hypot(dx, dy) < 4) return;
    if (!p.moved) this.panning.set(true);
    p.moved = true;
    this.setView({ ...this.mapView(), x: p.vx + dx, y: p.vy + dy });
  }
  protected panEnd(e: PointerEvent): void {
    if (this.tableDrag) return this.endTableDrag(e);
    const p = this.pan;
    if (!p || p.id !== e.pointerId) return;
    this.pan = null;
    this.panning.set(false);
    this.mapEl()?.nativeElement.releasePointerCapture(e.pointerId);
    if (!p.moved) this.selected.set(null); // a plain click on the floor lets go of the selection
  }
  protected mapKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).closest('.hud, dialog')) return;
    const v = this.mapView();
    const step = 80;
    const keys: Record<string, () => void> = {
      '+': () => this.zoomBy(1.25),
      '=': () => this.zoomBy(1.25),
      '-': () => this.zoomBy(1 / 1.25),
      '0': () => this.resetZoom(),
      f: () => this.fit(),
      ArrowLeft: () => this.setView({ ...v, x: v.x + step }, true),
      ArrowRight: () => this.setView({ ...v, x: v.x - step }, true),
      ArrowUp: () => this.setView({ ...v, y: v.y + step }, true),
      ArrowDown: () => this.setView({ ...v, y: v.y - step }, true),
    };
    const act = keys[e.key];
    if (act && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      act();
    }
  }
  /** Click on the minimap: centre the map there. */
  protected jumpMini(e: MouseEvent): void {
    const m = this.mini();
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const wx = (e.clientX - box.left - m.ox) / m.scale;
    const wy = (e.clientY - box.top - m.oy) / m.scale;
    const { w, h } = this.mapSize();
    this.setView(centerOn(this.mapView(), wx, wy, w, h), true);
  }
  protected readonly zoomBounds = { min: MIN_ZOOM, max: MAX_ZOOM };

  // ---- the bench
  protected openBench(t: Table): void {
    this.bench.set(t);
    this.benchQuery.set('');
    this.benchDlg().nativeElement.showModal();
  }
  protected sitAt(m: Member): void {
    this.benchDlg().nativeElement.close();
    this.select(m.path);
  }

  // ---- presentation helpers
  protected initials(name: string): string {
    return name.replace(/^(Sir|Dame|Lady|Brother)\s+/i, '').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  }
  protected seatedAt(path: string): Peer[] {
    return this.collab.seated().get(path) ?? [];
  }
  protected thumb(m: Member): string | null {
    return m.asset && isPreviewableImage(m.asset.mime) ? this.assetsApi.url(this.id(), m.path, m.asset.sha256) : null;
  }
  protected plural(n: number): string {
    return `${n} ${n === 1 ? 'member' : 'members'}`;
  }
  protected kb(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  protected toggleTable(path: string): void {
    this.collapsed.update((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  protected say(kind: 'ok' | 'bad', text: string): void {
    this.notice.set({ kind, text });
    if (kind === 'ok') setTimeout(() => this.notice.update((n) => (n?.text === text ? null : n)), 4000);
  }

  // ---- selection and navigation
  protected select(path: string): void {
    this.menu.set(null);
    this.selected.set(path);
  }
  protected open(m: Member): void {
    if (m.asset) this.select(m.path);
    else void this.router.navigate(['/scroll', this.id()], { queryParams: { file: m.path } });
  }
  protected insertFrom(path: string): void {
    void this.router.navigate(['/scroll', this.id()], { queryParams: { insert: path } });
  }
  protected memberKey(e: KeyboardEvent, m: Member): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.open(m);
    } else if (e.key === 'F2' && this.canEdit()) {
      e.preventDefault();
      this.askRename(m.path);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.canEdit() && !m.main) {
      e.preventDefault();
      this.askRemove(m.path);
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      this.menu.set({ x: r.right, y: r.top, path: m.path, sub: false });
    }
  }

  // ---- context menu
  protected showMenu(e: MouseEvent, m: Member): void {
    e.preventDefault();
    this.selected.set(m.path);
    this.menu.set({ x: Math.min(e.clientX, window.innerWidth - 260), y: Math.min(e.clientY, window.innerHeight - 340), path: m.path, sub: false });
  }
  @HostListener('document:click')
  protected closeMenu(): void {
    if (this.menu()) this.menu.set(null);
  }
  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.menu.set(null);
  }

  // ---- files in and out
  protected choose(): void {
    this.picker().nativeElement.click();
  }
  protected picked(input: HTMLInputElement): void {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length) void this.seat(files, null);
  }

  /** Files coming from outside the page. Something already in the hall being moved carries its own type instead. */
  private hasFiles(e: DragEvent): boolean {
    const types = Array.from(e.dataTransfer?.types ?? []);
    return types.includes('Files') && !types.includes(MEMBER_DRAG_TYPE);
  }
  private isMemberDrag(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes(MEMBER_DRAG_TYPE);
  }
  private tableUnder(e: DragEvent): string | null {
    const t = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-table]');
    return t ? t.dataset['table']! : null;
  }

  /** Pick a member up to carry it to another table. */
  protected dragMember(e: DragEvent, m: Member): void {
    if (!this.canEdit() || !e.dataTransfer) return e.preventDefault();
    e.dataTransfer.setData(MEMBER_DRAG_TYPE, m.path);
    e.dataTransfer.setData('text/plain', m.path);
    e.dataTransfer.effectAllowed = 'move';
    this.moving.set(m.path);
    this.menu.set(null);
  }
  protected dragMemberEnd(): void {
    this.moving.set(null);
    this.dropTable.set(null);
  }

  protected dragOver(e: DragEvent): void {
    if (!this.canEdit()) return;
    if (this.isMemberDrag(e)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      this.dropTable.set(this.tableUnder(e));
      return;
    }
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    this.dragging.set(true);
    this.dropTable.set(this.tableUnder(e));
  }
  protected dragLeave(e: DragEvent): void {
    if (e.relatedTarget && (e.currentTarget as Node).contains(e.relatedTarget as Node)) return;
    this.dragging.set(false);
    this.dropTable.set(null);
  }
  protected async dropped(e: DragEvent): Promise<void> {
    if (this.isMemberDrag(e)) {
      // moving a member: it leaves its old seat; nothing is uploaded, whatever else the browser attached
      e.preventDefault();
      const path = e.dataTransfer?.getData(MEMBER_DRAG_TYPE) ?? '';
      const table = this.tableUnder(e);
      this.moving.set(null);
      this.dropTable.set(null);
      if (!this.canEdit() || table === null || !this.members().has(path)) return;
      if (this.members().get(path)!.table !== table) await this.moveTo(path, table);
      return;
    }
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    const table = this.dropTable();
    this.dragging.set(false);
    this.dropTable.set(null);
    if (!this.canEdit()) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) void this.seat(files, table);
  }

  private async importNewScroll(id: string, file: File): Promise<void> {
    const summary = await this.importer().run(file, '');
    const files = this.collab.files();
    if (!files.length) this.collab.addTextFile('main.tex', '\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n');
    else if (!files.includes('main.tex')) this.collab.setMain(files.find((f) => f.endsWith('.tex')) ?? files[0]);
    if (summary.skipped.length || summary.failed) this.toasts.show(`Imported “${file.name}”. ${summary.skipped.length} skipped, ${summary.failed} failed.`, 'ok');
    await this.router.navigate(['/scroll', id]);
  }

  /** Seat uploaded or dropped files at a table (null = each goes to its default table). */
  protected async seat(files: File[], table: string | null): Promise<void> {
    const room = this.collab.roomId();
    if (!room || !this.canEdit()) return;
    const problems: string[] = [];
    const taken = [...this.collab.files(), ...this.collab.assets().map((a) => a.path)];
    let last: string | null = null;
    let imported = 0;
    for (const file of files) {
      const dest = table ?? defaultTable(file.name);
      const path = placeFile(dest, file.name, taken);
      try {
        if (extOf(file.name) === 'zip') {
          const summary = await this.importer().run(file, table ?? '');
          if (summary.last) last = summary.last;
          taken.push(...this.collab.files(), ...this.collab.assets().map((a) => a.path));
          if (summary.failed) problems.push(`“${file.name}”: ${summary.failed} ${summary.failed === 1 ? 'file' : 'files'} could not be seated.`);
          if (summary.seated) imported += summary.seated;
        } else if (isAssetName(file.name)) {
          const bad = checkUpload(file);
          if (bad) throw new Error(bad);
          this.busy.update((n) => n + 1);
          await this.assetsApi.upload(room, path, file);
          taken.push(path);
          last = path;
        } else if (isTextName(file.name)) {
          if (file.size > MAX_TEXT_BYTES) throw new Error(`“${file.name}” is larger than 1 MB.`);
          const error = this.collab.addTextFile(path, await file.text());
          if (error) throw new Error(error);
          taken.push(path);
          last = path;
        } else {
          problems.push(`“${file.name}” is not a kind of file the tavern seats (.tex, .bib, .sty, .md, images, .pdf).`);
        }
      } catch (e) {
        problems.push(e instanceof Error ? e.message : `${file.name}: ${apiMessage(e)}`);
      } finally {
        if (isAssetName(file.name)) this.busy.update((n) => Math.max(0, n - 1));
      }
    }
    if (problems.length) this.say('bad', problems.join(' '));
    else if (imported) this.say('ok', `Seated ${imported} ${imported === 1 ? 'member' : 'members'} from the archive.`);
    else if (last) this.say('ok', files.length === 1 ? `Seated ${baseName(last)} at the ${tableOf(last) || 'main hall'} table.` : `Seated ${files.length} new members.`);
    if (last) this.selected.set(last);
  }

  protected async download(path: string): Promise<void> {
    const m = this.members().get(path);
    if (!m) return;
    const a = document.createElement('a');
    a.download = m.name;
    let revoke: string | null = null;
    if (m.asset) a.href = this.assetsApi.url(this.id(), path, m.asset.sha256);
    else a.href = revoke = URL.createObjectURL(new Blob([this.collab.project.read(path)], { type: 'text/plain;charset=utf-8' }));
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(revoke!), 1000);
  }

  protected async copyPathText(path: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path);
      this.say('ok', `Copied ${path}`);
    } catch {
      this.say('bad', 'The browser would not let us copy. Select the name instead.');
    }
  }

  // ---- changing members
  /** Rename, move or copy a binary file. The server does it in one call, so even big files move instantly. */
  private async moveAsset(from: string, to: string, keep: boolean): Promise<string | null> {
    const room = this.collab.roomId();
    if (!room) return 'Not connected to a scroll.';
    if (this.collab.files().includes(to) || this.collab.assets().some((a) => a.path === to)) return `“${to}” already exists.`;
    this.busy.update((n) => n + 1);
    try {
      await this.assetsApi.relocate(room, from, to, keep);
      return null;
    } catch (e) {
      return apiMessage(e);
    } finally {
      this.busy.update((n) => Math.max(0, n - 1));
    }
  }

  protected async moveTo(path: string, table: string): Promise<string | null> {
    this.menu.set(null);
    const m = this.members().get(path);
    if (!m || m.table === table) return null;
    return this.relocate(m, joinPath(table, m.name));
  }
  private async relocate(m: Member, to: string): Promise<string | null> {
    const error = m.asset ? await this.moveAsset(m.path, to, false) : this.collab.renameFile(m.path, to);
    if (error) this.say('bad', error);
    else {
      // the sources that named the old place (\includegraphics, \input, \bibliography…) now name the new one
      const refs = this.collab.updateReferences(m.path, to);
      const where = tableOf(to) !== m.table ? `moved to ${tableOf(to) ? tableOf(to) + '/' : 'the main hall'}` : `renamed to ${baseName(to)}`;
      const fixed = refs.references ? ` Updated ${refs.references} ${refs.references === 1 ? 'reference' : 'references'} in ${refs.files} ${refs.files === 1 ? 'file' : 'files'}.` : '';
      this.say('ok', `${m.name} ${where}.${fixed}`);
      if (this.selected() === m.path) this.selected.set(to);
    }
    return error;
  }
  protected async onMove(path: string, table: string): Promise<void> {
    await this.moveTo(path, table);
  }

  protected async duplicate(path: string): Promise<void> {
    this.menu.set(null);
    const m = this.members().get(path);
    if (!m) return;
    const taken = [...this.collab.files(), ...this.collab.assets().map((a) => a.path)];
    const to = copyPath(path, taken);
    const error = m.asset ? await this.moveAsset(path, to, true) : this.collab.duplicateFile(path, to);
    if (error) this.say('bad', error);
    else {
      this.say('ok', `Copied to ${to}.`);
      this.selected.set(to);
    }
  }

  /** "Replace" in the portrait: same name and type, new bytes. */
  protected async onReplace(e: { path: string; file: File }): Promise<void> {
    const room = this.collab.roomId();
    if (!room) return;
    if (extOf(e.file.name) !== extOf(e.path)) return void this.say('bad', `Replace it with another .${extOf(e.path)} file, or remove it and upload the new one.`);
    const bad = checkUpload(e.file);
    if (bad) return void this.say('bad', bad);
    try {
      await this.assetsApi.upload(room, e.path, e.file);
      this.say('ok', `${baseName(e.path)} replaced.`);
    } catch (err) {
      this.say('bad', apiMessage(err));
    }
  }

  protected askRename(path: string): void {
    this.menu.set(null);
    const m = this.members().get(path);
    if (!m) return;
    this.renaming.set(path);
    this.renameValue.set(m.name);
    this.renameError.set(null);
    this.renameDlg().nativeElement.showModal();
  }
  protected async doRename(e: Event): Promise<void> {
    e.preventDefault();
    const from = this.renaming();
    const m = from ? this.members().get(from) : null;
    if (!m) return this.renameDlg().nativeElement.close();
    const name = this.renameValue().trim();
    if (!name || name.includes('/')) return void this.renameError.set('Use a file name without slashes (move it to another table from the menu).');
    const to = joinPath(m.table, name);
    if (!isValidProjectPath(to)) return void this.renameError.set('Use letters, numbers, spaces, dashes, underscores and dots.');
    if (m.asset && extOf(name) !== m.ext) return void this.renameError.set(`Keep the .${m.ext} ending; the type of an image cannot change.`);
    if (to === m.path) return this.renameDlg().nativeElement.close();
    const error = await this.relocate(m, to);
    if (error) this.renameError.set(error);
    else this.renameDlg().nativeElement.close();
  }

  protected askRemove(path: string): void {
    this.menu.set(null);
    this.removing.set(path);
    this.removeDlg().nativeElement.showModal();
  }
  protected async doRemove(): Promise<void> {
    const path = this.removing();
    const m = path ? this.members().get(path) : null;
    this.removeDlg().nativeElement.close();
    if (!path || !m) return;
    try {
      if (m.asset) await this.assetsApi.remove(this.id(), path);
      else this.collab.deleteFile(path);
      if (this.selected() === path) this.selected.set(null);
      this.say('ok', `${m.name} left the tavern.`);
    } catch (e) {
      this.say('bad', apiMessage(e));
    }
  }

  // ---- tables
  protected askNewTable(moveFirst: string | null = null): void {
    this.menu.set(null);
    this.pendingMove = moveFirst;
    this.tableName.set('');
    this.tableParent.set('');
    this.tableError.set(null);
    this.newTableDlg().nativeElement.showModal();
  }
  protected async createTable(e: Event): Promise<void> {
    e.preventDefault();
    const existing = ['', ...this.tables().map((t) => t.path)];
    const error = tableNameError(this.tableName(), this.tableParent(), existing);
    if (error) return void this.tableError.set(error);
    const path = joinPath(this.tableParent(), this.tableName().trim());
    const failed = this.collab.createTable(path);
    if (failed) return void this.tableError.set(failed);
    this.newTableDlg().nativeElement.close();
    const move = this.pendingMove;
    this.pendingMove = null;
    if (move) await this.moveTo(move, path);
    else this.say('ok', `A new table, ${path}/, has been pulled up.`);
  }
  protected removeTable(path: string): void {
    this.collab.removeTable(path);
  }
  protected canRemoveTable(t: Table): boolean {
    return this.canEdit() && t.path !== '' && t.members.length === 0;
  }
  protected closeDialog(dlg: HTMLDialogElement): void {
    dlg.close();
    this.pendingMove = null;
  }
}
