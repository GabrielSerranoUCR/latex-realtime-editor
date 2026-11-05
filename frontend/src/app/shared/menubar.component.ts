import { Component, ElementRef, HostListener, inject, input, signal } from '@angular/core';
import { shortcutLabel } from '../core/palette/palette';

export interface MenuItem {
  label: string;
  /** Shortcut in Mac symbols ("⌘⇧B"); shown as Ctrl+Shift+B where that is the keyboard. */
  keys?: string;
  run?: () => void;
  disabled?: boolean;
  /** A switch or radio: shows a tick when true. */
  checked?: boolean;
  /** A small note on the right when there is no shortcut (a count, "owner only"). */
  note?: string;
  /** A thin line before this item. */
  separator?: boolean;
}

export interface Menu {
  id: string;
  label: string;
  items: MenuItem[];
}

/** A classic menu bar (File, Edit, View…) with full keyboard support: arrows, Home/End, Enter, Esc. */
@Component({
  selector: 'qq-menubar',
  template: `
    <nav class="bar" role="menubar" aria-label="Scroll menus">
      @for (m of menus(); track m.id) {
        <div class="slot">
          <button
            type="button"
            role="menuitem"
            class="top"
            aria-haspopup="menu"
            [id]="'mb-' + m.id"
            [class.open]="open() === m.id"
            [attr.aria-expanded]="open() === m.id"
            [attr.aria-controls]="'mbm-' + m.id"
            (click)="toggle(m.id)"
            (mouseenter)="hover(m.id)"
            (keydown)="topKey($event, m.id)"
          >{{ m.label }}</button>
          @if (open() === m.id) {
            <ul class="drop" role="menu" [id]="'mbm-' + m.id" [attr.aria-labelledby]="'mb-' + m.id" (keydown)="itemKey($event, m.id)">
              @for (it of m.items; track $index) {
                @if (it.separator) { <li class="sep" role="separator"></li> }
                <li role="none">
                  <button
                    type="button"
                    [attr.role]="it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'"
                    [attr.aria-checked]="it.checked === undefined ? null : it.checked"
                    class="item"
                    tabindex="-1"
                    [disabled]="it.disabled"
                    (click)="choose(it)"
                  >
                    <span class="tick" aria-hidden="true">{{ it.checked ? '✓' : '' }}</span>
                    <span class="lbl">{{ it.label }}</span>
                    @if (it.keys) { <kbd>{{ label(it.keys) }}</kbd> } @else if (it.note) { <em>{{ it.note }}</em> }
                  </button>
                </li>
              }
            </ul>
          }
        </div>
      }
    </nav>
  `,
  styleUrl: './menubar.component.scss',
})
export class MenubarComponent {
  readonly menus = input.required<Menu[]>();

  protected readonly open = signal<string | null>(null);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected label = (keys: string): string => shortcutLabel(keys);

  @HostListener('document:pointerdown', ['$event'])
  protected outside(e: Event): void {
    if (this.open() && !this.host.nativeElement.contains(e.target as Node)) this.open.set(null);
  }

  protected toggle(id: string): void {
    this.open.set(this.open() === id ? null : id);
  }

  /** With a menu open, moving the pointer along the bar opens the neighbour, like a desktop menu. */
  protected hover(id: string): void {
    if (this.open() && this.open() !== id) this.open.set(id);
  }

  protected choose(it: MenuItem): void {
    if (it.disabled) return;
    this.open.set(null);
    it.run?.();
  }

  private focusItem(menu: string, which: 'first' | 'last' | 'next' | 'prev', tries = 0): void {
    // the menu is drawn a moment after it is asked for: look again on the next frames until its items exist
    requestAnimationFrame(() => {
      const items = Array.from(this.host.nativeElement.querySelectorAll<HTMLButtonElement>(`#mbm-${menu} .item:not(:disabled)`));
      if (!items.length) return tries < 10 ? this.focusItem(menu, which, tries + 1) : undefined;
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const to = which === 'first' ? 0 : which === 'last' ? items.length - 1 : which === 'next' ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
      items[to].focus();
    });
  }

  private neighbour(id: string, dir: 1 | -1): string {
    const ids = this.menus().map((m) => m.id);
    return ids[(ids.indexOf(id) + dir + ids.length) % ids.length];
  }

  private focusTop(id: string): void {
    queueMicrotask(() => this.host.nativeElement.querySelector<HTMLButtonElement>(`#mb-${id}`)?.focus());
  }

  protected topKey(e: KeyboardEvent, id: string): void {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.open.set(id);
      this.focusItem(id, 'first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.open.set(id);
      this.focusItem(id, 'last');
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const to = this.neighbour(id, e.key === 'ArrowRight' ? 1 : -1);
      const wasOpen = this.open() !== null;
      this.open.set(wasOpen ? to : null);
      this.focusTop(to);
    } else if (e.key === 'Escape') {
      this.open.set(null);
    }
  }

  protected itemKey(e: KeyboardEvent, id: string): void {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); this.focusItem(id, 'next'); break;
      case 'ArrowUp': e.preventDefault(); this.focusItem(id, 'prev'); break;
      case 'Home': e.preventDefault(); this.focusItem(id, 'first'); break;
      case 'End': e.preventDefault(); this.focusItem(id, 'last'); break;
      case 'Escape': e.preventDefault(); this.open.set(null); this.focusTop(id); break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        e.preventDefault();
        const to = this.neighbour(id, e.key === 'ArrowRight' ? 1 : -1);
        this.open.set(to);
        this.focusItem(to, 'first');
        break;
      }
      case 'Tab': this.open.set(null); break;
    }
  }
}
