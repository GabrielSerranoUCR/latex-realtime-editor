import { describe, expect, it } from 'vitest';
import { formatCountdown } from './countdown';

describe('formatCountdown', () => {
  it('writes minutes and two-digit seconds', () => {
    expect(formatCountdown(42)).toBe('0:42');
    expect(formatCountdown(60)).toBe('1:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(9)).toBe('0:09');
  });
  it('never goes below zero and rounds partial seconds up', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-3)).toBe('0:00');
    expect(formatCountdown(0.2)).toBe('0:01');
  });
});
