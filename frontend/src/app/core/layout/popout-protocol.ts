import type { CompileSnapshot, Diagnostic } from '../api/compile.service';

/** A panel that can live in its own browser window. */
export type PopPanel = 'preview' | 'log';

export const channelName = (scrollId: string): string => `quill-popout-${scrollId}`;
export const windowName = (scrollId: string, panel: PopPanel): string => `quill-${panel}-${scrollId}`;
export const popoutUrl = (scrollId: string, panel: PopPanel): string => `/scroll/${encodeURIComponent(scrollId)}/popout/${panel}`;

/** What the two windows say to each other over a BroadcastChannel (same browser, same origin). */
export type PopoutMessage =
  | { type: 'hello'; panel: PopPanel }
  | { type: 'dock'; panel: PopPanel }
  | { type: 'jump'; diagnostic: Diagnostic }
  | { type: 'snapshot'; snapshot: CompileSnapshot };

/** Anything arriving on the channel is data from another page: accept only the shapes above. */
export function parseMessage(data: unknown): PopoutMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  const panel = m['panel'];
  const isPanel = panel === 'preview' || panel === 'log';
  switch (m['type']) {
    case 'hello':
    case 'dock':
      return isPanel ? { type: m['type'], panel } : null;
    case 'jump': {
      const d = m['diagnostic'] as Partial<Diagnostic> | undefined;
      if (!d || typeof d.message !== 'string') return null;
      return { type: 'jump', diagnostic: { severity: String(d.severity ?? 'error'), file: typeof d.file === 'string' ? d.file : null, line: typeof d.line === 'number' ? d.line : null, message: d.message } };
    }
    case 'snapshot': {
      const s = m['snapshot'] as Partial<CompileSnapshot> | undefined;
      if (!s || !['idle', 'compiling', 'ok', 'failed'].includes(String(s.state))) return null;
      return { type: 'snapshot', snapshot: s as CompileSnapshot };
    }
    default:
      return null;
  }
}
