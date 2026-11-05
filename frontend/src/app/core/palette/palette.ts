/** The kinds the menu can be narrowed to: ⌘1 is everything, ⌘2 to ⌘4 one kind each. */
export const PALETTE_FILTERS: ReadonlyArray<{ key: string; label: string; only: PaletteSection | null }> = [
  { key: '1', label: 'All', only: null },
  { key: '2', label: 'Actions', only: 'Actions' },
  { key: '3', label: 'Files', only: 'Files' },
  { key: '4', label: 'Help', only: 'Help' },
];

/** One thing the command menu can do or open. */
export interface PaletteItem {
  id: string;
  section: PaletteSection;
  /** A single glyph shown before the title. */
  icon: string;
  title: string;
  /** The italic line under the title. */
  hint: string;
  /** Shortcut shown on the right, e.g. "⌘B". */
  keys?: string;
  run: () => void;
}

export type PaletteSection = 'Actions' | 'Files' | 'Help';
export const PALETTE_SECTIONS: readonly PaletteSection[] = ['Actions', 'Files', 'Help'];

/** With nothing typed, files would drown everything else: show just a few. */
export const EMPTY_QUERY_FILES = 4;
/** Most results shown per section while typing. */
export const MAX_PER_SECTION = 8;

/** How well `text` matches `query` (0 = not at all): the start of a word beats a match in the middle. */
export function matchScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.split(/[\s/._-]+/).some((w) => w.startsWith(q))) return 60;
  if (t.includes(q)) return 40;
  // every letter in order ("tvhl" finds "Tavern Hall")
  let at = 0;
  for (const ch of q) {
    at = t.indexOf(ch, at);
    if (at < 0) return 0;
    at++;
  }
  return 10;
}

/**
 * The items to show for what has been typed, in the order Actions, Files, Help (best match first
 * inside each). Every word of the query must match the title or the hint.
 */
export function filterPalette(items: readonly PaletteItem[], query: string, only: PaletteSection | null = null): PaletteItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out: PaletteItem[] = [];
  // looking at one kind only: show all of it, there is room
  const cap = only ? Number.POSITIVE_INFINITY : MAX_PER_SECTION;
  for (const section of only ? [only] : PALETTE_SECTIONS) {
    const mine = items.filter((i) => i.section === section);
    if (!words.length) {
      out.push(...(section === 'Files' && !only ? mine.slice(0, EMPTY_QUERY_FILES) : mine));
      continue;
    }
    const scored = mine
      .map((item) => {
        let total = 0;
        for (const w of words) {
          const s = Math.max(matchScore(item.title, w), matchScore(item.hint, w) * 0.5);
          if (!s) return { item, score: 0 };
          total += s;
        }
        return { item, score: total };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    out.push(...scored.slice(0, cap).map((x) => x.item));
  }
  return out;
}

/** A shortcut written with the Mac symbols, shown the way the keyboard has it: "⌘⇧B" stays, or becomes "Ctrl+Shift+B". */
export function shortcutLabel(keys: string, mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)): string {
  if (mac) return keys;
  return keys
    .replace('⌘', 'Ctrl+')
    .replace('⇧', 'Shift+')
    .replace('⌥', 'Alt+')
    .replace('↵', 'Enter');
}
