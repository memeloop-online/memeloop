import type { ChatMessagePart } from '../conversation/types.js';
import { canonicalJsonBytes } from '../encoding/canonicalJson.js';

/** Optional list-only metadata. Older peers can safely omit this affordance. */
export interface ConversationToolActivity {
  kind: 'call' | 'result';
  name: string;
  callId?: string;
  input?: string;
  inputTruncated?: true;
  isError?: true;
}

const maximumActivityBytes = 8 * 1024;

export function readConversationToolActivity(value: unknown): readonly ConversationToolActivity[] {
  if (!Array.isArray(value) || value.length > 16) return [];
  try {
    canonicalJsonBytes(value, { maxBytes: maximumActivityBytes, maxDepth: 3, maxNodes: 150 });
  } catch {
    return [];
  }
  const result: ConversationToolActivity[] = [];
  for (const item of value as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (
      (row.kind !== 'call' && row.kind !== 'result') ||
      typeof row.name !== 'string' || row.name.length === 0 || row.name.length > 512 ||
      (row.callId !== undefined && (typeof row.callId !== 'string' || row.callId.length > 512)) ||
      (row.input !== undefined && (typeof row.input !== 'string' || row.input.length > 2048)) ||
      (row.inputTruncated !== undefined && row.inputTruncated !== true) ||
      (row.isError !== undefined && row.isError !== true)
    ) return [];
    result.push({
      kind: row.kind,
      name: row.name,
      ...(row.callId === undefined ? {} : { callId: row.callId }),
      ...(row.input === undefined ? {} : { input: row.input }),
      ...(row.inputTruncated === true ? { inputTruncated: true } : {}),
      ...(row.isError === true ? { isError: true } : {}),
    });
  }
  return result;
}

export function projectConversationToolActivity(parts: readonly ChatMessagePart[]): readonly ConversationToolActivity[] {
  const result: ConversationToolActivity[] = [];
  for (const part of parts) {
    if (part.type !== 'tool-call' && part.type !== 'tool-result') continue;
    const parameters = part.type === 'tool-call' ? part.arguments : part.parameters;
    let input: string | undefined;
    let inputTruncated = false;
    if (parameters !== undefined) {
      try {
        input = new TextDecoder().decode(canonicalJsonBytes(parameters, { maxBytes: 2048, maxDepth: 16, maxNodes: 500 }));
      } catch {
        // Do not serialize an unbounded input just to obtain a preview.
        inputTruncated = true;
      }
    }
    const item: ConversationToolActivity = {
      kind: part.type === 'tool-call' ? 'call' : 'result',
      name: part.toolName,
      ...(part.toolCallId ? { callId: part.toolCallId } : {}),
      ...(input === undefined ? {} : { input }),
      ...(inputTruncated ? { inputTruncated: true } : {}),
      ...(part.type === 'tool-result' && part.isError ? { isError: true } : {}),
    };
    const candidate = readConversationToolActivity([...result, item]);
    if (candidate.length === 0) break;
    result.push(item);
  }
  return result;
}
