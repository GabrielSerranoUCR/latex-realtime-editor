import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, computed, effect, input, output, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TreeNode, buildFileTree } from '../../../core/collab/file-tree';
import { joinPath, tableNameError } from '../../../core/collab/tavern';
import { ACCEPT_ATTR, ASSET_DRAG_TYPE, AssetInfo, formatBytes } from '../../../core/latex/figure';

/** The "Tavern Hall" side panel: files grouped by table (directory). */
@Component({
  selector: 'qq-file-tree',
  template: `
    <div class="head">
      <span class="eyebrow">Tavern Hall</span>
      @if (canEdit()) {
        <span class="tools">
          <button class="icon" type="button" title="Upload images or PDFs" aria-label="Upload images or PDFs" (click)="picker.click()">⇪</button>
        </span>
      }
      <input #picker type="file" hidden multiple [accept]="accept" (change)="picked(picker)" />
    </div>

    @if (canEdit()) {
      <div class="actions" role="group" aria-label="Add to the hall">
        <button type="button" class="act" aria-label="New file" [class.on]="adding()" (click)="toggleFile()"><span aria-hidden="true">＋</span> File</button>
        <button type="button" class="act" aria-label="New folder" [class.on]="addingFolder()" (click)="toggleFolder()"><span aria-hidden="true">＋</span> Folder</button>
      </div>
    }

    @if (adding()) {
      <form class="add" (submit)="submit($event, newFilePrefix() + name.value); name.value = ''">
        <span class="path">
          @if (newFilePrefix(); as prefix) { <input class="locked" disabled [value]="prefix" aria-label="Folder (locked)" /> }
          <input #name [placeholder]="newFilePrefix() ? 'intro.tex' : 'chapters/intro.tex'" aria-label="New file name" autofocus />
        </span>
        <button type="submit" hidden tabindex="-1" aria-hidden="true">Create</button>
        @if (createError()) { <small class="err">{{ createError() }}</small> }
      </form>
    }

    @if (addingFolder()) {
      <form class="add folder" (submit)="submitFolder($event)">
        <input name="folder" aria-label="New folder name" placeholder="appendix" autocomplete="off" autofocus [value]="folderName()" (input)="folderName.set($any($event.target).value); folderError.set(null)" />
        <label class="in"><span>Place it in</span>
          <select aria-label="Place the folder in" [value]="folderParent()" (change)="folderParent.set($any($event.target).value)">
            <option value="">The main hall (top level)</option>
            @for (d of dirs(); track d) { <option [value]="d" [selected]="d === folderParent()">{{ d }}/</option> }
          </select>
        </label>
        @if (folderError(); as e) { <small class="err" role="alert">{{ e }}</small> }
        <span class="row"><button type="button" class="act" (click)="addingFolder.set(false)">Cancel</button><button type="submit" class="act on">Create folder</button></span>
      </form>
    }

    @if (uploadMessage(); as m) { <small class="err" role="alert">{{ m }}</small> }
    @if (uploading() > 0) { <small class="busy" role="status">Carrying {{ uploading() }} {{ uploading() === 1 ? 'item' : 'items' }} to the hall…</small> }

    <ul role="tree">
      @for (n of tree(); track n.path) {
        <ng-container *ngTemplateOutlet="node; context: { $implicit: n, depth: 0 }" />
      }
    </ul>

    <dialog class="modal" #removeDlg aria-labelledby="rmH" (close)="toRemove.set(null)">
      <form class="parchment rm-box" method="dialog" (submit)="confirmRemove()">
        <h2 id="rmH">Remove {{ toRemove() }}?</h2>
        <p class="lede">
          @if (toRemoveIsAsset()) { Everyone at the table loses this picture, and any <code>\\includegraphics</code> that uses it will stop compiling. }
          @else { Everyone at the table loses this file. You can bring its text back from the version history. }
        </p>
        <div class="rm-actions">
          <button class="btn btn--ink" type="button" (click)="removeDlg.close()">Keep it</button>
          <button class="btn btn--danger" type="submit">Remove</button>
        </div>
      </form>
    </dialog>

    @if (hallLink(); as link) {
      <a class="hall" [routerLink]="link"><span aria-hidden="true">⌂</span> Enter the Tavern Hall</a>
    }

    <ng-template #node let-n let-depth="depth">
      @if (n.kind === 'dir') {
        <li class="dir" role="treeitem" tabindex="0" [attr.aria-expanded]="!isCollapsed(n.path)" [attr.aria-label]="n.name" [style.padding-left.px]="10 + depth * 16" (click)="toggleDir(n.path)" (keydown)="dirKey($event, n.path)">
          <span class="nm"><span class="caret" aria-hidden="true">{{ isCollapsed(n.path) ? '▸' : '▾' }}</span> {{ n.name }}</span>
          @if (canEdit()) {
            <button class="dirbtn" type="button" [attr.aria-label]="'New file in ' + n.path" title="New file in this folder" (click)="$event.stopPropagation(); addIn(n.path)">＋</button>
            @if (!n.children.length) { <button class="dirbtn" type="button" [attr.aria-label]="'Remove empty folder ' + n.path" title="Remove this empty folder" (click)="$event.stopPropagation(); removeFolder.emit(n.path)">×</button> }
          }
        </li>
        @if (!isCollapsed(n.path)) {
          @for (c of n.children; track c.path) {
            <ng-container *ngTemplateOutlet="node; context: { $implicit: c, depth: depth + 1 }" />
          }
        }
      } @else {
        <li
          class="file"
          role="treeitem"
          tabindex="0"
          [class.active]="n.path === active()"
          [class.asset]="assetMap().has(n.path)"
          [style.padding-left.px]="10 + depth * 16"
          [attr.draggable]="assetMap().has(n.path) && canEdit() ? 'true' : null"
          (dragstart)="dragAsset($event, n.path)"
          (click)="open(n.path)"
          (keydown.enter)="open(n.path)"
        >
          <span class="ico">{{ assetMap().has(n.path) ? '▣' : n.path === main() ? '★' : '▤' }}</span>
          <span class="nm">{{ n.name }}</span>
          @if (assetMap().get(n.path); as a) { <small class="size">{{ size(a.size) }}</small> }
          @if (canEdit() && n.path !== main()) {
            <button class="del" type="button" [attr.aria-label]="'Remove ' + n.path" (click)="$event.stopPropagation(); removeNode(n.path)">×</button>
          }
        </li>
      }
    </ng-template>
  `,
  styleUrl: './file-tree.component.scss',
  imports: [NgTemplateOutlet, RouterLink],
  host: {
    '[class.dragging]': 'dragging()',
    '(dragover)': 'dragOver($event)',
    '(dragleave)': 'dragLeave($event)',
    '(drop)': 'dropped($event)',
  },
})
export class FileTreeComponent {
  readonly files = input.required<string[]>();
  /** Images and PDFs seated beside the sources. */
  readonly assets = input<AssetInfo[]>([]);
  /** Folders that exist on their own (shared with everyone at the table), even when empty. */
  readonly folders = input<string[]>([]);
  readonly canEdit = input(true);
  /** Router link to the full-page Tavern Hall. */
  readonly hallLink = input<unknown[] | null>(null);
  readonly uploading = input(0);
  readonly uploadMessage = input<string | null>(null);
  readonly active = input<string | null>(null);
  readonly main = input('main.tex');
  readonly select = output<string>();
  readonly create = output<string>();
  readonly remove = output<string>();
  readonly selectAsset = output<string>();
  readonly removeAsset = output<string>();
  readonly upload = output<File[]>();
  /** A new folder (a table) was asked for; the page makes it. */
  readonly createFolder = output<string>();
  readonly removeFolder = output<string>();

