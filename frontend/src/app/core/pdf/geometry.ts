/** Pure layout maths for the PDF preview. Lengths are in PDF points unless the name says `px`. */

/**
 * The CSS scale that makes a page `pageHeight` points tall fit `containerPx` (minus `paddingPx` above and below),
 * times the user's zoom: the preview adjusts to the panel's height, not its width.
 */
export function pageScale(containerPx: number, pageHeight: number, zoom: number, paddingPx = 20): number {
  const fit = Math.max(40, containerPx - 2 * paddingPx) / Math.max(1, pageHeight);
  return fit * Math.min(4, Math.max(0.25, zoom));
}

/** Where a click landed on a page: points from its top-left corner (what SyncTeX speaks), or null outside the page. */
export function pointOnPage(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, scale: number): { x: number; y: number } | null {
  if (scale <= 0 || clientX < rect.left || clientY < rect.top || clientX > rect.left + rect.width || clientY > rect.top + rect.height) return null;
  return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
}

/** Keep the reader at the same place in the document when the pages are rebuilt (a new build, a resize). */
export function restoredScrollTop(oldTop: number, oldHeight: number, newHeight: number): number {
  return oldHeight > 0 ? (oldTop / oldHeight) * newHeight : 0;
}
