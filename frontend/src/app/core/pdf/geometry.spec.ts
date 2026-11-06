import { pageScale, pointOnPage, restoredScrollTop } from './geometry';

describe('pdf geometry', () => {
  it('fits the page to the panel, then applies the zoom', () => {
    expect(pageScale(632, 600, 1)).toBeCloseTo(1, 5); // 632 - 2*16 = 600
    expect(pageScale(632, 600, 2)).toBeCloseTo(2, 5);
    expect(pageScale(632, 600, 100)).toBeCloseTo(4, 5); // zoom is capped
  });

  it('turns a click into points from the page corner, and ignores clicks outside it', () => {
    const rect = { left: 100, top: 50, width: 600, height: 800 };
    expect(pointOnPage(250, 150, rect, 2)).toEqual({ x: 75, y: 50 });
    expect(pointOnPage(99, 150, rect, 2)).toBeNull();
    expect(pointOnPage(250, 851, rect, 2)).toBeNull();
    expect(pointOnPage(250, 150, rect, 0)).toBeNull();
  });

  it('keeps the same relative place when the pages change height', () => {
    expect(restoredScrollTop(500, 2000, 4000)).toBe(1000);
    expect(restoredScrollTop(500, 0, 4000)).toBe(0);
  });
});
