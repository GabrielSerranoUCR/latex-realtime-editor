import { Component, ElementRef, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { Popped } from '../../../core/layout/layout.service';
import { PanelId, Visibility } from '../../../core/layout/panel-layout';

interface Row {
  id: PanelId;
  label: string;
  icon: string;
  status: string;
  on: boolean;
  popped: boolean;
  canPop: boolean;
  popTitle: string;
}

/** The "Panels" button and its popover: show or hide each panel, send it to its own window, save the arrangement. */
@Component({
  selector: 'qq-panels-menu',
  template: `
    <button class="chipbtn" [class.on]="open()" type="button" aria-haspopup="dialog" [attr.aria-expanded]="open()" (click)="toggleOpen($event)">Panels</button>
    @if (open()) {
      <div class="pop" role="dialog" aria-label="Panels" (click)="$event.stopPropagation()" (keydown.escape)="close(true)">
        <h3>Panels</h3>
        @for (r of rows(); track r.id) {
          <div class="row">
            <span class="ico" aria-hidden="true">{{ r.icon }}</span>
            <span class="lbl"><b>{{ r.label }}</b><i>{{ r.status }}</i></span>
            <button type="button" class="pop-btn" [disabled]="!r.canPop" [title]="r.popTitle" [attr.aria-label]="r.popTitle" (click)="popOut.emit(r.id)">⧉</button>
            <label class="switch" [title]="(r.on ? 'Hide ' : 'Show ') + r.label">
              <input type="checkbox" role="switch" [checked]="r.on" [attr.aria-label]="'Show ' + r.label" (change)="toggle.emit(r.id)" />
              <span class="track"></span>
            </label>
          </div>
        }
        <hr />
        <button type="button" class="foot" (click)="reset.emit()"><span aria-hidden="true">↺</span> Reset to default layout</button>
        <button type="button" class="foot" (click)="save.emit()"><span aria-hidden="true">▮</span> Save as my tavern layout @if (hasSaved()) { <em>· saved</em> }</button>
      </div>
    }
  `,
  styles: `
    :host { position: relative; display: inline-block; }
    .chipbtn { font: 700 12px var(--font-heading); padding: 4px 12px; border-radius: 999px; background: transparent; color: var(--text-2); border: 1px solid var(--brass-700); cursor: pointer; &.on { background: rgb(var(--brass-rgb) / 0.25); border-color: var(--brass-500); color: var(--candle-400); } }
    .pop { position: absolute; z-index: 40; right: 0; top: calc(100% + 10px); width: 320px; padding: 14px 16px 10px; background: var(--parchment-100); color: var(--ink-900); border: 3px solid var(--wood-900); border-radius: 6px; box-shadow: 0 16px 32px rgb(0 0 0 / 0.6); }
    h3 { margin: 0 0 8px; font: 700 12px var(--font-heading); letter-spacing: 0.16em; text-transform: uppercase; color: var(--brass-700); }
    .row { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
    .ico { width: 22px; text-align: center; color: var(--ink-600); }
    .lbl { flex: 1; display: flex; flex-direction: column; b { font: 700 13px var(--font-heading); text-transform: uppercase; } i { font: italic 13px var(--font-body); color: var(--ink-600); } }
    .pop-btn { width: 28px; height: 28px; border-radius: 4px; background: var(--parchment-200); border: 2px solid var(--brass-700); color: var(--ink-900); cursor: pointer; &:disabled { opacity: 0.4; cursor: default; } &:hover:not(:disabled) { background: var(--parchment-300); } }
    .switch { position: relative; display: inline-flex; cursor: pointer; input { position: absolute; opacity: 0; } .track { width: 42px; height: 24px; border-radius: 12px; background: var(--wood-600); position: relative; transition: background 0.15s; &::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--parchment-100); transition: transform 0.15s; } } input:checked + .track { background: var(--brass-700); &::after { transform: translateX(18px); } } input:focus-visible + .track { outline: 2px solid var(--candle-400); outline-offset: 2px; } }
    hr { border: 0; border-top: 1px solid rgb(var(--brass7-rgb) / 0.45); margin: 8px 0 4px; }
    .foot { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 4px; background: none; border: 0; font: 700 14px var(--font-body); color: var(--ink-900); text-align: left; cursor: pointer; border-radius: 3px; &:hover { background: var(--parchment-300); } em { font-weight: 400; color: var(--ink-600); } }
  `,
})
export class PanelsMenuComponent {
  readonly visible = input.required<Visibility>();
  readonly popped = input.required<Popped>();
  readonly hasSaved = input(false);
  readonly toggle = output<PanelId>();
  readonly popOut = output<PanelId>();
  readonly reset = output<void>();
  readonly save = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly open = signal(false);

  protected readonly rows = computed<Row[]>(() => {
    const v = this.visible();
    const p = this.popped();
    const status = (on: boolean, popped = false) => (popped ? 'In its own window' : on ? 'Docked' : 'Hidden');
    return [
      { id: 'tree', label: 'Tavern Hall', icon: '▤', status: status(v.tree), on: v.tree, popped: false, canPop: true, popTitle: 'Open the Tavern Hall in its own window' },
      { id: 'source', label: 'Source Editor', icon: '</>', status: status(v.source), on: v.source, popped: false, canPop: false, popTitle: 'The editor stays in this window' },
      { id: 'preview', label: 'Scroll Preview', icon: '▥', status: status(v.preview, p.preview), on: v.preview, popped: p.preview, canPop: true, popTitle: p.preview ? 'Bring Scroll Preview back' : 'Pop Scroll Preview out to its own window' },
      { id: 'log', label: 'Ink Log', icon: '☰', status: status(v.log, p.log), on: v.log, popped: p.log, canPop: true, popTitle: p.log ? 'Bring Ink Log back' : 'Pop Ink Log out to its own window' },
    ];
  });

  protected toggleOpen(e: Event): void {
    e.stopPropagation();
    this.open.update((o) => !o);
  }

  protected close(refocus = false): void {
    this.open.set(false);
    if (refocus) this.host.nativeElement.querySelector('button')?.focus();
  }

  @HostListener('document:click')
  protected outside(): void {
    if (this.open()) this.open.set(false);
  }
}
