/** Small pure helpers for the profile modal. */

export interface Strength {
  /** 0 (nothing / too short) to 4. */
  score: 0 | 1 | 2 | 3 | 4;
  label: 'too short' | 'weak' | 'fair' | 'good' | 'strong';
}

/** A rough guide, not a promise: the server only insists on 10 to 128 characters. */
export function passwordStrength(pw: string): Strength {
  const n = [...pw].length;
  if (n < 10) return { score: 0, label: 'too short' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  const unique = new Set(pw).size;
  let score = 1;
  if (n >= 14 || classes >= 3) score++;
  if (n >= 16 && classes >= 2) score++;
  if (n >= 20 && unique >= 10) score++;
  if (unique < 5) score = Math.min(score, 1); // "aaaaaaaaaaaa"
  const s = Math.min(4, score) as 1 | 2 | 3 | 4;
  return { score: s, label: (['weak', 'fair', 'good', 'strong'] as const)[s - 1] };
}

export interface Device {
  label: string;
  kind: 'phone' | 'tablet' | 'computer';
}

/** "Safari on macOS" from a browser's own description of itself. */
export function describeAgent(ua: string): Device {
  if (!ua.trim()) return { label: 'An unknown device', kind: 'computer' };
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari' : 'A browser';
  let os = 'an unknown system';
  let kind: Device['kind'] = 'computer';
  if (/iPhone|iPod/.test(ua)) (os = 'iOS'), (kind = 'phone');
  else if (/iPad/.test(ua)) (os = 'iPadOS'), (kind = 'tablet');
  else if (/Android/.test(ua)) (os = 'Android'), (kind = /Mobile/.test(ua) ? 'phone' : 'tablet');
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Linux|X11/.test(ua)) os = 'Linux';
  return { label: `${browser} on ${os}`, kind };
}

/** "this device", or "signed in 2 days ago". */
export function sessionWhen(createdAt: string, current: boolean, now: number = Date.now()): string {
  if (current) return 'this device';
  const s = Math.max(0, Math.round((now - new Date(createdAt).getTime()) / 1000));
  if (s < 3600) return 'signed in a moment ago';
  const units: Array<[number, string]> = [[86400 * 30, 'month'], [86400 * 7, 'week'], [86400, 'day'], [3600, 'hour']];
  const [size, name] = units.find(([u]) => s >= u)!;
  const n = Math.floor(s / size);
  return `signed in ${n} ${name}${n === 1 ? '' : 's'} ago`;
}

/** The part of a name other scribes call you: the first word, without a title. */
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const titled = /^(Sir|Dame|Lady|Lord|Brother|Sister)$/i.test(words[0] ?? '');
  return (titled ? words[1] : words[0]) ?? name;
}
