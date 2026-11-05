import { describe, expect, it } from 'vitest';
import { CARD_GAP, EDGE, TOUR_STEPS, padBox, placeCard, usableSteps } from './tour';
import { TourService } from './tour.service';

const view = { w: 1440, h: 1024 };
const card = { w: 360, h: 279 };

describe('placeCard', () => {
  it('puts the card to the right of a tall panel on the left, with the arrow on its left edge (as in the design)', () => {
    const spot = padBox({ x: 12, y: 80, w: 236, h: 750 });
    const p = placeCard(spot, card, view, 'right');
    expect(p.side).toBe('right');
    expect(p.left).toBe(spot.x + spot.w + CARD_GAP);
    expect(p.arrowOn).toBe('left');
    expect(p.top).toBeGreaterThanOrEqual(EDGE);
    expect(p.top + card.h).toBeLessThanOrEqual(view.h - EDGE);
  });

  it('goes below a button at the top, centred under it and kept on screen', () => {
    const spot = padBox({ x: 1322, y: 14, w: 91, h: 40 });
    const p = placeCard(spot, card, view, 'below');
    expect(p.side).toBe('below');
    expect(p.top).toBe(spot.y + spot.h + CARD_GAP);
    expect(p.left + card.w).toBeLessThanOrEqual(view.w - EDGE); // not off the right edge
    expect(p.arrowOn).toBe('top');
    // the arrow still points at the button
    expect(p.left + p.arrowAt).toBeGreaterThan(spot.x);
    expect(p.left + p.arrowAt).toBeLessThan(spot.x + spot.w);
  });

  it('uses another side when the preferred one has no room', () => {
    const spot = padBox({ x: 1100, y: 200, w: 320, h: 300 }); // close to the right edge
    expect(placeCard(spot, card, view, 'right').side).toBe('left');
    const low = padBox({ x: 400, y: 900, w: 200, h: 100 }); // close to the bottom
    expect(placeCard(low, card, view, 'below').side).toBe('above');
  });

  it('never leaves the window, even in a small one', () => {
    const small = { w: 500, h: 400 };
    const p = placeCard(padBox({ x: 200, y: 150, w: 100, h: 100 }), card, small, 'right');
    expect(p.left).toBeGreaterThanOrEqual(EDGE);
    expect(p.top).toBeGreaterThanOrEqual(EDGE);
    expect(p.left + card.w).toBeLessThanOrEqual(small.w - EDGE);
    expect(p.top + card.h).toBeLessThanOrEqual(small.h - EDGE);
  });
});

describe('usableSteps', () => {
  const all = () => true;
  it('has the four steps of the design, the Tavern Hall first', () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual(['hall', 'desk', 'compile', 'share']);
    expect(TOUR_STEPS[0].title).toBe('Welcome to the Tavern Hall');
  });
  it('drops the Compile step for readers, and any step whose part is not on the page', () => {
    expect(usableSteps(TOUR_STEPS, true, all)).toHaveLength(4);
    expect(usableSteps(TOUR_STEPS, false, all).map((s) => s.id)).toEqual(['hall', 'desk', 'share']);
    expect(usableSteps(TOUR_STEPS, true, (sel) => !sel.includes('hall')).map((s) => s.id)).toEqual(['desk', 'compile', 'share']);
  });
});

describe('TourService', () => {
  const fresh = () => {
    const t = new TourService();
    globalThis.localStorage?.removeItem('quill.tour.v1');
    return t;
  };

  it('opens by itself once, then remembers it was seen', () => {
    const t = fresh();
    expect(t.shouldAutoStart('', false)).toBe(true);
    t.start();
    expect(t.active()).toBe(true);
    t.end();
    expect(t.active()).toBe(false);
    expect(t.seen()).toBe(true);
    expect(t.shouldAutoStart('', false)).toBe(false);
    globalThis.localStorage?.removeItem('quill.tour.v1');
  });

  it('does not open by itself for automated browsers, but ?tour=1 always asks for it', () => {
    const t = fresh();
    expect(t.shouldAutoStart('', true)).toBe(false);
    expect(t.shouldAutoStart('?tour=1', true)).toBe(true);
    t.end();
    expect(t.shouldAutoStart('?tour=1', false)).toBe(true);
    expect(t.shouldAutoStart('?tour=0', false)).toBe(false);
    globalThis.localStorage?.removeItem('quill.tour.v1');
  });

  it('every start begins afresh', () => {
    const t = fresh();
    const a = t.run();
    t.start();
    t.end();
    t.start();
    expect(t.run()).toBe(a + 2);
    t.end();
    globalThis.localStorage?.removeItem('quill.tour.v1');
  });
});
