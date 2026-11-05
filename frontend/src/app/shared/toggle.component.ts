import { Component, input, model } from '@angular/core';

/** A labelled on/off switch (a real checkbox with the `switch` role, so keyboards and screen readers just work). */
@Component({
  selector: 'qq-toggle',
  template: `
    <label class="switch" [class.off]="disabled()">
      <input type="checkbox" role="switch" [checked]="checked()" [disabled]="disabled()" (change)="checked.set($any($event.target).checked)" />
      <span class="track" aria-hidden="true"></span>
      <span class="lbl"><ng-content /></span>
    </label>
  `,
  styles: `
    :host { display: block; }
    .switch { position: relative; display: flex; align-items: center; gap: 12px; cursor: pointer; font: 600 17px var(--font-body); color: var(--ink-900); padding: 4px 0; }
    .switch.off { opacity: 0.55; cursor: default; }
    input { position: absolute; opacity: 0; width: 0; height: 0; }
    .track { flex: none; position: relative; width: 38px; height: 22px; border-radius: 11px; background: var(--wood-600); transition: background 0.15s; &::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--parchment-100); transition: transform 0.15s; } }
    input:checked + .track { background: var(--brass-700); &::after { transform: translateX(16px); } }
    input:focus-visible + .track { outline: 2px solid var(--candle-400); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .track, .track::after { transition: none; } }
  `,
})
export class ToggleComponent {
  readonly checked = model(false);
  readonly disabled = input(false);
}
