/** This scribe's own preferences. They are kept in this browser: they shape how the tavern looks and behaves for you. */

export type QuietHours = 'off' | 'evenings' | 'nights';
/** The three halls the whole tavern can be dressed as. */
export type ThemeId = 'tavern' | 'royal' | 'caves';
export const THEMES: Array<{ id: ThemeId; name: string; blurb: string }> = [
  { id: 'tavern', name: "Quill's Tavern", blurb: 'Dark oak, brass and candlelight.' },
  { id: 'royal', name: 'Royal Chambers', blurb: 'White marble with threads of gold.' },
  { id: 'caves', name: "Dwarves' Caves", blurb: 'Black stone with veins of blue crystal.' },
];

export type EditorFont = 'jetbrains' | 'system' | 'courier';

export interface Prefs {
  // how the whole tavern looks
  theme: ThemeId;
  // profile: what other scribes see of you
  showMyCursor: boolean;
  appearPresent: boolean;
  // in the tavern (notifications)
  notifyMentions: boolean;
  desktopNotifications: boolean;
  bell: boolean;
  joinLeave: boolean;
  quietHours: QuietHours;
  // compiler
  autoCompile: boolean;
  showWarnings: boolean;
  // editor
  fontFamily: EditorFont;
  fontSize: number;
  lineHeight: number;
  lineNumbers: boolean;
  wrapLines: boolean;
  autoClose: boolean;
  spellcheck: boolean;
  // collaboration
  showOthersCursors: boolean;
  showNameFlags: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'tavern',
  showMyCursor: true,
  appearPresent: true,
  notifyMentions: true,
  desktopNotifications: false,
  bell: false,
  joinLeave: true,
  quietHours: 'off',
  autoCompile: false,
  showWarnings: true,
  fontFamily: 'jetbrains',
  fontSize: 15,
  lineHeight: 24,
  lineNumbers: true,
  wrapLines: true,
  autoClose: true,
  spellcheck: false,
  showOthersCursors: true,
  showNameFlags: true,
};

export const FONT_SIZE = [10, 28] as const;
export const LINE_HEIGHT = [14, 48] as const;

export const FONT_STACKS: Record<EditorFont, string> = {
  jetbrains: "'JetBrains Mono', ui-monospace, monospace",
  system: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  courier: "'Courier New', Courier, monospace",
};
export const FONT_LABELS: Record<EditorFont, string> = { jetbrains: 'JetBrains Mono', system: 'System monospace', courier: 'Courier' };

export const QUIET_LABELS: Record<QuietHours, string> = { off: 'Off', evenings: 'Evenings (20:00 – 08:00)', nights: 'Nights (22:00 – 07:00)' };

const FONTS = Object.keys(FONT_STACKS) as EditorFont[];
const THEME_IDS = THEMES.map((t) => t.id);
const QUIET = Object.keys(QUIET_LABELS) as QuietHours[];

/**
 * What the browser's storage gives back is not to be trusted: take each value only if it is the right kind
 * and in range, otherwise use the default for that one setting.
 */
export function parsePrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (k: keyof Prefs): boolean => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (DEFAULT_PREFS[k] as boolean));
  const int = (k: 'fontSize' | 'lineHeight', [lo, hi]: readonly [number, number]): number => {
    const v = r[k];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : DEFAULT_PREFS[k];
  };
  return {
    theme: THEME_IDS.includes(r['theme'] as ThemeId) ? (r['theme'] as ThemeId) : DEFAULT_PREFS.theme,
    showMyCursor: bool('showMyCursor'),
    appearPresent: bool('appearPresent'),
    notifyMentions: bool('notifyMentions'),
    desktopNotifications: bool('desktopNotifications'),
    bell: bool('bell'),
    joinLeave: bool('joinLeave'),
    quietHours: QUIET.includes(r['quietHours'] as QuietHours) ? (r['quietHours'] as QuietHours) : DEFAULT_PREFS.quietHours,
    autoCompile: bool('autoCompile'),
    showWarnings: bool('showWarnings'),
    fontFamily: FONTS.includes(r['fontFamily'] as EditorFont) ? (r['fontFamily'] as EditorFont) : DEFAULT_PREFS.fontFamily,
    fontSize: int('fontSize', FONT_SIZE),
    lineHeight: int('lineHeight', LINE_HEIGHT),
    lineNumbers: bool('lineNumbers'),
    wrapLines: bool('wrapLines'),
    autoClose: bool('autoClose'),
    spellcheck: bool('spellcheck'),
    showOthersCursors: bool('showOthersCursors'),
    showNameFlags: bool('showNameFlags'),
  };
}

/** Are quiet hours in effect at `now`? (Windows may span midnight.) */
export function isQuiet(q: QuietHours, now: Date = new Date()): boolean {
  if (q === 'off') return false;
  const h = now.getHours() + now.getMinutes() / 60;
  const [from, to] = q === 'evenings' ? [20, 8] : [22, 7];
  return h >= from || h < to;
}
