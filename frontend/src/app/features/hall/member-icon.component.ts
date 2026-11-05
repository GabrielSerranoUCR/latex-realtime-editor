import { Component, computed, input } from '@angular/core';
import type { MemberKind } from '../../core/collab/tavern';

const PATHS: Record<MemberKind | 'star', string[]> = {
  star: ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z'],
  source: ['M7 3h7l5 5v13H7z', 'M14 3v5h5', 'M10 13h6', 'M10 17h6'],
  bib: ['M6 4h12v16H6z', 'M6 17h12', 'M9 8h6'],
  style: ['M12 3a9 9 0 100 18c1.5 0 2-1 1.3-2-.7-1 0-2.5 1.5-2.5H17a4 4 0 004-4c0-5-4-9.5-9-9.5z', 'M8 11h.01', 'M12 8h.01', 'M16 11h.01'],
  note: ['M5 4h14v11l-5 5H5z', 'M14 20v-5h5'],
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M16 9h.01'],
  pdf: ['M7 3h7l5 5v13H7z', 'M14 3v5h5', 'M10 15h6'],
  other: ['M7 3h7l5 5v13H7z', 'M14 3v5h5'],
};

/** Small line icon for a kind of member (files seated at a table). */
@Component({
  selector: 'qq-member-icon',
  template: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" [attr.fill]="star() ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">@for (d of paths(); track d) { <path [attr.d]="d" /> }</svg>`,
  styles: ':host { display: inline-grid; place-content: center; line-height: 0; }',
})
export class MemberIconComponent {
  readonly kind = input.required<MemberKind>();
  readonly main = input(false);
  protected readonly star = computed(() => this.main());
  protected readonly paths = computed(() => PATHS[this.main() ? 'star' : this.kind()]);
}
