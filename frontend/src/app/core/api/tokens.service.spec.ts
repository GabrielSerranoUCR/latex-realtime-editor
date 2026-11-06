import { describe, expect, it } from 'vitest';
import { mcpSnippets } from './tokens.service';

describe('mcpSnippets', () => {
  const by = (id: string) => mcpSnippets('https://quill.example', 'qq_abc').find((s) => s.id === id)!;

  it('gives Claude Code a one-line command that runs quill-mcp through npx with the address and token', () => {
    expect(by('claude-code').text).toBe('claude mcp add gilded-quill -e QUILL_URL=https://quill.example -e QUILL_TOKEN=qq_abc -- npx -y quill-mcp');
  });

  it('gives Codex a TOML table', () => {
    const t = by('codex').text;
    expect(t).toContain('[mcp_servers.gilded-quill]');
    expect(t).toContain('args = ["-y", "quill-mcp"]');
    expect(t).toContain('QUILL_TOKEN = "qq_abc"');
  });

  it('gives Antigravity and the others valid JSON naming the server, address and token', () => {
    for (const id of ['antigravity', 'other']) {
      const server = JSON.parse(by(id).text).mcpServers['gilded-quill'];
      expect(server.command).toBe('npx');
      expect(server.args).toEqual(['-y', 'quill-mcp']);
      expect(server.env).toEqual({ QUILL_URL: 'https://quill.example', QUILL_TOKEN: 'qq_abc' });
    }
  });
});
