import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CollabService } from '../../core/collab/collab.service';
import { ModalsService, SettingsTab } from '../../core/notify/modals.service';
import { ToastService } from '../../core/notify/toast.service';
import { EditorFont, FONT_LABELS, FONT_SIZE, FONT_STACKS, LINE_HEIGHT } from '../../core/prefs/prefs';
import { PreferencesService } from '../../core/prefs/prefs.service';
import { ToggleComponent } from '../../shared/toggle.component';

/** "Tavern Settings": how this scroll is inked, how your writing desk looks, and how scribes work together. */
@Component({
  selector: 'qq-settings-modal',
  imports: [FormsModule, ToggleComponent],
  templateUrl: './settings-modal.component.html',
  styleUrl: './settings-modal.component.scss',
})
export class SettingsModalComponent {
  private readonly modals = inject(ModalsService);
  protected readonly prefs = inject(PreferencesService);
  protected readonly collab = inject(CollabService);
  private readonly toasts = inject(ToastService);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  protected readonly tab = signal<SettingsTab>('compiler');
  protected readonly tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'compiler', label: 'Compiler' },
    { id: 'editor', label: 'Editor' },
    { id: 'collaboration', label: 'Collaboration' },
  ];
  protected readonly fonts = Object.entries(FONT_LABELS) as Array<[EditorFont, string]>;
  protected readonly sizeLimits = FONT_SIZE;
  protected readonly heightLimits = LINE_HEIGHT;

  /** Null on pages without an open scroll: the scroll's own settings are then not shown. */
  protected readonly scroll = this.modals.scrollContext;
  protected readonly canEdit = computed(() => this.scroll()?.canEdit ?? false);
  protected readonly texFiles = computed(() => this.collab.files().filter((f) => f.toLowerCase().endsWith('.tex')));

  // drafts
  protected readonly main = signal('main.tex');
  protected readonly autoCompile = signal(false);
  protected readonly showWarnings = signal(true);
  protected readonly fontFamily = signal<EditorFont>('jetbrains');
  protected readonly fontSize = signal<number | null>(15);
  protected readonly lineHeight = signal<number | null>(24);
  protected readonly lineNumbers = signal(true);
  protected readonly wrapLines = signal(true);
  protected readonly autoClose = signal(true);
  protected readonly spellcheck = signal(false);
  protected readonly showOthersCursors = signal(true);
  protected readonly showNameFlags = signal(true);

  protected readonly sample = computed(() => ({ family: FONT_STACKS[this.fontFamily()], size: this.fontSize() ?? 15, height: this.lineHeight() ?? 24 }));

  constructor() {
    effect(() => {
      const tab = this.modals.settings();
      untracked(() => (tab ? this.open(tab) : this.hide()));
    });
  }

  private open(tab: SettingsTab): void {
    this.tab.set(tab);
    const p = this.prefs.prefs();
    this.main.set(this.collab.mainFile());
    this.autoCompile.set(p.autoCompile);
    this.showWarnings.set(p.showWarnings);
    this.fontFamily.set(p.fontFamily);
    this.fontSize.set(p.fontSize);
    this.lineHeight.set(p.lineHeight);
    this.lineNumbers.set(p.lineNumbers);
    this.wrapLines.set(p.wrapLines);
    this.autoClose.set(p.autoClose);
    this.spellcheck.set(p.spellcheck);
    this.showOthersCursors.set(p.showOthersCursors);
    this.showNameFlags.set(p.showNameFlags);
    const el = this.dlg().nativeElement;
    if (!el.open) el.showModal();
  }

  /** We closed the dialog ourselves, so the `close` event that follows is ours and says nothing new. */
  private closingByUs = false;

  private hide(): void {
    const el = this.dlg().nativeElement;
    if (!el.open) return;
    this.closingByUs = true;
    el.close();
  }

  /**
   * The browser reports a close a moment after it happens. If we caused it, the state is already right (and may
   * even have been set to "open again" since): leave it. Otherwise (Escape) the page must be told.
   */
  protected closed(): void {
    if (this.closingByUs) {
      this.closingByUs = false;
      return;
    }
    this.modals.closeSettings();
  }

  protected close(): void {
    this.modals.closeSettings();
  }

  protected pick(t: SettingsTab): void {
    this.tab.set(t);
  }

  protected tabKey(e: KeyboardEvent): void {
    const i = this.tabs.findIndex((t) => t.id === this.tab());
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? this.tabs.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = this.tabs[(next + this.tabs.length) % this.tabs.length];
    this.tab.set(t.id);
    queueMicrotask(() => document.getElementById('stab-' + t.id)?.focus());
  }

  protected save(e: Event): void {
    e.preventDefault();
    if (this.scroll() && this.canEdit() && this.main() !== this.collab.mainFile()) this.collab.setMain(this.main());
    this.prefs.update({
      autoCompile: this.autoCompile(),
      showWarnings: this.showWarnings(),
      fontFamily: this.fontFamily(),
      fontSize: this.fontSize() ?? undefined,
      lineHeight: this.lineHeight() ?? undefined,
      lineNumbers: this.lineNumbers(),
      wrapLines: this.wrapLines(),
      autoClose: this.autoClose(),
      spellcheck: this.spellcheck(),
      showOthersCursors: this.showOthersCursors(),
      showNameFlags: this.showNameFlags(),
    });
    this.toasts.show('Your settings are saved.', 'ok');
    this.close();
  }
}
