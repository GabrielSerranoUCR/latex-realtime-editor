import { describe, expect, it } from 'vitest';
import { mcpConfig } from './tokens.service';

describe('mcpConfig', () => {
  it('is valid JSON naming the server, the address and the token', () => {
    const cfg = JSON.parse(mcpConfig('https://quill.example', 'qq_abc'));
    const server = cfg.mcpServers['gilded-quill'];
    expect(server.command).toBe('node');
    expect(server.env).toEqual({ QUILL_URL: 'https://quill.example', QUILL_TOKEN: 'qq_abc' });
    expect(server.args[0]).toContain('mcp/src/server.mjs');
  });
});
