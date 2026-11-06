import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface AccessToken {
  id: string;
  name: string;
  /** May change scrolls (otherwise read and compile only). */
  write: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** Personal access tokens: how an AI assistant (through the MCP server) acts as you. */
@Injectable({ providedIn: 'root' })
export class TokensService {
  private readonly http = inject(HttpClient);

  list = () => firstValueFrom(this.http.get<AccessToken[]>('/api/me/tokens'));
  /** The returned `token` is shown once: it is not kept anywhere on the server in a form that can be read back. */
  create = (name: string, write: boolean, days: number | null) => firstValueFrom(this.http.post<AccessToken & { token: string }>('/api/me/tokens', { name, write, days }));
  revoke = (id: string) => firstValueFrom(this.http.delete<void>(`/api/me/tokens/${id}`));
}

export type Harness = 'claude-code' | 'codex' | 'antigravity' | 'other';

export interface Snippet {
  id: Harness;
  label: string;
  /** Where it goes. */
  where: string;
  text: string;
}

const jsonConfig = (origin: string, token: string): string =>
  JSON.stringify({ mcpServers: { 'gilded-quill': { command: 'npx', args: ['-y', 'quill-mcp'], env: { QUILL_URL: origin, QUILL_TOKEN: token } } } }, null, 2);

/** How to connect each kind of AI harness to this server with this token: all of them run `npx -y quill-mcp`, each is told in its own way. */
export function mcpSnippets(origin: string, token: string): Snippet[] {
  return [
    { id: 'claude-code', label: 'Claude Code', where: 'Run this in a terminal:', text: `claude mcp add gilded-quill -e QUILL_URL=${origin} -e QUILL_TOKEN=${token} -- npx -y quill-mcp` },
    {
      id: 'codex',
      label: 'Codex',
      where: 'Add this to ~/.codex/config.toml:',
      text: `[mcp_servers.gilded-quill]\ncommand = "npx"\nargs = ["-y", "quill-mcp"]\nenv = { QUILL_URL = "${origin}", QUILL_TOKEN = "${token}" }`,
    },
    { id: 'antigravity', label: 'Antigravity', where: "Add this to Antigravity's MCP configuration (Manage MCP servers → View raw config):", text: jsonConfig(origin, token) },
    { id: 'other', label: 'Other', where: 'Most MCP clients take this in their configuration (on Windows, use "cmd" with args ["/c", "npx", "-y", "quill-mcp"]):', text: jsonConfig(origin, token) },
  ];
}