  protected readonly accept = ACCEPT_ATTR;
  protected readonly size = formatBytes;
  protected readonly assetMap = computed(() => new Map(this.assets().map((a) => [a.path, a])));
  readonly tree = computed<TreeNode[]>(() => buildFileTree([...this.files(), ...this.assets().map((a) => a.path)], this.folders()));
  /** Every folder in the list, for "Place it in". */
  protected readonly dirs = computed(() => {
    const out: string[] = [];
    const walk = (nodes: TreeNode[]) => nodes.forEach((n) => n.kind === 'dir' && (out.push(n.path), walk(n.children)));
    walk(this.tree());
    return out.sort((a, b) => a.localeCompare(b));
  });
  readonly adding = signal(false);
  protected readonly newFilePrefix = signal('');
  protected readonly addingFolder = signal(false);
  protected readonly folderName = signal('');
  protected readonly folderParent = signal('');
  protected readonly folderError = signal<string | null>(null);

  /** Folders that are unfolded (every folder starts folded shut). */
  private readonly opened = signal<ReadonlySet<string>>(new Set());

  constructor() {
    // the file you are working in is never hidden inside a folded folder
    effect(() => {
      const a = this.active();
      if (a) untracked(() => this.reveal(a));
    });
  }

  protected isCollapsed(dir: string): boolean {
    return !this.opened().has(dir);
  }

  protected toggleDir(dir: string): void {
    this.opened.update((c) => {
      const next = new Set(c);
      if (!next.delete(dir)) next.add(dir);
      return next;
    });
  }

