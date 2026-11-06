import { assistantLook, parseAssistants } from './assistant-kind';

describe('assistantLook', () => {
  it('goes by what the client announced', () => {
    expect(assistantLook({ name: 'my laptop', agent: 'claude-code' }).kind).toBe('claude');
    expect(assistantLook({ name: 'x', agent: 'codex-mcp-client' }).kind).toBe('codex');
    expect(assistantLook({ name: 'x', agent: 'antigravity-client' }).kind).toBe('antigravity');
  });
  it('never guesses from the token name', () => {
    expect(assistantLook({ name: 'Claude Code on my laptop', agent: null }).icon).toBe('/assistants/default.svg');
    expect(assistantLook({ name: 'Claude', agent: 'some-client' }).kind).toBe('other');
  });
});

describe('parseAssistants', () => {
  it('reads objects and legacy bare names, ignores junk', () => {
    expect(parseAssistants([{ name: 'A', agent: 'claude-code' }, 'B', 3, { name: 'C' }])).toEqual([
      { name: 'A', agent: 'claude-code' },
      { name: 'B', agent: null },
      { name: 'C', agent: null },
    ]);
    expect(parseAssistants('nope')).toEqual([]);
  });
});
