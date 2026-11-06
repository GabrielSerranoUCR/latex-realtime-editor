import { Component, input } from '@angular/core';
import { Review } from '../../../core/collab/proposal-view';

/** One proposed change drawn like `git diff`: hunks with line numbers, green additions and red deletions. */
@Component({
  selector: 'qq-proposal-diff',
  template: `
    <div class="diff" role="region" tabindex="0" [attr.aria-label]="'Change to ' + review().path">
      @if (review().stale; as why) {
        <p class="stale">{{ why }}@if (review().fallback?.lines?.length) { Here is what it meant to change: }</p>
        @for (l of review().fallback?.lines ?? []; track $index) {
          <div class="ln" [class.add]="l.type === 'add'" [class.del]="l.type === 'del'">
            <span class="no" aria-hidden="true"></span><span class="no" aria-hidden="true"></span>
            <span class="mk" aria-hidden="true">{{ l.type === 'add' ? '+' : l.type === 'del' ? '−' : '' }}</span>
            <span class="tx">{{ l.text || ' ' }}</span>
          </div>
        }
      } @else {
        @for (h of review().hunks; track $index) {
          <div class="hunk">{{ h.header }}</div>
          @for (r of h.rows; track $index) {
            <div class="ln" [class.add]="r.type === 'add'" [class.del]="r.type === 'del'">
              <span class="no" aria-hidden="true">{{ r.now ?? '' }}</span>
              <span class="no" aria-hidden="true">{{ r.next ?? '' }}</span>
              <span class="mk" aria-hidden="true">{{ r.type === 'add' ? '+' : r.type === 'del' ? '−' : '' }}</span>
              @if (r.type !== 'same') { <span class="sr">{{ r.type === 'add' ? 'added: ' : 'removed: ' }}</span> }
              <span class="tx">{{ r.text || ' ' }}</span>
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
    .diff { max-height: 340px; overflow: auto; background: var(--parchment-100); border: 1px solid rgb(var(--brass7-rgb) / 0.5); border-radius: 4px; font: 400 13px/1.5 var(--font-mono); color: var(--ink-900); outline: none; &:focus-visible { box-shadow: 0 0 0 2px var(--candle-400); } }
    .hunk { padding: 2px 10px; background: rgb(var(--brass7-rgb) / 0.16); color: var(--ink-600); position: sticky; top: 0; }
    .ln { display: flex; min-width: max-content; &.add { background: rgb(47 125 50 / 0.18); } &.del { background: rgb(179 54 43 / 0.16); } }
    .no { flex: none; width: 40px; padding-right: 8px; text-align: right; color: var(--ink-600); opacity: 0.75; user-select: none; }
    .mk { flex: none; width: 20px; text-align: center; font-weight: 700; user-select: none; }
    .add .mk, .add .tx { color: #1d5a21; } .del .mk, .del .tx { color: #8c2a21; }
    .tx { white-space: pre; padding-right: 12px; }
    .stale { margin: 0; padding: 8px 10px; font: italic 15px var(--font-body); color: var(--wine-500); }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  `,
})
export class ProposalDiffComponent {
  readonly review = input.required<Review>();
}