  protected dirKey(e: KeyboardEvent, dir: string): void {
    if (e.target !== e.currentTarget) return; // a key meant for the buttons inside the row
    if (e.key === 'Enter' || e.key === ' ') this.toggleDir(dir);
    else if (e.key === 'ArrowRight' && this.isCollapsed(dir)) this.toggleDir(dir);
    else if (e.key === 'ArrowLeft' && !this.isCollapsed(dir)) this.toggleDir(dir);
    else return;
    e.preventDefault();
  }

  /** Unfold every folder that holds `path` (a file, or a folder's own path counts its parents and itself). */
  private reveal(path: string, includeSelf = false): void {
    const parts = path.split('/');
    const dirs = parts.slice(0, includeSelf ? parts.length : -1).map((_, i, a) => a.slice(0, i + 1).join('/'));
    if (dirs.every((d) => this.opened().has(d))) return;
    this.opened.update((c) => new Set([...c, ...dirs]));
  }

  /** Open the "new file" form (the command menu uses this). */
  startFile(): void {
    this.newFilePrefix.set('');
    this.adding.set(true);
    this.addingFolder.set(false);
  }

  /** Open the "new folder" form. */
  startFolder(): void {
    this.folderName.set('');
    this.folderParent.set('');
    this.folderError.set(null);
    this.addingFolder.set(true);
    this.adding.set(false);
  }

  /** Open the file chooser for pictures and PDFs. */
  chooseUpload(): void {
    this.pickerEl()?.nativeElement.click();
  }

  protected toggleFile(): void {
    this.newFilePrefix.set('');
    this.adding.update((a) => !a);
    this.addingFolder.set(false);
  }

  /** The "＋" beside a folder: a new file, already pointing into it. */
  protected addIn(dir: string): void {
    this.newFilePrefix.set(dir + '/');
    this.reveal(dir, true);
    this.adding.set(true);
    this.addingFolder.set(false);
  }

  protected toggleFolder(): void {
    this.addingFolder.update((a) => !a);
    this.adding.set(false);
    this.folderName.set('');
    this.folderParent.set('');
    this.folderError.set(null);
  }

  protected submitFolder(e: Event): void {
    e.preventDefault();
    const error = tableNameError(this.folderName(), this.folderParent(), this.dirs());
    if (error) return void this.folderError.set(error);
    const made = joinPath(this.folderParent(), this.folderName().trim());
    this.reveal(made);
    this.createFolder.emit(made);
    this.addingFolder.set(false);
  }
  protected readonly dragging = signal(false);

  /** Dragging a picture from the hall into the document asks where to put it (the editor catches the drop). */
  protected dragAsset(e: DragEvent, path: string): void {
    if (!this.assetMap().has(path) || !this.canEdit() || !e.dataTransfer) return e.preventDefault();
    e.dataTransfer.setData(ASSET_DRAG_TYPE, path);
    e.dataTransfer.effectAllowed = 'copy';
  }

  protected open(path: string): void {
    if (this.assetMap().has(path)) this.selectAsset.emit(path);
    else this.select.emit(path);
  }
  /** The file the scribe has asked to remove, waiting for a "yes". */
  protected readonly toRemove = signal<string | null>(null);
  protected readonly toRemoveIsAsset = computed(() => !!this.toRemove() && this.assetMap().has(this.toRemove()!));
  private readonly pickerEl = viewChild<ElementRef<HTMLInputElement>>('picker');
  private readonly removeDlg = viewChild.required<ElementRef<HTMLDialogElement>>('removeDlg');

  protected removeNode(path: string): void {
    this.toRemove.set(path);
    this.removeDlg().nativeElement.showModal();
  }

  protected confirmRemove(): void {
    const path = this.toRemove();
    if (!path) return;
    if (this.assetMap().has(path)) this.removeAsset.emit(path);
    else this.remove.emit(path);
  }

  protected picked(input: HTMLInputElement): void {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length) this.upload.emit(files);
  }
  private hasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  }
  protected dragOver(e: DragEvent): void {
    if (!this.canEdit() || !this.hasFiles(e)) return;
    e.preventDefault();
    this.dragging.set(true);
  }
  protected dragLeave(e: DragEvent): void {
    // ignore leaves into children
    if (e.relatedTarget && (e.currentTarget as Node).contains(e.relatedTarget as Node)) return;
    this.dragging.set(false);
  }
  protected dropped(e: DragEvent): void {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    this.dragging.set(false);
    if (!this.canEdit()) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) this.upload.emit(files);
  }

  /** Parent calls this after a successful create to close the form. */
  close(): void {
    this.adding.set(false);
  }
  /** Validation message from the parent (e.g. duplicate or invalid path). */
  readonly createError = input<string | null>(null);

  submit(ev: Event, value: string): void {
    ev.preventDefault();
    const path = value.trim();
    if (!path) return;
    this.reveal(path);
    this.create.emit(path);
  }
}

