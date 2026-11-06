import { Component, computed, input } from '@angular/core';
import { Review, SideRow, sideBySide } from '../../../core/collab/proposal-view';

/** One proposed change drawn side by side: the file now on the left, once accepted on the right; deletions red, additions green. */
@Component({
  selector: 'qq-proposal-diff',
  template: `
    <div class="diff" role="region" tabindex="0" [attr.aria-label]="'Change to ' + review().path">
      <div class="cols" aria-hidden="true"><span>Current</span><span>With the AI's changes</span></div>
      @if (review().stale; as why) {
        <p class="stale">{{ why }}@if (review().fallback?.lines?.length) { Here is what it meant to change: }</p>
        @for (l of review().fallback?.lines ?? []; track $index) {
          <div class="d-row">
            <div class="cell" [class.del]="l.type === 'del'"><span class="no"></span><span class="tx">{{ l.type === 'del' ? l.text || ' ' : ' ' }}</span></div>
            <div class="cell" [class.add]="l.type === 'add'"><span class="no"></span><span class="tx">{{ l.type === 'add' ? l.text || ' ' : ' ' }}</span></div>
          </div>
        }
      } @else {
        @for (h of hunks(); track $index) {
          <div class="hunk">{{ h.header }}</div>
          @for (r of h.rows; track $index) {
            <div class="d-row">
              <div class="cell" [class.del]="r.left?.del" [class.gap]="!r.left">
                <span class="no" aria-hidden="true">{{ r.left?.no ?? '' }}</span>
                @if (r.left?.del) { <span class="sr">removed: </span> }
                <span class="tx">{{ r.left ? r.left.text || ' ' : ' ' }}</span>
              </div>
              <div class="cell" [class.add]="r.right?.add" [class.gap]="!r.right">
                <span class="no" aria-hidden="true">{{ r.right?.no ?? '' }}</span>
                @if (r.right?.add) { <span class="sr">added: </span> }
                <span class="tx">{{ r.right ? r.right.text || ' ' : ' ' }}</span>
              </div>
            </div>
          }
        } @empty {
          <p class="stale">Nothing changes: the file already reads this way.</p>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .diff { max-height: 56vh; overflow: auto; background: var(--parchment-100); border: 1px solid rgb(var(--brass7-rgb) / 0.5); border-radius: 4px; font: 400 13px/1.5 var(--font-mono); color: var(--ink-900); outline: none; &:focus-visible { box-shadow: 0 0 0 2px var(--candle-400); } }
    .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); position: sticky; top: 0; z-index: 2; background: var(--parchment-200); border-bottom: 1px solid rgb(var(--brass7-rgb) / 0.5); font: 700 11px var(--font-heading); letter-spacing: 0.12em; text-transform: uppercase; color: var(--brass-700); span { padding: 4px 10px; } span + span { border-left: 1px solid rgb(var(--brass7-rgb) / 0.5); } }
    .hunk { padding: 2px 10px; background: rgb(var(--brass7-rgb) / 0.16); color: var(--ink-600); }
    .d-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .cell { display: flex; min-width: 0; & + .cell { border-left: 1px solid rgb(var(--brass7-rgb) / 0.5); }
      &.add { background: rgb(47 125 50 / 0.22); color: #1d5a21; } &.del { background: rgb(179 54 43 / 0.2); color: #8c2a21; } &.gap { background: rgb(var(--brass7-rgb) / 0.08); } }
    .no { flex: none; width: 38px; padding-right: 8px; text-align: right; color: var(--ink-600); opacity: 0.75; user-select: none; }
    .tx { white-space: pre-wrap; overflow-wrap: anywhere; padding-right: 10px; }
    .stale { margin: 0; padding: 8px 10px; font: italic 15px var(--font-body); color: var(--wine-500); }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  `,
})
export class ProposalDiffComponent {
  readonly review = input.required<Review>();
  protected readonly hunks = computed<{ header: string; rows: SideRow[] }[]>(() => this.review().hunks.map((h) => ({ header: h.header, rows: sideBySide(h.rows) })));
}
