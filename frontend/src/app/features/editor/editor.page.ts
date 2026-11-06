import { Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { AssetsService } from '../../core/api/assets.service';
import { CompileService, Diagnostic } from '../../core/api/compile.service';
import { AuthService, apiMessage } from '../../core/auth/auth.service';
import { ScrollSummary, ScrollsService, canWrite } from '../../core/api/scrolls.service';
import { CollabService } from '../../core/collab/collab.service';
import { assistantLook } from '../../core/collab/assistant-kind';
import { CommentsService } from '../../core/collab/comments.service';
import { ASSET_DRAG_TYPE, checkUpload, extOf, isAssetName, isLatexIncludable, suggestAssetPath } from '../../core/latex/figure';
import { ViewedVersion } from '../../core/api/versions.service';
import { PanelLayoutService } from '../../core/layout/layout.service';
import { ModalsService } from '../../core/notify/modals.service';
import { NotificationsService } from '../../core/notify/notifications.service';
import { PreferencesService } from '../../core/prefs/prefs.service';
import { DEFAULT_LAYOUT, LayoutSizes, PanelId, gridFor } from '../../core/layout/panel-layout';
import { PopoutService } from '../../core/layout/popout.service';
import { CodeEditorComponent, NoteMark } from './ui/code-editor.component';
import { RecPillComponent } from './ui/rec-pill.component';
import { TimelapseComponent } from './ui/timelapse.component';
import { SessionRecorderService } from '../../core/session/recorder.service';
import { decodeSession } from '../../core/session/session-file';
import { MenubarComponent, Menu } from '../../shared/menubar.component';
import { archiveName, buildArchive } from '../../core/collab/zip-export';
import { ImportDialogComponent } from '../hall/import-dialog.component';
import { AiChangesComponent } from './ui/ai-changes.component';
import { AiDialogComponent } from './ui/ai-dialog.component';
import { SearchPanelComponent } from './ui/search-panel.component';
import type { Hit } from '../../core/search/search';
import { TourComponent } from './ui/tour.component';
import { TourService } from '../../core/tour/tour.service';
import { CommandPaletteComponent } from './ui/command-palette.component';
import { PaletteItem, shortcutLabel } from '../../core/palette/palette';
import { THEMES } from '../../core/prefs/prefs';
import { formatBytes } from '../../core/latex/figure';
import { tableLabel } from '../../core/collab/tavern';
import { ToastService } from '../../core/notify/toast.service';
import { CommentsPanelComponent } from './ui/comments-panel.component';
import { DiffViewComponent } from './ui/diff-view.component';
import { HistoryPanelComponent } from './ui/history-panel.component';
import { FileTreeComponent } from './ui/file-tree.component';
import { InkLogComponent } from './ui/ink-log.component';
import { InsertImageDialogComponent } from './ui/insert-image-dialog.component';
import { PortraitPanelComponent } from './ui/portrait-panel.component';
import { PanelsMenuComponent } from './ui/panels-menu.component';
import { PdfPoint, PdfPreviewComponent } from './ui/pdf-preview.component';
import { ResizeHandleComponent } from './ui/resize-handle.component';
import { ShareDialogComponent } from './ui/share-dialog.component';
import { VerifyBannerComponent } from '../account/verify-banner.component';

@Component({
  selector: 'qq-editor-page',
  imports: [RecPillComponent, TimelapseComponent, MenubarComponent, ImportDialogComponent, AiDialogComponent, AiChangesComponent, SearchPanelComponent, TourComponent, CommandPaletteComponent, CodeEditorComponent, CommentsPanelComponent, DiffViewComponent, PanelsMenuComponent, ResizeHandleComponent, HistoryPanelComponent, FileTreeComponent, InkLogComponent, InsertImageDialogComponent, PortraitPanelComponent, PdfPreviewComponent, ShareDialogComponent, RouterLink, VerifyBannerComponent],
  templateUrl: './editor.page.html',
  styleUrl: './editor.page.scss',
})
export class EditorPage {
  /** Route param `:id` (bound via withComponentInputBinding). */
  readonly id = input.required<string>();
  /** `?file=` and `?insert=` come from the Tavern Hall ("Open in editor", "Insert \includegraphics"). */
  readonly file = input<string>();
  readonly insert = input<string>();

  protected readonly collab = inject(CollabService);
  protected readonly compiler = inject(CompileService);
  protected readonly auth = inject(AuthService);
  private readonly scrolls = inject(ScrollsService);
  private readonly assetsApi = inject(AssetsService);
  private readonly router = inject(Router);

  private readonly tree = viewChild(FileTreeComponent);
  private readonly palette = viewChild(CommandPaletteComponent);
  private readonly searchPanel = viewChild(SearchPanelComponent);
  private readonly toasts = inject(ToastService);
  private readonly tour = inject(TourService);
  private tourOffered = false;
  private readonly editor = viewChild(CodeEditorComponent);
  private readonly shareDialog = viewChild(ShareDialogComponent);
  private readonly aiDialog = viewChild(AiDialogComponent);
  private readonly aiChanges = viewChild(AiChangesComponent);
  private readonly importer = viewChild(ImportDialogComponent);
  private readonly timelapse = viewChild(TimelapseComponent);
  private readonly sessionInput = viewChild<ElementRef<HTMLInputElement>>('sessionInput');
  protected readonly recorder = inject(SessionRecorderService);
  private readonly zipInput = viewChild<ElementRef<HTMLInputElement>>('zipInput');
  private readonly renameDlg = viewChild<ElementRef<HTMLDialogElement>>('renameDlg');
  private readonly insertDialog = viewChild(InsertImageDialogComponent);
  private readonly history = viewChild(HistoryPanelComponent);
  private readonly commentsPanel = viewChild(CommentsPanelComponent);

  protected readonly comments = inject(CommentsService);
  protected readonly modals = inject(ModalsService);
  protected readonly prefs = inject(PreferencesService);
  private readonly notifications = inject(NotificationsService); // starts telling you about new notes and arrivals
  protected readonly layout = inject(PanelLayoutService);
  protected readonly popout = inject(PopoutService);
  private readonly workspace = viewChild<ElementRef<HTMLElement>>('workspace');
  protected readonly toast = signal<{ text: string; bad: boolean } | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** Time travel: the history panel replaces the preview column; a picked version replaces the editor with a diff. */
  protected readonly showHistory = signal(false);
  protected readonly viewing = signal<ViewedVersion | null>(null);
  /** Margin notes: the panel, the thread you are looking at, and who can be @mentioned. */
  protected readonly showComments = signal(false);
  protected readonly selectedNote = signal<string | null>(null);
  protected readonly memberNames = signal<string[]>([]);
  protected readonly isOwner = computed(() => this.role() === 'owner');
  protected readonly nowFiles = signal<ReadonlyMap<string, string>>(new Map());
  /** The right-hand dock shows the preview, or the history / portrait panel when one of those is open. */
  protected readonly rightDock = computed(() => this.layout.visible().preview || this.showHistory() || this.showComments() || !!this.activeAsset());
  /** The open file's margin notes as ranges, for highlights and gutter markers. */
  protected readonly noteMarks = computed<NoteMark[]>(() => {
    const file = this.collab.activeFile();
    const selected = this.selectedNote();
    return this.comments
      .located()
      .filter((l) => l.thread.file === file && l.from !== null && l.to !== null)
      .map((l) => ({ id: l.thread.id, from: l.from!, to: l.to!, resolved: l.thread.resolved, selected: l.thread.id === selected }));
  });
  /** Lines in the open file that the last compile failed on (errors only, never warnings). */
  protected readonly errorLines = computed<number[]>(() => {
    const file = this.collab.activeFile();
    if (!file || this.compiler.result()?.ok !== false) return [];
    return this.compiler.errors().filter((d) => d.line && d.file && (d.file === file || file.endsWith('/' + d.file))).map((d) => d.line!);
  });
  protected readonly grid = computed(() => gridFor({ sizes: this.layout.sizes(), visible: this.layout.visible(), rightDock: this.rightDock(), logPopped: this.layout.popped().log && this.layout.visible().log }));
  protected readonly cursor = signal({ line: 1, col: 1, sel: 0 });
  protected readonly createError = signal<string | null>(null);
  /** Image or PDF open in the portrait panel (replaces the PDF preview while selected). */
  protected readonly activeAsset = signal<string | null>(null);
  protected readonly assetInfo = computed(() => this.collab.assets().find((a) => a.path === this.activeAsset()) ?? null);
  protected readonly uploading = signal(0);
  protected readonly uploadMessage = signal<string | null>(null);
  protected readonly portraitError = signal<string | null>(null);
  protected readonly insertWhere = signal('the cursor');
  protected readonly mainSource = computed(() => {
    this.collab.files();
    return this.collab.project.read(this.collab.mainFile());
  });

  /** The scroll's metadata and *your* role on it, as the server sees it. */
  protected readonly scroll = signal<ScrollSummary | null>(null);
  protected readonly role = computed(() => this.scroll()?.role ?? null);
  protected readonly canEdit = computed(() => canWrite(this.role()));

  protected readonly everyone = computed(() => [{ user: this.collab.me(), clientId: -1 }, ...this.collab.peers()]);
  protected readonly offline = computed(() => this.collab.status() === 'offline');

  constructor() {
    effect(() => {
      const why = this.recorder.stoppedBecause();
      if (why) untracked(() => this.toasts.show(`${why} It is kept for 30 minutes: watch or export it from Tools.`, 'info', 10_000));
    });
    // the first time in this browser (or with ?tour=1), once the table is ready: offer the tour
    effect(() => {
      if (this.tourOffered || !this.collab.synced() || !this.scroll() || !this.collab.files().length) return;
      this.tourOffered = true;
      if (untracked(() => this.tour.shouldAutoStart())) setTimeout(() => this.tour.start(), 900);
    });
    effect(() => {
      const id = this.id();
      untracked(() => void this.enter(id));
    });
    // Arrived from the Tavern Hall: open the file or the insert dialog once the table has synced.
    effect(() => {
      const file = this.file();
      const insert = this.insert();
      if (!(file || insert) || !this.scroll() || !this.collab.synced()) return;
      untracked(() => {
        if (file && this.collab.files().includes(file)) this.openText(file);
        if (insert && this.collab.assets().some((a) => a.path === insert) && this.canEdit()) {
          this.activeAsset.set(insert);
          setTimeout(() => this.openInsert(insert), 0);
        }
        void this.router.navigate([], { queryParams: { file: null, insert: null }, queryParamsHandling: 'merge', replaceUrl: true });
      });
    });
    // Everyone's preview follows the latest build, whoever ran it.
    effect(() => {
      const room = this.collab.roomId();
      const built = this.collab.lastBuild();
      if (room && built) untracked(() => this.compiler.adoptBuild(room, built));
    });
    // The browser hides why a WebSocket failed. If we stay offline, check whether the session
    // expired (then go sign in again) rather than retrying forever against a closed door.
    effect((onCleanup) => {
      if (this.collab.status() !== 'offline' || !this.collab.roomId()) return;
      const timer = setTimeout(async () => {
        await this.auth.checkSession(); // a refusal brings up "Your session has ended" over the page, edits and all
      }, 6000);
      onCleanup(() => clearTimeout(timer));
    });
    // If someone removes the open image, close its portrait.
    effect(() => {
      const open = this.activeAsset();
      if (open && !this.collab.assets().some((a) => a.path === open)) untracked(() => this.activeAsset.set(null));
    });
    // the settings dialog needs to know what you may do in this scroll
    effect(() => {
      const scroll = this.scroll();
      const edit = this.canEdit();
      untracked(() => this.modals.scrollContext.set(scroll ? { canEdit: edit } : null));
    });
    // auto-compile: a couple of seconds after *you* stop typing (others' edits compile on their machines)
    effect((onCleanup) => {
      const edits = this.collab.localEdits();
      if (!edits || !this.prefs.prefs().autoCompile || !this.canEdit()) return;
      const timer = setTimeout(() => {
        if (this.compiler.state() !== 'compiling' && this.collab.status() === 'connected') void this.compile();
      }, 2500);
      onCleanup(() => clearTimeout(timer));
    });
    // keep the layout aware of how much room the workspace has, so the editor is never squeezed out
    effect((onCleanup) => {
      const el = this.workspace()?.nativeElement;
      if (!el) return;
      const measure = () => {
        this.layout.space.set({ w: el.clientWidth, h: el.clientHeight });
        this.layout.refit();
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      onCleanup(() => ro.disconnect());
    });
    // popped-out windows mirror our compile state
    effect(() => {
      this.compiler.snapshot();
      this.layout.popped();
      untracked(() => this.popout.broadcast());
    });
    // a click on an error in a popped-out ink log brings it up here
    this.popout.jump.pipe(takeUntilDestroyed()).subscribe((d) => {
      window.focus();
      this.jump(d);
    });
    window.addEventListener('keydown', this.onKeyCapture, true);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('keydown', this.onKeyCapture, true));
    inject(DestroyRef).onDestroy(() => {
      this.modals.scrollContext.set(null);
      this.popout.detach();
      this.collab.disconnect();
    });
  }

  /** Learn our role first (404 for strangers), then join the room. */
  private async enter(id: string): Promise<void> {
    this.scroll.set(null);
    try {
      this.scroll.set(await this.scrolls.get(id));
      this.collab.connect(id);
      this.popout.attach(id);
      this.scrolls.members(id).then((ms) => this.memberNames.set(ms.map((m) => m.displayName)), () => undefined);
    } catch (e) {
      // the session ended: the "session ended" screen takes over; there is nothing to redirect
      if ((e as { status?: number })?.status === 401) return;
      // a scroll that exists but is not yours: the "You need a seat" page; anything else: not found
      const door = await this.scrolls.door(id).catch(() => null);
      await this.router.navigateByUrl(door && !door.member ? `/request/${id}` : '/404', { replaceUrl: true });
    }
  }

  protected readonly meInitials = computed(() => this.initials(this.collab.me().name));

  protected readonly look = assistantLook;

  protected initials(name: string): string {
    return name.replace(/^(Sir|Dame|Lady|Brother)\s+/i, '').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  }

  protected onCreate(path: string): void {
    const error = this.collab.createFile(path.trim());
    this.createError.set(error);
    if (!error) this.tree()?.close();
  }

  // ---- panel layout
  protected resetSize(key: keyof LayoutSizes): void {
    this.layout.setSize(key, DEFAULT_LAYOUT.sizes[key]);
  }

  protected onPanelToggle(id: PanelId): void {
    // hiding a panel that lives in its own window closes that window first
    if ((id === 'preview' || id === 'log') && this.layout.popped()[id] && this.layout.visible()[id]) this.popout.dock(id);
    this.layout.toggle(id);
  }

  protected onPopOut(id: PanelId): void {
    if (id === 'tree') {
      const w = window.open(`/scroll/${encodeURIComponent(this.id())}/hall`, `quill-hall-${this.id()}`, 'popup=yes,width=1180,height=820');
      if (!w) this.say('Your browser blocked the new window. Allow pop-ups for this site and try again.', true);
      return;
    }
    if (id !== 'preview' && id !== 'log') return;
    if (this.layout.popped()[id]) return this.popout.dock(id);
    if (!this.popout.open(id)) this.say('Your browser blocked the new window. Allow pop-ups for this site and try again.', true);
  }

  protected resetLayout(): void {
    this.layout.reset();
    this.say('Back to the default layout.');
  }

  protected saveLayout(): void {
    if (this.layout.save()) this.say('Saved as your tavern layout. It will be here next time.');
    else this.say('Your browser would not keep the layout (is storage blocked?).', true);
  }

  private say(text: string, bad = false): void {
    clearTimeout(this.toastTimer);
    this.toast.set({ text, bad });
    this.toastTimer = setTimeout(() => this.toast.set(null), 4500);
  }

  protected toggleHistory(): void {
    const open = !this.showHistory();
    this.showHistory.set(open);
    if (open) this.showComments.set(false);
    else this.viewing.set(null);
  }

  // ---- margin notes
  protected toggleComments(open = !this.showComments()): void {
    this.showComments.set(open);
    if (open && this.showHistory()) this.toggleHistory();
  }

  /** The gutter marker of a note was clicked, or ⌘/Ctrl+Alt+M was pressed. */
  protected focusNote(id: string): void {
    this.toggleComments(true);
    this.selectedNote.set(id);
  }

  protected newNote(): void {
    this.toggleComments(true);
    setTimeout(() => this.commentsPanel()?.focusComposer(), 60);
  }

  protected postNote(text: string): void {
    const file = this.collab.activeFile();
    const range = this.editor()?.selectionRange();
    if (!file || !range) return this.say('Open a file in the editor first, then write the note.', true);
    const id = this.comments.add(file, range.from, range.to, text);
    if (!id) return this.say('That note could not be saved.', true);
    this.selectedNote.set(id);
    this.commentsPanel()?.clearComposer();
  }

  protected openNote(id: string): void {
    this.selectedNote.set(id);
    const l = this.comments.located().find((x) => x.thread.id === id);
    if (!l || l.from === null || l.to === null) return;
    if (this.viewing()) this.backToNow();
    const switching = l.thread.file !== this.collab.activeFile();
    if (switching) this.openText(l.thread.file);
    setTimeout(() => this.editor()?.revealRange(l.from!, l.to!), switching ? 80 : 0);
  }

  protected replyNote(e: { id: string; text: string }): void {
    if (!this.comments.reply(e.id, e.text)) this.say('That reply could not be saved.', true);
  }

  protected onView(v: ViewedVersion | null): void {
    this.nowFiles.set(v ? this.collab.sources() : new Map());
    this.viewing.set(v);
  }

  protected backToNow(): void {
    this.viewing.set(null);
    this.history()?.reset();
  }

  protected compareAgain(): void {
    this.nowFiles.set(this.collab.sources());
  }

  /** A folder is a table: shared with everyone, and it appears in the Tavern Hall map too. */
  protected onCreateFolder(path: string): void {
    const error = this.collab.createTable(path);
    if (error) return this.say(error, true);
    this.say(`A new folder, ${path}/, is ready. Put files in it from the list or the Tavern Hall.`);
  }

  protected openText(path: string): void {
    this.activeAsset.set(null);
    this.collab.openFile(path);
  }

  protected openAsset(path: string): void {
    this.portraitError.set(null);
    this.activeAsset.set(path);
  }

  /** Upload pictures and PDFs; returns the paths that made it. Problems are shown under the Tavern Hall list. */
  private async uploadFiles(files: File[]): Promise<string[]> {
    const room = this.collab.roomId();
    if (!room || !this.canEdit()) return [];
    const problems: string[] = [];
    const taken = [...this.collab.files(), ...this.collab.assets().map((a) => a.path)];
    const done: string[] = [];
    for (const file of files) {
      const bad = checkUpload(file);
      if (bad) {
        problems.push(bad);
        continue;
      }
      const path = suggestAssetPath(file.name, taken);
      this.uploading.update((n) => n + 1);
      try {
        await this.assetsApi.upload(room, path, file);
        taken.push(path);
        done.push(path);
      } catch (e) {
        problems.push(`${file.name}: ${apiMessage(e)}`);
      } finally {
        this.uploading.update((n) => n - 1);
      }
    }
    this.uploadMessage.set(problems.length ? problems.join(' ') : null);
    return done;
  }

  /** Files added through the Tavern Hall list: seated there, and shown in the portrait panel. */
  protected async upload(files: File[]): Promise<void> {
    const done = await this.uploadFiles(files);
    const last = done.at(-1);
    if (last) this.openAsset(last);
  }

  // ---- dragging pictures into the document: always ask how to place them
  protected readonly editorDrag = signal(false);
  private insertQueue: string[] = [];

  private isFileDrag(e: DragEvent): boolean {
    const types = Array.from(e.dataTransfer?.types ?? []);
    return types.includes('Files') || types.includes(ASSET_DRAG_TYPE);
  }

  protected onEditorDragOver(e: DragEvent): void {
    if (!this.isFileDrag(e)) return; // plain text drags stay the editor's own business
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = this.canEdit() ? 'copy' : 'none';
    this.editorDrag.set(this.canEdit());
  }

  protected onEditorDragLeave(e: DragEvent): void {
    if (e.relatedTarget && (e.currentTarget as Node).contains(e.relatedTarget as Node)) return;
    this.editorDrag.set(false);
  }

  /**
   * A picture dropped on the editor (a file from the desktop, or one dragged out of the Tavern Hall) is put
   * at the drop point only after the "Hang a Portrait" dialog has asked how: width, caption, label.
   */
  protected async onEditorDrop(e: DragEvent): Promise<void> {
    if (!this.isFileDrag(e)) return;
    e.preventDefault(); // otherwise the browser would open the file in place of the page
    this.editorDrag.set(false);
    if (!this.canEdit()) return this.say('Readers cannot add images to the document.', true);
    this.editor()?.placeCaretAt(e.clientX, e.clientY);
    const paths: string[] = [];
    const known = e.dataTransfer?.getData(ASSET_DRAG_TYPE);
    if (known && this.collab.assets().some((a) => a.path === known)) paths.push(known);
    const files = Array.from(e.dataTransfer?.files ?? []);
    const pictures = files.filter((f) => isAssetName(f.name));
    if (files.length > pictures.length) this.say('Only pictures and PDFs can be dropped into the document. Use the Tavern Hall to add other files.', true);
    if (pictures.length) paths.push(...(await this.uploadFiles(pictures)));
    const usable = paths.filter(isLatexIncludable);
    if (paths.length > usable.length) this.say('LaTeX cannot include .svg or .webp pictures directly; convert them to png, jpg or pdf first.', true);
    if (!usable.length) return;
    this.insertQueue = usable;
    this.nextInsert();
  }

  /** Ask about the next dropped picture (the dialog's close brings us back for the one after). */
  protected nextInsert(): void {
    const path = this.insertQueue.shift();
    if (path) this.openInsert(path);
  }

  protected async replaceAsset(e: { path: string; file: File }): Promise<void> {
    const room = this.collab.roomId();
    if (!room) return;
    this.portraitError.set(null);
    if (extOf(e.file.name) !== extOf(e.path)) {
      this.portraitError.set(`Replace it with another .${extOf(e.path)} file, or remove it and upload the new one.`);
      return;
    }
    const bad = checkUpload(e.file);
    if (bad) return void this.portraitError.set(bad);
    try {
      await this.assetsApi.upload(room, e.path, e.file);
    } catch (err) {
      this.portraitError.set(apiMessage(err));
    }
  }

  protected async removeAsset(path: string): Promise<void> {
    const room = this.collab.roomId();
    if (!room) return;
    try {
      await this.assetsApi.remove(room, path);
      if (this.activeAsset() === path) this.activeAsset.set(null);
    } catch (err) {
      this.portraitError.set(apiMessage(err));
    }
  }

  protected openInsert(path?: string): void {
    if (!this.canEdit()) return;
    this.insertWhere.set(`${this.collab.activeFile() ?? 'file'} line ${this.editor()?.cursorLine() ?? 1}`);
    this.insertDialog()?.open(path);
  }

  protected insertSnippet(snippet: string): void {
    this.editor()?.insertAtCursor(snippet);
  }

  protected async compile(): Promise<void> {
    if (!this.canEdit()) return;
    const room = this.collab.roomId();
    if (!room) return;
    const open = this.collab.activeFile();
    await this.compiler.compile(room, open && open.endsWith('.tex') ? open : null);
    const built = this.compiler.pdfBuiltAt();
    if (this.compiler.state() === 'ok' && built) this.collab.announceBuild(built);
  }

  /** Double-click on the preview: put the caret on the source line that made that spot. */
  protected async onPdfLocate(p: PdfPoint): Promise<void> {
    const room = this.collab.roomId();
    if (!room) return;
    const hit = await this.compiler.locate(room, p.page, p.x, p.y);
    if (hit) this.jump({ severity: 'info', file: hit.file, line: hit.line, message: '' });
    else this.toasts.show('Cannot tell where that came from. Compile again, then try a spot with text.', 'bad');
  }

  protected jump(d: Diagnostic): void {
    if (!d.file) return;
    this.collab.openFile(d.file);
    // let the editor swap to the file's Y.Text before moving the caret
    setTimeout(() => this.editor()?.revealLine(d.line ?? 1), 0);
  }

  protected openAiChanges(): void {
    void this.aiChanges()?.open();
  }

  protected openAiEdits(): void {
    void this.aiDialog()?.open();
  }

  /** The owner changed how assistants' edits arrive: fetch the scroll again so the page knows. */
  protected async reloadScroll(): Promise<void> {
    try {
      this.scroll.set(await this.scrolls.get(this.id()));
    } catch {
      /* the page keeps what it had */
    }
  }

  protected openShare(): void {
    void this.shareDialog()?.open();
  }

  // ---- the menu bar: File, Edit, Format, View, Insert, Tools, Help
  protected readonly renameValue = signal('');
  protected readonly renameError = signal<string | null>(null);

  protected newScroll(): void {
    void this.router.navigate(['/'], { queryParams: { new: 1 } });
  }

  /** Every file of the scroll, pictures and empty folders included, as one .zip download. */
  protected async exportZip(): Promise<void> {
    const room = this.collab.roomId();
    if (!room) return;
    this.say('Packing the scroll…');
    try {
      const texts = this.collab.files().map((path) => ({ path, text: this.collab.fileText(path) ?? '' }));
      let missing = 0;
      const assets: Array<{ path: string; bytes: Uint8Array }> = [];
      for (const a of this.collab.assets()) {
        try {
          const res = await fetch(this.assetsApi.url(room, a.path, a.sha256), { credentials: 'same-origin' });
          if (!res.ok) throw new Error(String(res.status));
          assets.push({ path: a.path, bytes: new Uint8Array(await res.arrayBuffer()) });
        } catch {
          missing++;
        }
      }
      const zip = buildArchive(texts, assets, this.collab.tables());
      const url = URL.createObjectURL(new Blob([zip.slice().buffer as ArrayBuffer], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = archiveName(this.scroll()?.title ?? 'scroll');
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      this.say(missing ? `Exported, but ${missing} ${missing === 1 ? 'picture' : 'pictures'} could not be included.` : `Exported ${texts.length + assets.length} files.`, missing > 0);
    } catch {
      this.say('The scroll could not be exported. Try again.', true);
    }
  }

  protected pickZip(): void {
    this.zipInput()?.nativeElement.click();
  }

  /** Unpack a .zip into this scroll (folders become tables), with the same progress screen as in the hall. */
  protected async onZip(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.canEdit()) return;
    const summary = await this.importer()?.run(file, '');
    if (summary) this.say(`Imported ${summary.seated} ${summary.seated === 1 ? 'file' : 'files'}${summary.skipped.length ? `, ${summary.skipped.length} skipped` : ''}.`, summary.failed > 0);
  }

  protected openRename(): void {
    this.renameValue.set(this.scroll()?.title ?? '');
    this.renameError.set(null);
    this.renameDlg()?.nativeElement.showModal();
  }

  protected async saveTitle(e: Event): Promise<void> {
    e.preventDefault();
    const title = this.renameValue().trim();
    if (!title) return void this.renameError.set('A scroll needs a name.');
    try {
      await this.scrolls.rename(this.id(), title);
      this.renameDlg()?.nativeElement.close();
      await this.reloadScroll();
    } catch (err) {
      this.renameError.set(apiMessage(err));
    }
  }

  private text(name: Parameters<CodeEditorComponent['textCommand']>[0]): void {
    this.editor()?.textCommand(name);
  }

  protected readonly menus = computed<Menu[]>(() => {
    const edit = this.canEdit();
    const owner = this.role() === 'owner';
    const p = this.prefs.prefs();
    const L = this.layout.visible();
    const waiting = this.collab.pendingEdits();
    const hasFile = !!this.collab.activeFile() && !this.activeAsset();
    const typing = edit && hasFile;
    return [
      {
        id: 'file',
        label: 'File',
        items: [
          { label: 'New scroll…', run: () => this.newScroll() },
          { label: 'Open scroll…', note: 'the quest board', run: () => void this.router.navigateByUrl('/') },
          { label: 'New file', disabled: !edit, separator: true, run: () => this.withTree((t) => t.startFile()) },
          { label: 'New folder', disabled: !edit, run: () => this.withTree((t) => t.startFolder()) },
          { label: 'Upload pictures or PDFs…', disabled: !edit, run: () => this.withTree((t) => t.chooseUpload()) },
          { label: 'Import a .zip…', disabled: !edit, run: () => this.pickZip() },
          { label: 'Export as .zip', separator: true, run: () => void this.exportZip() },
          { label: 'Download the PDF', run: () => this.downloadPdf() },
          { label: 'Rename scroll…', disabled: !owner, separator: true, run: () => this.openRename() },
          { label: 'Share…', run: () => this.openShare() },
          { label: 'Version history', checked: this.showHistory(), run: () => this.toggleHistory() },
          { label: 'Back to the quest board', separator: true, run: () => void this.router.navigateByUrl('/') },
        ],
      },
      {
        id: 'edit',
        label: 'Edit',
        items: [
          { label: 'Undo', keys: '⌘Z', disabled: !typing, run: () => this.text('undo') },
          { label: 'Redo', keys: '⌘⇧Z', disabled: !typing, run: () => this.text('redo') },
          { label: 'Select all', keys: '⌘A', disabled: !hasFile, run: () => this.text('selectAll') },
          { label: 'Find and replace…', keys: '⌘F', separator: true, run: () => this.openSearch() },
          { label: 'Find next', keys: '⌘G', run: () => this.stepSearch(1) },
          { label: 'Find previous', keys: '⌘⇧G', run: () => this.stepSearch(-1) },
          { label: 'Comment or uncomment lines', keys: '⌘/', disabled: !typing, separator: true, run: () => this.text('comment') },
          { label: 'New margin note', keys: '⌘⌥M', disabled: !edit, run: () => this.newNote() },
          { label: 'AI assistant edits…', note: waiting ? `${waiting} waiting` : undefined, separator: true, run: () => this.openAiEdits() },
        ],
      },
      {
        id: 'format',
        label: 'Format',
        items: [
          { label: 'Bold', keys: '⌘B', disabled: !typing, run: () => this.text('bold') },
          { label: 'Italic', keys: '⌘I', disabled: !typing, run: () => this.text('italic') },
          { label: 'Underline', keys: '⌘U', disabled: !typing, run: () => this.text('underline') },
          { label: 'Emphasis', keys: '⌘⇧E', disabled: !typing, run: () => this.text('emph') },
          { label: 'Monospace', keys: '⌘E', disabled: !typing, run: () => this.text('mono') },
          { label: 'Superscript', keys: '⌘.', disabled: !typing, separator: true, run: () => this.text('sup') },
          { label: 'Subscript', keys: '⌘,', disabled: !typing, run: () => this.text('sub') },
          { label: 'Bulleted list', keys: '⌘⇧8', disabled: !typing, separator: true, run: () => this.text('itemize') },
          { label: 'Numbered list', keys: '⌘⇧7', disabled: !typing, run: () => this.text('enumerate') },
        ],
      },
      {
        id: 'view',
        label: 'View',
        items: [
          { label: 'Tavern Hall panel', keys: '⌘⇧B', checked: L.tree, run: () => this.onPanelToggle('tree') },
          { label: 'Scroll Preview', checked: L.preview, run: () => this.onPanelToggle('preview') },
          { label: 'Ink Log', checked: L.log, run: () => this.onPanelToggle('log') },
          { label: 'Margin notes', checked: this.showComments(), run: () => this.toggleComments() },
          { label: 'Open the Tavern Hall', keys: '⌘⇧H', separator: true, run: () => void this.router.navigate(['/scroll', this.id(), 'hall']) },
          { label: 'Open the Tavern Hall as a list', run: () => void this.router.navigate(['/scroll', this.id(), 'hall'], { queryParams: { mode: 'list' } }) },
          { label: 'Bigger text', separator: true, run: () => this.prefs.update({ fontSize: p.fontSize + 1 }) },
          { label: 'Smaller text', run: () => this.prefs.update({ fontSize: p.fontSize - 1 }) },
          { label: 'Line numbers', checked: p.lineNumbers, run: () => this.prefs.update({ lineNumbers: !p.lineNumbers }) },
          { label: 'Wrap long lines', checked: p.wrapLines, run: () => this.prefs.update({ wrapLines: !p.wrapLines }) },
          ...THEMES.map((t, i) => ({ label: `Theme: ${t.name}`, checked: p.theme === t.id, separator: i === 0, run: () => this.prefs.update({ theme: t.id }) })),
          { label: 'Save this panel layout', separator: true, run: () => this.saveLayout() },
          { label: 'Reset the panel layout', run: () => this.resetLayout() },
        ],
      },
      {
        id: 'insert',
        label: 'Insert',
        items: [
          { label: 'Image…', disabled: !edit, run: () => this.openInsert() },
          { label: 'Section', keys: '⌘⌥1', disabled: !typing, separator: true, run: () => this.text('section') },
          { label: 'Subsection', keys: '⌘⌥2', disabled: !typing, run: () => this.text('subsection') },
          { label: 'Subsubsection', keys: '⌘⌥3', disabled: !typing, run: () => this.text('subsubsection') },
          { label: 'Bulleted list', keys: '⌘⇧8', disabled: !typing, separator: true, run: () => this.text('itemize') },
          { label: 'Numbered list', keys: '⌘⇧7', disabled: !typing, run: () => this.text('enumerate') },
        ],
      },
      {
        id: 'tools',
        label: 'Tools',
        items: [
          { label: 'Compile', keys: '⌘↵', disabled: !edit, run: () => void this.compile() },
          { label: 'Auto-compile', checked: p.autoCompile, run: () => this.prefs.update({ autoCompile: !p.autoCompile }) },
          { label: this.recorder.recording() ? 'Stop recording' : 'Record a session', note: this.recorder.recording() ? undefined : 'a timelapse', disabled: !this.recorder.recording() && !this.collab.synced(), separator: true, run: () => (this.recorder.recording() ? void this.stopRecording() : this.startRecording()) },
          { label: 'Watch the last recording', note: this.recorder.last() ? 'kept 30 min' : undefined, disabled: !this.recorder.last(), run: () => this.watchLast() },
          { label: 'Export the last recording', disabled: !this.recorder.last(), run: () => void this.exportRecording() },
          { label: 'Discard the last recording', disabled: !this.recorder.last(), run: () => void this.recorder.discard() },
          { label: 'Watch a session from a file…', run: () => this.pickSession() },
          { label: 'AI assistant edits…', note: waiting ? `${waiting} waiting` : undefined, separator: true, run: () => this.openAiEdits() },
          { label: 'Tavern settings…', run: () => this.modals.openSettings() },
          { label: 'Command menu', keys: '⌘K', separator: true, run: () => this.openPalette() },
        ],
      },
      {
        id: 'help',
        label: 'Help',
        items: [
          { label: 'Take the tour', run: () => setTimeout(() => this.tour.start(), 80) },
          { label: 'Keyboard shortcuts', run: () => this.palette()?.open('keys') },
          { label: 'Command menu', keys: '⌘K', run: () => this.openPalette() },
        ],
      },
    ];
  });

  // ---- session recording: a timelapse of the writing
  protected startRecording(): void {
    if (this.recorder.start(this.scroll()?.title ?? 'scroll')) this.toasts.show('Recording. The timer is at the top of the page; press Stop when you are done.', 'ok');
    else this.toasts.show('Wait until the scroll has finished loading, then try again.', 'bad');
  }

  protected async stopRecording(): Promise<void> {
    if (await this.recorder.stop()) this.toasts.show('Recording saved. It stays in this browser for 30 minutes: watch or export it from Tools.', 'ok', 9000);
  }

  protected watchLast(): void {
    const last = this.recorder.last();
    if (last) this.timelapse()?.open(last.session);
  }

  protected async exportRecording(): Promise<void> {
    const name = await this.recorder.exportLast();
    if (name) this.toasts.show(`Saved ${name}. Anyone can open it with "Watch a session from a file".`, 'ok', 8000);
  }

  protected pickSession(): void {
    this.sessionInput()?.nativeElement.click();
  }

  /** Open a recording saved earlier (checked thoroughly: it is a file from outside). */
  protected async onSession(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      this.timelapse()?.open(await decodeSession(new Uint8Array(await file.arrayBuffer())));
    } catch (e) {
      this.toasts.show(e instanceof Error ? e.message : 'That file could not be opened.', 'bad', 9000);
    }
  }

  // ---- search and replace (Ctrl/⌘+F)
  protected readonly searchOpen = signal(false);
  protected readonly searchPrefill = signal('');
  protected readonly searchFocus = signal(0);

  /** Open the panel, or (when it is open) put the caret back in its search field. */
  protected openSearch(prefill = ''): void {
    this.searchPrefill.set(prefill);
    this.searchFocus.update((n) => n + 1);
    this.searchOpen.set(true);
  }

  protected closeSearch(): void {
    this.searchOpen.set(false);
    this.editor()?.focusText();
  }

  /** The matches in the open file, for lighting them up in the text. */
  protected readonly searchMarksHere = computed(() => {
    const marks = this.searchPanel()?.marks();
    const file = this.collab.activeFile();
    const ranges = marks && file ? marks.ranges[file] : undefined;
    if (!marks || !file || !ranges) return null;
    const cur = marks.current && marks.current.path === file ? { from: marks.current.from, to: marks.current.to } : null;
    return { ranges, current: cur };
  });

  /** Show a match: open its file if needed, then select it. */
  protected onSearchJump(h: Hit): void {
    const here = this.collab.activeFile() === h.path && !this.activeAsset();
    if (!here) {
      this.activeAsset.set(null);
      this.collab.openFile(h.path);
    }
    setTimeout(() => this.editor()?.selectRange(h.from, h.to), here ? 0 : 150);
  }

  protected stepSearch(dir: 1 | -1): void {
    if (!this.searchOpen()) return this.openSearch();
    this.searchPanel()?.step(dir);
  }

  // ---- the command menu (⌘K / Ctrl+K)
  protected openPalette(): void {
    this.palette()?.open();
  }

  /** Show the Tavern Hall panel (if it was hidden), then run `fn` once it is on the page. */
  private withTree(fn: (t: FileTreeComponent) => void): void {
    this.layout.setVisible('tree', true);
    setTimeout(() => {
      const t = this.tree();
      if (t) fn(t);
    }, 60);
  }

  private downloadPdf(): void {
    const url = this.compiler.pdfUrl();
    if (!url) return void this.toasts.show('Nothing has been inked yet. Compile first.');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scroll.pdf';
    a.click();
  }

  protected readonly paletteItems = computed<PaletteItem[]>(() => {
    const edit = this.canEdit();
    const p = this.prefs.prefs();
    const items: PaletteItem[] = [];
    const add = (id: string, icon: string, title: string, hint: string, run: () => void, keys?: string, section: PaletteItem['section'] = 'Actions') => items.push({ id, section, icon, title, hint, run, keys: keys && shortcutLabel(keys) });
    const flip = (id: string, icon: string, label: string, on: boolean, key: Parameters<PreferencesService['update']>[0]) =>
      add(id, icon, `${on ? 'Turn off' : 'Turn on'} ${label}`, 'Kept in this browser, for you only', () => this.prefs.update(key));

    // the scroll
    if (edit) add('compile', '⚒', 'Compile the scroll', `Ink ${this.collab.activeFile()?.endsWith('.tex') ? this.collab.activeFile() : 'the main file'} into a PDF`, () => void this.compile(), '⌘↵');
    add('search', '⌕', 'Search and replace', 'Find (and change) words in every file of the scroll', () => this.openSearch(), '⌘F');
    add('rec', '●', this.recorder.recording() ? 'Stop recording' : 'Record a session', this.recorder.recording() ? 'Keep the timelapse for 30 minutes' : 'Make a timelapse of the writing (up to an hour)', () => (this.recorder.recording() ? void this.stopRecording() : this.startRecording()));
    if (this.recorder.last()) {
      add('rec-watch', '▶', 'Watch the last recording', 'The timelapse, sped up', () => this.watchLast());
      add('rec-export', '⤓', 'Export the last recording', 'Save it as a file to keep or share', () => void this.exportRecording());
    }
    add('rec-file', '▶', 'Watch a session from a file', 'Open a timelapse someone saved', () => this.pickSession());
    add('export-zip', '⤓', 'Export as .zip', 'Every file and picture of the scroll in one archive', () => void this.exportZip());
    if (edit) add('import-zip', '⇪', 'Import a .zip', 'Unpack an archive into this scroll (folders become tables)', () => this.pickZip());
    add('new-scroll', '＋', 'New scroll', 'Start another document', () => this.newScroll());
    if (this.role() === 'owner') add('rename', '✎', 'Rename scroll', 'Change the title of this scroll', () => this.openRename());
    add('download', '⤓', 'Download the PDF', 'Save the latest inked scroll', () => this.downloadPdf());
    add('ai', '✦', 'AI assistant edits', `${this.collab.pendingEdits() ? this.collab.pendingEdits() + ' waiting for you · ' : ''}Review edits from assistants, or let them apply`, () => this.openAiEdits());
    add('share', '✉', 'Share this scroll', 'Invite scribes, or copy a link for editing or viewing', () => this.openShare());
    add('history', '⏲', 'Version history', 'Time travel: see and restore older versions', () => this.toggleHistory());
    add('notes', '✎', 'Margin notes', 'Show or hide the notes panel', () => this.toggleComments());
    if (edit) add('newnote', '✎', 'New margin note', 'Write a note on the selected words', () => this.newNote());
    if (edit) add('insert', '▣', 'Insert an image', 'Hang a picture at the cursor', () => this.openInsert());
    if (edit && this.collab.activeFile()?.endsWith('.tex') && this.collab.activeFile() !== this.collab.mainFile()) {
      const open = this.collab.activeFile()!;
      add('main', '★', `Make ${open} the main file`, 'The file the scroll starts from', () => {
        if (this.collab.setMain(open)) this.toasts.show(`${open} is now the main file.`, 'ok');
      });
    }

    // writing: the same commands as the keys
    if (edit) {
      const text = (id: string, icon: string, title: string, hint: string, keys: string) => add('t-' + id, icon, title, hint, () => this.editor()?.textCommand(id as never), keys);
      text('bold', 'B', 'Bold', 'Wrap the selection in \\textbf (\\mathbf in math)', '⌘B');
      text('italic', 'I', 'Italic', 'Wrap the selection in \\textit', '⌘I');
      text('underline', 'U', 'Underline', 'Wrap the selection in \\underline', '⌘U');
      text('emph', 'E', 'Emphasis', 'Wrap the selection in \\emph', '⌘⇧E');
      text('mono', '‹›', 'Monospace', 'Wrap the selection in \\texttt', '⌘E');
      text('sup', 'x²', 'Superscript', '^{} in math, \\textsuperscript in text', '⌘.');
      text('sub', 'x₂', 'Subscript', '_{} in math, \\textsubscript in text', '⌘,');
      text('comment', '%', 'Comment or uncomment lines', 'Switch the selected lines with %', '⌘/');
      text('itemize', '•', 'Bulleted list', 'An itemize list from the selected lines', '⌘⇧8');
      text('enumerate', '1.', 'Numbered list', 'An enumerate list from the selected lines', '⌘⇧7');
      text('section', '§', 'Make the line a section', 'Again to turn it back into text', '⌘⌥1');
      text('subsection', '§', 'Make the line a subsection', 'Again to turn it back into text', '⌘⌥2');
      text('subsubsection', '§', 'Make the line a subsubsection', 'Again to turn it back into text', '⌘⌥3');
    }

    // the Tavern Hall
    add('hall', '⌂', 'Open the Tavern Hall', 'Browse every table and member', () => void this.router.navigate(['/scroll', this.id(), 'hall']), '⌘⇧H');
    add('hall-list', '☰', 'Open the Tavern Hall as a list', 'Sorted by table', () => void this.router.navigate(['/scroll', this.id(), 'hall'], { queryParams: { mode: 'list' } }));
    add('hall-window', '⧉', 'Open the Tavern Hall in its own window', 'Keep the map beside your writing', () => this.onPopOut('tree'));
    if (edit) {
      add('newfile', '＋', 'New file', 'Start a .tex file in the Tavern Hall', () => this.withTree((t) => t.startFile()));
      add('newfolder', '＋', 'New folder', 'A folder is a table in the Tavern Hall', () => this.withTree((t) => t.startFolder()));
      add('upload', '⇪', 'Upload pictures or PDFs', 'Carry them to the Tavern Hall', () => this.withTree((t) => t.chooseUpload()));
    }

    // panels
    const L = this.layout.visible();
    add('p-tree', '▤', 'Toggle Tavern Hall panel', 'Hide or show the file tree', () => this.onPanelToggle('tree'), '⌘⇧B');
    add('p-preview', '▥', 'Toggle Scroll Preview', L.preview ? 'Hide the PDF preview' : 'Show the PDF preview', () => this.onPanelToggle('preview'));
    add('p-log', '▭', 'Toggle Ink Log', L.log ? 'Hide the compile messages' : 'Show the compile messages', () => this.onPanelToggle('log'));
    add('pop-preview', '⧉', 'Pop the Scroll Preview out', 'Move it to its own window', () => this.onPopOut('preview'));
    add('pop-log', '⧉', 'Pop the Ink Log out', 'Move it to its own window', () => this.onPopOut('log'));
    add('layout-save', '▦', 'Save this panel layout', 'Keep it as your tavern layout', () => this.saveLayout());
    add('layout-reset', '▦', 'Reset the panel layout', 'Back to the default arrangement', () => this.resetLayout());

    // how you write
    flip('auto', '↻', 'auto-compile', p.autoCompile, { autoCompile: !p.autoCompile });
    flip('warn', '⚠', 'warnings in the Ink Log', p.showWarnings, { showWarnings: !p.showWarnings });
    flip('lines', '#', 'line numbers', p.lineNumbers, { lineNumbers: !p.lineNumbers });
    flip('wrap', '↩', 'wrapping of long lines', p.wrapLines, { wrapLines: !p.wrapLines });
    flip('close', '{}', 'auto-closing brackets', p.autoClose, { autoClose: !p.autoClose });
    flip('spell', 'Aa', 'spell-check', p.spellcheck, { spellcheck: !p.spellcheck });
    flip('cursors', '▏', "other scribes' cursors", p.showOthersCursors, { showOthersCursors: !p.showOthersCursors });
    add('bigger', 'A+', 'Bigger editor text', `Now ${p.fontSize}px`, () => this.prefs.update({ fontSize: p.fontSize + 1 }));
    add('smaller', 'A−', 'Smaller editor text', `Now ${p.fontSize}px`, () => this.prefs.update({ fontSize: p.fontSize - 1 }));
    for (const t of THEMES) {
      if (t.id !== p.theme) add('theme-' + t.id, '◐', `Theme: ${t.name}`, t.blurb, () => this.prefs.update({ theme: t.id }));
    }

    // you and the tavern
    add('settings', '⚙', 'Tavern settings', 'Compiler, editor and collaboration', () => this.modals.openSettings());
    add('settings-editor', '⚙', 'Editor settings', 'Font, size and behaviour', () => this.modals.openSettings('editor'));
    add('profile', '☺', 'Your tavern profile', 'Name, colour and look of the tavern', () => this.modals.openProfile());
    add('security', '⚿', 'Password and sessions', 'Change your password, see where you are signed in', () => this.modals.openProfile('security'));
    add('notify', '♪', 'Notification preferences', 'Mentions, bell and quiet hours', () => this.modals.openProfile('notifications'));
    add('tour', '☞', 'Take the tour', 'A quick walk round the tavern, step by step', () => setTimeout(() => this.tour.start(), 80));
    add('board', '←', 'Back to the quest board', 'Every scroll you scribe', () => void this.router.navigateByUrl('/'));
    add('signout', '⏻', 'Sign out', 'Leave the tavern on this device', () => void this.auth.logout().then(() => this.router.navigateByUrl('/login')));

    // files
    for (const path of this.collab.files()) {
      add('file:' + path, '❡', path, `${tableLabel(path)} · ${path === this.collab.mainFile() ? 'main file' : 'scroll source'}`, () => {
        this.activeAsset.set(null);
        this.collab.openFile(path);
      }, undefined, 'Files');
    }
    for (const a of this.collab.assets()) {
      add('asset:' + a.path, '▣', a.path, `${tableLabel(a.path)} · ${a.mime.startsWith('image/') ? 'image' : 'PDF'} · ${formatBytes(a.size)}`, () => this.openAsset(a.path), undefined, 'Files');
    }

    // help
    const help = (id: string, q: string, a: string, hint: string) => add('help:' + id, '?', q, hint, () => this.toasts.show(a, 'info', 12000), undefined, 'Help');
    help('table', 'How do I add a new table?', 'A table is a folder. Use “+ Folder” in the Tavern Hall list, or “New Table” in the full Tavern Hall. Files seated at it live inside that folder.', 'Tavern Hall guide');
    help('invite', 'How do I invite someone?', 'Press Share. Invite by email, or make a link for editing or a link for viewing and send it to anyone.', 'Sharing guide');
    help('picture', 'How do I put a picture in my scroll?', 'Drop it on the editor, or open it in the Tavern Hall and press Insert Image. You choose how it is placed.', 'Pictures guide');
    help('old', 'How do I go back to an older version?', 'Open Version history, pick a snapshot to see what changed, and press Restore.', 'History guide');
    help('move', 'How do I rearrange the tables?', 'In the full Tavern Hall, drag a table by its top. Tables push each other aside and never overlap; the places are saved for everyone.', 'Tavern Hall guide');
    help('keys', 'Which keys can I use?', '⌘K or Ctrl+K opens this menu. ⌘↵ compiles. ⌘⇧B hides the Tavern Hall panel. ⌘⇧H opens the Tavern Hall. ⌘F searches and replaces across every file. In the editor: ⌘B bold, ⌘I italic, ⌘U underline, ⌘. (or ⌘⌥.) superscript, ⌘, (or ⌘⌥,) subscript, ⌘/ comment lines. In the menu, ⌥1–4 filter too (Safari keeps ⌘1–4). Ctrl works in place of ⌘ on Windows and Linux.', 'Shortcuts');
    return items;
  });

  /**
   * Page-wide keys. Registered on the capture phase of the window so they win over the browser's own meaning
   * of the same keys (⌘K / Ctrl+K searches in some browsers, Ctrl+B opens bookmarks in Firefox).
   */
  private readonly onKeyCapture = (e: KeyboardEvent): void => this.onKey(e);

  protected onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    if (this.tour.active()) return; // the tour has the keyboard
    if (this.palette()?.isOpen && !(mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k')) return; // the menu has the keyboard (its own ⌘↵ must not compile)
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.palette()?.toggle();
    } else if (mod && e.key === 'Enter') {
      e.preventDefault();
      void this.compile();
    } else if (mod && !e.altKey && e.key.toLowerCase() === 'f' && !(e.target as HTMLElement | null)?.closest?.('.cm-editor')) {
      e.preventDefault(); // (inside the text the editor's own key does the same, with the selected words)
      this.openSearch();
    } else if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
      e.preventDefault(); // (plain ⌘B is bold in the editor)
      this.onPanelToggle('tree');
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      void this.router.navigate(['/scroll', this.id(), 'hall']);
    }
  }
}
