import { Component, computed, input, output, signal } from '@angular/core';
import { stepSize } from '../../../core/layout/panel-layout';

/**
 * The strip between two panels. Drag it, or focus it and use the arrow keys (Shift for bigger steps,
 * Home/End for the limits); double-click or Enter puts it back to its default.
 */
@Component({
  selector: 'qq-resize-handle',
  template: `
    <div
      class="grip"
      [class.col]="orientation() === 'col'"
      [class.row]="orientation() === 'row'"
      [class.hot]="dragging() || focused() || hovered()"
      role="separator"
      tabindex="0"
      [attr.aria-orientation]="orientation() === 'col' ? 'vertical' : 'horizontal'"
      [attr.aria-label]="label()"
      [attr.aria-valuenow]="value()"
      [attr.aria-valuemin]="min()"
      [attr.aria-valuemax]="max()"
      (pointerdown)="down($event)"
      (pointermove)="move($event)"
      (pointerup)="up($event)"
      (pointercancel)="up($event)"
      (keydown)="key($event)"
      (dblclick)="reset.emit()"
      (focus)="focused.set(true)"
      (blur)="focused.set(false)"
      (pointerenter)="hovered.set(true)"
      (pointerleave)="hovered.set(false)"
    >
      <i class="pill"></i>
    </div>
    @if (dragging() || focused()) {
      <span class="tip" role="status">{{ orientation() === 'col' ? '↔' : '↕' }} Drag to resize · {{ value() }} px</span>
    }
  `,
  styles: `
    :host { display: block; position: relative; min-width: 0; min-height: 0; }
    .grip { position: absolute; inset: 0; display: grid; place-content: center; touch-action: none; outline: none; z-index: 2;
      &.col { cursor: col-resize; } &.row { cursor: row-resize; }
      &.hot::before { content: ''; position: absolute; inset: -14px; background: radial-gradient(closest-side, rgb(var(--glow-rgb) / 0.55), transparent); pointer-events: none; }
      &:focus-visible .pill { outline: 2px solid var(--candle-400); outline-offset: 2px; } }
    .pill { position: relative; display: block; border-radius: 3px; background: var(--brass-500); border: 1px solid var(--brass-700); transition: background 0.12s; }
    .col .pill { width: 6px; height: 40px; } .row .pill { width: 40px; height: 6px; }
    .hot .pill { background: var(--candle-400); }
    .tip { position: absolute; z-index: 30; white-space: nowrap; pointer-events: none; padding: 4px 10px; border-radius: 4px; background: var(--parchment-100); color: var(--ink-900); font: 600 14px var(--font-body); box-shadow: 0 6px 14px rgb(0 0 0 / 0.5); left: 22px; top: 52%; transform: translateY(-50%); }
    :host(.row-handle) .tip { left: 50%; top: -34px; transform: translateX(-50%); }
  `,
})
export class ResizeHandleComponent {
  readonly orientation = input<'col' | 'row'>('col');
  readonly value = input.required<number>();
  readonly min = input.required<number>();
  readonly max = input.required<number>();
  /** +1 when dragging towards the end grows the panel (a panel left of / above the handle), -1 otherwise. */
  readonly sign = input<1 | -1>(1);
  readonly label = input('Resize panel');
  readonly resize = output<number>();
  readonly reset = output<void>();

  protected readonly dragging = signal(false);
  protected readonly focused = signal(false);
  protected readonly hovered = signal(false);
  private start: { id: number; from: number; at: number } | null = null;

  protected readonly range = computed(() => [this.min(), this.max()] as const);

  protected down(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.start = { id: e.pointerId, from: this.orientation() === 'col' ? e.clientX : e.clientY, at: this.value() };
    this.dragging.set(true);
  }

  protected move(e: PointerEvent): void {
    const s = this.start;
    if (!s || s.id !== e.pointerId) return;
    const now = this.orientation() === 'col' ? e.clientX : e.clientY;
    this.resize.emit(Math.round(s.at + (now - s.from) * this.sign()));
  }

  protected up(e: PointerEvent): void {
    if (!this.start || this.start.id !== e.pointerId) return;
    this.start = null;
    this.dragging.set(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  protected key(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.reset.emit();
      return;
    }
    // arrows follow the screen: right/down move the handle that way, so they grow or shrink depending on the side
    const horizontal = this.orientation() === 'col';
    if (horizontal ? e.key === 'ArrowUp' || e.key === 'ArrowDown' : e.key === 'ArrowLeft' || e.key === 'ArrowRight') return;
    const sign = this.sign();
    const probe = stepSize(0, e.key, e.shiftKey, this.range());
    if (probe === null) return;
    e.preventDefault();
    if (e.key === 'Home') return void this.resize.emit(this.min());
    if (e.key === 'End') return void this.resize.emit(this.max());
    this.resize.emit(this.value() + probe * sign);
  }
}
