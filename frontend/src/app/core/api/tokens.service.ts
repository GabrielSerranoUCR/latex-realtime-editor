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

/** The JSON an MCP client (Claude Desktop and others) needs to start the Gilded Quill server with this token. */
export function mcpConfig(origin: string, token: string): string {
  return JSON.stringify(
    { mcpServers: { 'gilded-quill': { command: 'node', args: ['/path/to/latex-realtime-editor/mcp/src/server.mjs'], env: { QUILL_URL: origin, QUILL_TOKEN: token } } } },
    null,
    2,
  );
}
