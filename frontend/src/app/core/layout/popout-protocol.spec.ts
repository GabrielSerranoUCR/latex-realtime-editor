import { describe, expect, it } from 'vitest';
import { channelName, parseMessage, popoutUrl, windowName } from './popout-protocol';

describe('pop-out protocol', () => {
  it('names things per scroll and escapes the id in URLs', () => {
    expect(channelName('abc')).toBe('quill-popout-abc');
    expect(windowName('abc', 'log')).toBe('quill-log-abc');
    expect(popoutUrl('a/b', 'preview')).toBe('/scroll/a%2Fb/popout/preview');
  });

  it('accepts well-formed messages', () => {
    expect(parseMessage({ type: 'hello', panel: 'preview' })).toEqual({ type: 'hello', panel: 'preview' });
    expect(parseMessage({ type: 'dock', panel: 'log' })).toEqual({ type: 'dock', panel: 'log' });
    expect(parseMessage({ type: 'jump', diagnostic: { severity: 'error', file: 'a.tex', line: 3, message: 'oops' } })).toEqual({ type: 'jump', diagnostic: { severity: 'error', file: 'a.tex', line: 3, message: 'oops' } });
    expect(parseMessage({ type: 'snapshot', snapshot: { state: 'ok', result: null, fatalError: null, pdfUrl: '/api/rooms/x/pdf', pdfBuiltAt: 1 } })?.type).toBe('snapshot');
  });

  it('normalises a jump so nothing odd reaches the editor', () => {
    expect(parseMessage({ type: 'jump', diagnostic: { severity: 7, file: { evil: 1 }, line: 'x', message: 'm', extra: '<b>' } })).toEqual({ type: 'jump', diagnostic: { severity: '7', file: null, line: null, message: 'm' } });
  });

  it.each([
    ['null', null], ['a string', 'dock'], ['an unknown type', { type: 'explode' }],
    ['a bad panel', { type: 'dock', panel: 'editor' }], ['a missing panel', { type: 'hello' }],
    ['a jump without a message', { type: 'jump', diagnostic: { file: 'a.tex' } }],
    ['a snapshot with a bad state', { type: 'snapshot', snapshot: { state: 'weird' } }],
    ['a snapshot with nothing', { type: 'snapshot' }],
  ])('rejects %s', (_, data) => expect(parseMessage(data)).toBeNull());
});
