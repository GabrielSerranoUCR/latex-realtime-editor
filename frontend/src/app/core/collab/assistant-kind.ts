/** Which AI assistant is at the table. The MCP client announces itself (`claude-code`, …) and the server keeps that with the token. The token's name is never used to guess. */
export type AssistantKind = 'claude' | 'codex' | 'antigravity' | 'other';

export interface AssistantLook { kind: AssistantKind; label: string; icon: string }
export interface Assistant { name: string; agent: string | null }

const LOOKS: Record<AssistantKind, AssistantLook> = {
  claude: { kind: 'claude', label: 'Claude', icon: '/assistants/claude.png' },
  codex: { kind: 'codex', label: 'Codex', icon: '/assistants/codex.png' },
  antigravity: { kind: 'antigravity', label: 'Antigravity', icon: '/assistants/antigravity.png' },
  other: { kind: 'other', label: 'AI assistant', icon: '/assistants/default.svg' },
};

function kindOf(text: string): AssistantKind {
  const n = text.toLowerCase();
  if (/claude|anthropic/.test(n)) return 'claude';
  if (/codex|openai|chatgpt/.test(n)) return 'codex';
  if (/antigravity|gemini/.test(n)) return 'antigravity';
  return 'other';
}

/** The assistants the server lists: `{name, agent}` objects (older servers sent bare names). */
export function parseAssistants(raw: unknown): Assistant[] {
  if (!Array.isArray(raw)) return [];
  const out: Assistant[] = [];
  for (const v of raw) {
    if (typeof v === 'string') out.push({ name: v, agent: null });
    else if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') {
      const agent = (v as { agent?: unknown }).agent;
      out.push({ name: (v as { name: string }).name, agent: typeof agent === 'string' ? agent : null });
    }
  }
  return out.slice(0, 8);
}

/** Only what the client announced about itself counts; anything else gets the plain robot. */
export function assistantLook(bot: Assistant): AssistantLook {
  return LOOKS[bot.agent ? kindOf(bot.agent) : 'other'];
}
