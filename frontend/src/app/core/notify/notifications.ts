import { NoteThread } from '../collab/comments';
import { splitMentions } from '../collab/comments';
import { Prefs, isQuiet } from '../prefs/prefs';

/** What counts as news at the table, and who should hear about it. Pure; the service does the telling. */

export interface NoteEvent {
  threadId: string;
  messageId: string;
  authorName: string;
  text: string;
  file: string;
  /** The note mentions you by name. */
  mentionsMe: boolean;
}

export const mentionsMe = (text: string, myName: string): boolean => splitMentions(text, [myName], myName).some((s) => s.mention && s.you);

/** Messages in `threads` that are not in `known` and were not written by you. */
export function newNotes(known: ReadonlySet<string>, threads: readonly NoteThread[], meId: string | null, myName: string): { events: NoteEvent[]; ids: Set<string> } {
  const ids = new Set<string>();
  const events: NoteEvent[] = [];
  for (const t of threads)
    for (const m of t.messages) {
      ids.add(m.id);
      if (known.has(m.id) || (meId && m.authorId === meId)) continue;
      events.push({ threadId: t.id, messageId: m.id, authorName: m.authorName, text: m.text, file: t.file, mentionsMe: mentionsMe(m.text, myName) });
    }
  return { events, ids };
}

/** Who sat down and who got up between two looks at the table (by connection id). */
export function joinedAndLeft(before: ReadonlyMap<number, string>, now: ReadonlyMap<number, string>): { joined: string[]; left: string[] } {
  const joined = [...now].filter(([id]) => !before.has(id)).map(([, name]) => name);
  const left = [...before].filter(([id]) => !now.has(id)).map(([, name]) => name);
  return { joined, left };
}

export interface Delivery {
  toast: boolean;
  desktop: boolean;
  bell: boolean;
}

/** How to tell you about a new note, given your preferences, quiet hours and whether the tab is in view. */
export function deliveryFor(e: NoteEvent, prefs: Prefs, now: Date, tabHidden: boolean): Delivery {
  if (isQuiet(prefs.quietHours, now)) return { toast: false, desktop: false, bell: false };
  const wanted = prefs.notifyMentions;
  return { toast: wanted, desktop: wanted && prefs.desktopNotifications && tabHidden, bell: prefs.bell };
}

export function describeNote(e: NoteEvent): { title: string; body: string } {
  const body = e.text.length > 140 ? e.text.slice(0, 139) + '…' : e.text;
  return { title: e.mentionsMe ? `${e.authorName} mentioned you` : `${e.authorName} wrote a margin note`, body };
}
