import { describe, expect, it } from 'vitest';
import { describeAgent, passwordStrength, sessionWhen, shortName } from './account-utils';

describe('passwordStrength', () => {
  it('calls anything under 10 characters too short, as the server does', () => {
    expect(passwordStrength('')).toEqual({ score: 0, label: 'too short' });
    expect(passwordStrength('Abc123!xy')).toEqual({ score: 0, label: 'too short' });
  });
  it('grows with length and variety', () => {
    expect(passwordStrength('abcdefghij').label).toBe('weak');
    expect(passwordStrength('Abcdefg123hij').label).toBe('fair');
    expect(passwordStrength('correct horse battery').score).toBeGreaterThanOrEqual(3);
    expect(passwordStrength('correct horse battery staple 42!').label).toBe('strong');
  });
  it('does not reward repetition', () => expect(passwordStrength('aaaaaaaaaaaaaaaaaaaaaaaa').label).toBe('weak'));
  it('counts characters, not bytes', () => expect(passwordStrength('éééééééééé').label).not.toBe('too short'));
});

describe('describeAgent', () => {
  const ua = {
    safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0',
    firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  };
  it('names the browser and system', () => {
    expect(describeAgent(ua.safariMac)).toEqual({ label: 'Safari on macOS', kind: 'computer' });
    expect(describeAgent(ua.chromeWin).label).toBe('Chrome on Windows');
    expect(describeAgent(ua.edge).label).toBe('Edge on Windows');
    expect(describeAgent(ua.firefoxLinux).label).toBe('Firefox on Linux');
  });
  it('tells phones and tablets apart', () => {
    expect(describeAgent(ua.iphone)).toEqual({ label: 'Safari on iOS', kind: 'phone' });
    expect(describeAgent(ua.ipad)).toEqual({ label: 'Safari on iPadOS', kind: 'tablet' });
    expect(describeAgent(ua.androidChrome)).toEqual({ label: 'Chrome on Android', kind: 'phone' });
  });
  it('copes with nothing and with nonsense', () => {
    expect(describeAgent('').label).toBe('An unknown device');
    expect(describeAgent('curl/8.0').label).toBe('A browser on an unknown system');
  });
});

describe('sessionWhen', () => {
  const now = new Date(2026, 10, 5, 12).getTime();
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  it('says this device for the current session', () => expect(sessionWhen(ago(99999), true, now)).toBe('this device'));
  it('counts in hours, days, weeks and months', () => {
    expect(sessionWhen(ago(60), false, now)).toBe('signed in a moment ago');
    expect(sessionWhen(ago(3 * 3600), false, now)).toBe('signed in 3 hours ago');
    expect(sessionWhen(ago(86400), false, now)).toBe('signed in 1 day ago');
    expect(sessionWhen(ago(2 * 86400), false, now)).toBe('signed in 2 days ago');
    expect(sessionWhen(ago(15 * 86400), false, now)).toBe('signed in 2 weeks ago');
    expect(sessionWhen(ago(70 * 86400), false, now)).toBe('signed in 2 months ago');
  });
});

describe('shortName', () => {
  it('uses the first word, skipping a title', () => {
    expect(shortName('Gabriel Serrano')).toBe('Gabriel');
    expect(shortName('Dame Aelith')).toBe('Aelith');
    expect(shortName('Sir')).toBe('Sir');
    expect(shortName('  ')).toBe('  ');
  });
});
