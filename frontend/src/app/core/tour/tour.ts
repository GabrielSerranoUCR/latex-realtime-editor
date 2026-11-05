/** The guided tour of the editor: which parts it points at, what it says, and where the card goes. Pure logic. */

export type Side = 'right' | 'left' | 'below' | 'above';

export interface TourStep {
  id: string;
  /** CSS selector of the part of the page to light up. */
  target: string;
  title: string;
  body: string;
  /** The side of the lit-up part the card prefers. */
  side: Side;
  /** Only for scribes (it points at something readers do not have). */
  needsEdit?: boolean;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'hall',
    target: '[data-tour="hall"]',
    title: 'Welcome to the Tavern Hall',
    body: 'Every file in your scroll sits at a table. Pull up a table for each chapter or figure set, then open the hall to see everyone at a glance — as a tavern or a list.',
    side: 'right',
  },
  {
    id: 'desk',
    target: '[data-tour="desk"]',
    title: 'Write together',
    body: 'Everyone at the table edits the same scroll, live. Coloured cursors show where each scribe is. Press ⌘K any time to find a command, a file or some help.',
    side: 'left',
  },
  {
    id: 'compile',
    target: '[data-tour="compile"]',
    title: 'Ink the scroll',
    body: 'Press Compile (or ⌘↵) and the PDF appears in the Scroll Preview for everyone. Warnings and errors land in the Ink Log, and errors are marked on their lines.',
    side: 'below',
    needsEdit: true,
  },
  {
    id: 'share',
    target: '[data-tour="share"]',
    title: 'Bring in more scribes',
    body: 'Share invites people by email, or makes a link for editing or one for viewing. Leave margin notes, and travel back through History if you ever need an older version.',
    side: 'below',
  },
];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How far the lit-up frame stands off the thing it frames. */
export const SPOT_PAD = 2;
/** The gap between the lit-up frame and the card (the arrow lives in it). */
export const CARD_GAP = 28;
/** Keep the card this far from the window's edge. */
export const EDGE = 12;

export const padBox = (b: Box, pad = SPOT_PAD): Box => ({ x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad });

export interface CardPlace {
  left: number;
  top: number;
  /** The side of the card the arrow is on (it faces the lit-up part). */
  arrowOn: 'left' | 'right' | 'top' | 'bottom';
  /** Where the arrow sits along that side, in px from the card's start edge. */
  arrowAt: number;
  side: Side;
}

const ORDER: Record<Side, Side[]> = {
  right: ['right', 'left', 'below', 'above'],
  left: ['left', 'right', 'below', 'above'],
  below: ['below', 'above', 'right', 'left'],
  above: ['above', 'below', 'right', 'left'],
};

/**
 * Put the card beside the lit-up part, on the preferred side if it fits and on another if not, never off
 * screen. The arrow points at the middle of the part (kept clear of the card's rounded corners).
 */
export function placeCard(spot: Box, card: { w: number; h: number }, view: { w: number; h: number }, prefer: Side): CardPlace {
  const clampX = (x: number) => Math.max(EDGE, Math.min(view.w - card.w - EDGE, x));
  const clampY = (y: number) => Math.max(EDGE, Math.min(view.h - card.h - EDGE, y));
  const centreX = spot.x + spot.w / 2;
  const centreY = spot.y + spot.h / 2;
  const fits: Record<Side, boolean> = {
    right: spot.x + spot.w + CARD_GAP + card.w + EDGE <= view.w,
    left: spot.x - CARD_GAP - card.w - EDGE >= 0,
    below: spot.y + spot.h + CARD_GAP + card.h + EDGE <= view.h,
    above: spot.y - CARD_GAP - card.h - EDGE >= 0,
  };
  const side = ORDER[prefer].find((s) => fits[s]) ?? prefer;
  const arrowIn = (at: number, size: number) => Math.max(24, Math.min(size - 24, at));
  switch (side) {
    case 'right':
    case 'left': {
      const top = clampY(centreY - card.h / 2 - (spot.h > view.h * 0.6 ? card.h * 0.1 : 0));
      const left = clampX(side === 'right' ? spot.x + spot.w + CARD_GAP : spot.x - CARD_GAP - card.w);
      return { left, top, side, arrowOn: side === 'right' ? 'left' : 'right', arrowAt: arrowIn(centreY - top, card.h) };
    }
    default: {
      const left = clampX(centreX - card.w / 2);
      const top = clampY(side === 'below' ? spot.y + spot.h + CARD_GAP : spot.y - CARD_GAP - card.h);
      return { left, top, side, arrowOn: side === 'below' ? 'top' : 'bottom', arrowAt: arrowIn(centreX - left, card.w) };
    }
  }
}

/** The steps that make sense for this scribe and this page: the target must exist, and readers skip the Compile step. */
export function usableSteps(steps: readonly TourStep[], canEdit: boolean, exists: (selector: string) => boolean): TourStep[] {
  return steps.filter((s) => (!s.needsEdit || canEdit) && exists(s.target));
}
