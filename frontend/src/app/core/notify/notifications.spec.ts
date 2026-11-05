import { describe, expect, it } from 'vitest';
import { NoteThread } from '../collab/comments';
import { DEFAULT_PREFS } from '../prefs/prefs';
import { NoteEvent, deliveryFor, describeNote, joinedAndLeft, mentionsMe, newNotes } from './notifications';

const msg = (id: string, authorId: string, authorName: string, text: string) => ({ id, authorId, authorName, authorColor: '#C9A04A', text, at: 1 });
const thread = (id: string, messages: ReturnType<typeof msg>[], file = 'main.tex'): NoteThread => ({ id, file, anchor: { start: 0, end: 0 }, quote: 'q', resolved: false, resolvedBy: null, createdAt: 1, messages });
const event = (over: Partial<NoteEvent> = {}): NoteEvent => ({ threadId: 't', messageId: 'm', authorName: 'Marcus', text: 'hello', file: 'main.tex', mentionsMe: false, ...over });

describe('mentionsMe', () => {
  it('finds your name after an @, in any case', () => {
    expect(mentionsMe('thanks @aelith!', 'Aelith')).toBe(true);
    expect(mentionsMe('@Aelith', 'Aelith')).toBe(true);
  });
  it('is not fooled by other names, e-mail addresses or longer words', () => {
    expect(mentionsMe('@Marcus please look', 'Aelith')).toBe(false);
    expect(mentionsMe('write to me@aelith.test', 'Aelith')).toBe(false);
    expect(mentionsMe('@Aelithia', 'Aelith')).toBe(false);
  });
});

describe('newNotes', () => {
  const threads = [thread('a', [msg('1', 'me', 'Aelith', 'mine'), msg('2', 'u2', 'Marcus', 'hi @Aelith')]), thread('b', [msg('3', 'u3', 'Gabriel', 'plain')])];
  it('reports messages from others that were not seen yet, flagging mentions of you', () => {
    const { events, ids } = newNotes(new Set(['1']), threads, 'me', 'Aelith');
    expect(events.map((e) => [e.messageId, e.mentionsMe])).toEqual([['2', true], ['3', false]]);
    expect([...ids].sort()).toEqual(['1', '2', '3']);
  });
  it('never tells you about your own notes', () => expect(newNotes(new Set(), threads, 'me', 'Aelith').events.map((e) => e.messageId)).toEqual(['2', '3']));
  it('reports nothing when everything is known', () => expect(newNotes(new Set(['1', '2', '3']), threads, 'me', 'Aelith').events).toEqual([]));
});

describe('joinedAndLeft', () => {
  it('compares two looks at the table', () => {
    expect(joinedAndLeft(new Map([[1, 'A'], [2, 'B']]), new Map([[2, 'B'], [3, 'C']]))).toEqual({ joined: ['C'], left: ['A'] });
    expect(joinedAndLeft(new Map(), new Map())).toEqual({ joined: [], left: [] });
  });
});

describe('deliveryFor', () => {
  const noon = new Date(2026, 10, 5, 12);
  const night = new Date(2026, 10, 5, 23);
  it('shows a toast by default and nothing else', () => expect(deliveryFor(event(), DEFAULT_PREFS, noon, false)).toEqual({ toast: true, desktop: false, bell: false }));
  it('adds a desktop notification only when enabled and the tab is out of sight', () => {
    const prefs = { ...DEFAULT_PREFS, desktopNotifications: true };
    expect(deliveryFor(event(), prefs, noon, false).desktop).toBe(false);
    expect(deliveryFor(event(), prefs, noon, true).desktop).toBe(true);
  });
  it('rings the bell when asked, even if toasts are off', () => {
    expect(deliveryFor(event(), { ...DEFAULT_PREFS, bell: true, notifyMentions: false }, noon, false)).toEqual({ toast: false, desktop: false, bell: true });
  });
  it('is silent during quiet hours', () => {
    const prefs = { ...DEFAULT_PREFS, quietHours: 'nights' as const, desktopNotifications: true, bell: true };
    expect(deliveryFor(event(), prefs, night, true)).toEqual({ toast: false, desktop: false, bell: false });
    expect(deliveryFor(event(), prefs, noon, true).toast).toBe(true);
  });
});

describe('describeNote', () => {
  it('says who wrote or mentioned', () => {
    expect(describeNote(event({ mentionsMe: true })).title).toBe('Marcus mentioned you');
    expect(describeNote(event()).title).toBe('Marcus wrote a margin note');
  });
  it('shortens a long note', () => expect(describeNote(event({ text: 'x'.repeat(300) })).body.length).toBe(140));
});
