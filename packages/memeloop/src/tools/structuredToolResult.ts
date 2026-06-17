import type { DetailReference } from '../conversation/index.js';

/**
 * Tools may attach this key to their return object so `taskAgent` persists
 * `summary` + optional `detailRef` instead of `JSON.stringify` of the whole payload (plan §5.2.1).
 */
export const MEMELOOP_STRUCTURED_TOOL_KEY = '__memeloopToolResult' as const;

/** Truncate tool summary for persisted `ChatMessage` / LLM context (plan §5.2.1). */
export function truncateToolSummary(s: string, max = 2000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

export interface MemeloopStructuredToolPayload {
  /** Short text for the tool message body (≤2000 chars recommended). */
  summary: string;
  detailRef?: DetailReference;
  /**
   * When set, `taskAgent` pauses after persisting this tool row until `waitForTerminalSession` resolves
   * (terminal `await` mode, plan §16.4.1).
   */
  awaitSessionId?: string;
}

export function extractMemeloopStructuredToolPayload(
  raw: unknown,
): MemeloopStructuredToolPayload | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const payload = o[MEMELOOP_STRUCTURED_TOOL_KEY];
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.summary !== 'string' || p.summary.length === 0) return null;
  const awaitSessionId = typeof p.awaitSessionId === 'string' && p.awaitSessionId.length > 0
    ? p.awaitSessionId
    : undefined;
  return {
    summary: p.summary,
    detailRef: p.detailRef as MemeloopStructuredToolPayload['detailRef'],
    awaitSessionId,
  };
}
