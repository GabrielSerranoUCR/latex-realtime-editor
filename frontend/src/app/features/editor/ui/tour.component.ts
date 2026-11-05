import { Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Box, CardPlace, TOUR_STEPS, TourStep, padBox, placeCard, usableSteps } from '../../../core/tour/tour';
import { TourService } from '../../../core/tour/tour.service';

/** The first-visit tour: a lit-up part of the page, an arrow, and a card that walks through four steps. */
@Component({
  selector: 'qq-tour',
  template: `
    @if (tour.active() && step(); as s) {
      <div class="shield" aria-hidden="true"></div>
      @if (spot(); as b) {
        <div class="spot" aria-hidden="true" [style.left.px]="b.x" [style.top.px]="b.y" [style.width.px]="b.w" [style.height.px]="b.h"></div>
      }
      @if (place(); as p) {
        <i class="arrow" aria-hidden="true" [style.left.px]="arrowAt().x" [style.top.px]="arrowAt().y"></i>
        <section #card class="card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body" [style.left.px]="p.left" [style.top.px]="p.top">
          <header>
            <span class="step">Step {{ index() + 1 }} of {{ steps().length }}</span>
            <button class="skip" type="button" (click)="finish()">Skip tour</button>
          </header>
          <h2 id="tour-title">{{ s.title }}</h2>
          <p id="tour-body">{{ s.body }}</p>
          <footer>
            <span class="dots" role="img" [attr.aria-label]="'Step ' + (index() + 1) + ' of ' + steps().length">
              @for (d of steps(); track d.id; let i = $index) { <i [class.on]="i === index()"></i> }
            </span>
            <span class="sp"></span>
            @if (index() > 0) { <button class="back" type="button" (click)="back()">Back</button> }
            <button #next class="btn" type="button" (click)="advance()">{{ last() ? 'Done' : 'Next' }}</button>
          </footer>
        </section>
      }
    }
  `,
  styleUrl: './tour.component.scss',
})
export class TourComponent {
  /** Readers have no Compile button, so their tour skips that step. */
  readonly canEdit = input(true);

  protected readonly tour = inject(TourService);
  private readonly card = viewChild<ElementRef<HTMLElement>>('card');
  private readonly nextBtn = viewChild<ElementRef<HTMLButtonElement>>('next');

  protected readonly steps = signal<TourStep[]>([]);
  protected readonly index = signal(0);
  protected readonly step = computed(() => this.steps()[this.index()] ?? null);
  protected readonly last = computed(() => this.index() >= this.steps().length - 1);
  /** The lit-up frame around the part this step is about. */
  protected readonly spot = signal<Box | null>(null);
  private readonly cardSize = signal({ w: 360, h: 279 });
  private readonly view = signal({ w: window.innerWidth, h: window.innerHeight });
  protected readonly place = computed<CardPlace | null>(() => {
    const s = this.step();
    const b = this.spot();
    return s && b ? placeCard(b, this.cardSize(), this.view(), s.side) : null;
  });
  /** The arrow's top-left, so that its middle sits on the card's edge that faces the lit-up part. */
  protected readonly arrowAt = computed(() => {
    const p = this.place();
    const { w, h } = this.cardSize();
    if (!p) return { x: 0, y: 0 };
    const half = 9;
    const into = 3; // the middle of the arrow sits just inside the card's edge: the card covers its inner half
    switch (p.arrowOn) {
      case 'left': return { x: p.left + into - half, y: p.top + p.arrowAt - half };
      case 'right': return { x: p.left + w - into - half, y: p.top + p.arrowAt - half };
      case 'top': return { x: p.left + p.arrowAt - half, y: p.top + into - half };
      default: return { x: p.left + p.arrowAt - half, y: p.top + h - into - half };
    }
  });

  private frame = 0;
  private lastRun = -1;

  constructor() {
    const measure = () => {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => this.measureNow());
    };
    // a new run: work out which steps fit this page, and start at the first
    effect(() => {
      const run = this.tour.run();
      const active = this.tour.active();
      untracked(() => {
        if (!active || run === this.lastRun) return;
        this.lastRun = run;
        const usable = usableSteps(TOUR_STEPS, this.canEdit(), (sel) => !!document.querySelector(sel));
        if (!usable.length) return this.tour.end();
        this.steps.set(usable);
        this.index.set(0);
        measure();
      });
    });
    // each step: bring its part into view and frame it
    effect(() => {
      this.step();
      if (this.tour.active()) untracked(() => measure());
    });
    // the card's own size decides where it fits
    effect(() => {
      const el = this.card()?.nativeElement;
      if (!el) return;
      untracked(() => {
        const r = el.getBoundingClientRect();
        if (r.width && (Math.round(r.width) !== this.cardSize().w || Math.round(r.height) !== this.cardSize().h)) this.cardSize.set({ w: Math.round(r.width), h: Math.round(r.height) });
      });
    });
    // the page moves under the tour (window resized, panels dragged): follow it
    const follow = () => {
      this.view.set({ w: window.innerWidth, h: window.innerHeight });
      if (this.tour.active()) measure();
    };
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, true);
    // keys belong to the tour while it is open (capture: before the editor or the browser see them)
    const onKey = (e: KeyboardEvent) => {
      if (!this.tour.active()) return;
      if (e.key === 'Escape') this.take(e, () => this.finish());
      else if (e.key === 'ArrowRight') this.take(e, () => this.advance());
      else if (e.key === 'ArrowLeft') this.take(e, () => this.back());
      else if (e.key === 'Tab') this.trapTab(e);
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') this.take(e, () => undefined); // no menu on top of the tour
    };
    window.addEventListener('keydown', onKey, true);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('resize', follow);
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('keydown', onKey, true);
      cancelAnimationFrame(this.frame);
    });
    afterNextRender(() => this.view.set({ w: window.innerWidth, h: window.innerHeight }));
  }

  private take(e: Event, then: () => void): void {
    e.preventDefault();
    e.stopImmediatePropagation();
    then();
  }

  /** Tab stays among the card's buttons while the tour is open. */
  private trapTab(e: KeyboardEvent): void {
    const buttons = Array.from(this.card()?.nativeElement.querySelectorAll<HTMLElement>('button') ?? []);
    if (!buttons.length) return;
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const to = e.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length;
    this.take(e, () => buttons[to].focus());
  }

  private measureNow(): void {
    const s = this.step();
    if (!s || !this.tour.active()) return;
    const el = document.querySelector<HTMLElement>(s.target);
    if (!el) return;
    const r0 = el.getBoundingClientRect();
    // a part that is off screen (a tall page, a small window) is brought into view first
    if (r0.top < 0 || r0.bottom > window.innerHeight) el.scrollIntoView?.({ block: 'nearest', behavior: 'instant' as ScrollBehavior });
    const r = el.getBoundingClientRect();
    this.spot.set(padBox({ x: r.left, y: r.top, w: r.width, h: r.height }));
    queueMicrotask(() => this.nextBtn()?.nativeElement.focus());
  }

  protected advance(): void {
    if (this.last()) return this.finish();
    this.index.update((i) => i + 1);
  }

  protected back(): void {
    this.index.update((i) => Math.max(0, i - 1));
  }

  protected finish(): void {
    this.tour.end();
    this.spot.set(null);
  }
}
