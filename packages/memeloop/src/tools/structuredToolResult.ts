import type { DetailReference } from '../conversation/index.js';
import { CanonicalJsonError, canonicalJsonString } from '../encoding/canonicalJson.js';

/**
 * Tools may attach this key to their return object so `agentToolLoop` persists
 * `summary` + optional `detailRef` instead of the full payload (plan §5.2.1).
 */
export const MEMELOOP_STRUCTURED_TOOL_KEY = '__memeloopToolResult' as const;

export const MAX_TOOL_RESULT_SUMMARY_CODE_UNITS = 2_000;
export const MAX_TOOL_RESULT_SUMMARY_BYTES = 8_000;
export const MAX_TOOL_RESULT_CANONICAL_BYTES = 64 * 1_024;

export const TOOL_RESULT_CANONICAL_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 4_096,
  maxStringCodeUnits: MAX_TOOL_RESULT_CANONICAL_BYTES,
  maxStringBytes: MAX_TOOL_RESULT_CANONICAL_BYTES,
  maxBytes: MAX_TOOL_RESULT_CANONICAL_BYTES,
});

export type ToolResultCanonicalizationErrorCode =
  | 'invalid_detail_reference'
  | 'invalid_structured_result'
  | 'result_too_large'
  | 'unsafe_result';

/** Stable fail-closed error for hostile or unbounded plugin return values. */
export class ToolResultCanonicalizationError extends Error {
  public constructor(public readonly code: ToolResultCanonicalizationErrorCode) {
    super(`tool_result_${code}`);
    this.name = 'ToolResultCanonicalizationError';
  }
}

export interface MemeloopStructuredToolPayload {
  /** Hard-bounded text persisted in the tool message and sent to the model. */
  summary: string;
  detailRef?: DetailReference;
  /**
   * When set, `agentToolLoop` pauses after persisting this tool row until
   * `waitForTerminalSession` resolves (terminal `await` mode, plan §16.4.1).
   */
  awaitSessionId?: string;
}

export interface CanonicalizedToolResult extends MemeloopStructuredToolPayload {
  isError: boolean;
  /** Detached strict-JSON value. The plugin-owned object is never persisted. */
  payload?: unknown;
}

/**
 * Bound a trusted summary without splitting a surrogate pair. The public
 * `max` remains useful for compact callers, but cannot raise the hard limit.
 */
export function truncateToolSummary(summary: string, max = MAX_TOOL_RESULT_SUMMARY_CODE_UNITS): string {
  const maximumCodeUnits = Number.isSafeInteger(max) && max > 0
    ? Math.min(max, MAX_TOOL_RESULT_SUMMARY_CODE_UNITS)
    : MAX_TOOL_RESULT_SUMMARY_CODE_UNITS;
  if (
    summary.length <= maximumCodeUnits &&
    strictUtf8ByteLengthWithin(summary, MAX_TOOL_RESULT_SUMMARY_BYTES)
  ) return summary;

  const suffix = maximumCodeUnits >= 3 ? '...' : '.'.repeat(maximumCodeUnits);
  const contentCodeUnits = Math.max(0, maximumCodeUnits - suffix.length);
  const contentBytes = Math.max(0, MAX_TOOL_RESULT_SUMMARY_BYTES - suffix.length);
  let output = '';
  let codeUnits = 0;
  let bytes = 0;
  for (const character of summary) {
    const characterBytes = utf8CharacterBytes(character);
    if (codeUnits + character.length > contentCodeUnits || bytes + characterBytes > contentBytes) break;
    output += character;
    codeUnits += character.length;
    bytes += characterBytes;
  }
  return `${output}${suffix}`;
}

/**
 * Convert an arbitrary plugin value into a detached, bounded representation.
 * No plugin getter, proxy coercion, `toJSON`, iterator, or `toString` runs.
 */
export function canonicalizeToolResult(raw: unknown): CanonicalizedToolResult {
  const detached = detachBoundedJson(raw);
  if (isPlainRecord(detached)) {
    if (typeof detached.error === 'string' && detached.error.length > 0) {
      return { summary: truncateToolSummary(detached.error), isError: true };
    }
    if (
      isPlainRecord(detached.error) &&
      typeof detached.error.message === 'string' &&
      detached.error.message.length > 0
    ) {
      return { summary: truncateToolSummary(detached.error.message), isError: true };
    }

    if (Object.hasOwn(detached, MEMELOOP_STRUCTURED_TOOL_KEY)) {
      const structured = validateStructuredPayload(detached[MEMELOOP_STRUCTURED_TOOL_KEY]);
      return { ...structured, isError: false };
    }

    if (Object.hasOwn(detached, 'result')) {
      return canonicalizedValue(detached.result, true);
    }
  }
  return canonicalizedValue(detached, false);
}

function canonicalizedValue(value: unknown, includePayload: boolean): CanonicalizedToolResult {
  const text = typeof value === 'string'
    ? value
    : canonicalStringFromDetached(value);
  return {
    summary: text,
    isError: false,
    ...(includePayload && typeof value !== 'string' ? { payload: value } : {}),
  };
}

function detachBoundedJson(value: unknown): unknown {
  let canonical: string;
  try {
    canonical = canonicalJsonString(value, TOOL_RESULT_CANONICAL_LIMITS);
  } catch (error) {
    if (
      error instanceof CanonicalJsonError && (
        error.code === 'max_bytes' ||
        error.code === 'max_depth' ||
        error.code === 'max_nodes' ||
        error.code === 'max_string_bytes' ||
        error.code === 'max_string_code_units'
      )
    ) {
      throw new ToolResultCanonicalizationError('result_too_large');
    }
    throw new ToolResultCanonicalizationError('unsafe_result');
  }
  return JSON.parse(canonical) as unknown;
}

function canonicalStringFromDetached(value: unknown): string {
  try {
    return canonicalJsonString(value, TOOL_RESULT_CANONICAL_LIMITS);
  } catch {
    // A detached sub-value was already encoded inside the same or a tighter
    // whole-result budget. Reaching this branch indicates an internal defect.
    throw new ToolResultCanonicalizationError('unsafe_result');
  }
}

function validateStructuredPayload(value: unknown): MemeloopStructuredToolPayload {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['summary', 'detailRef', 'awaitSessionId'])) {
    throw new ToolResultCanonicalizationError('invalid_structured_result');
  }
  if (typeof value.summary !== 'string' || value.summary.length === 0) {
    throw new ToolResultCanonicalizationError('invalid_structured_result');
  }
  const detailReference = value.detailRef === undefined
    ? undefined
    : validateDetailReference(value.detailRef);
  const awaitSessionId = value.awaitSessionId === undefined
    ? undefined
    : boundedIdentifier(value.awaitSessionId)
    ? value.awaitSessionId
    : (() => {
      throw new ToolResultCanonicalizationError('invalid_structured_result');
    })();
  return {
    summary: truncateToolSummary(value.summary),
    ...(detailReference === undefined ? {} : { detailRef: detailReference }),
    ...(awaitSessionId === undefined ? {} : { awaitSessionId }),
  };
}

function validateDetailReference(value: unknown): DetailReference {
  if (
    !isPlainRecord(value) || !hasOnlyKeys(value, [
      'type',
      'runId',
      'conversationId',
      'sessionId',
      'nodeId',
      'fileUri',
      'exitCode',
      'resourceVersion',
    ])
  ) throw new ToolResultCanonicalizationError('invalid_detail_reference');
  if (value.type !== 'agent-run' && value.type !== 'terminal-session' && value.type !== 'file') {
    throw new ToolResultCanonicalizationError('invalid_detail_reference');
  }
  for (const key of ['runId', 'conversationId', 'sessionId', 'nodeId', 'resourceVersion'] as const) {
    if (value[key] !== undefined && !boundedIdentifier(value[key])) {
      throw new ToolResultCanonicalizationError('invalid_detail_reference');
    }
  }
  if (value.fileUri !== undefined && !boundedText(value.fileUri, 2_048, false)) {
    throw new ToolResultCanonicalizationError('invalid_detail_reference');
  }
  if (
    value.exitCode !== undefined &&
    (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode))
  ) throw new ToolResultCanonicalizationError('invalid_detail_reference');
  if (
    value.type === 'agent-run' && value.runId === undefined && value.conversationId === undefined ||
    value.type === 'terminal-session' && value.sessionId === undefined ||
    value.type === 'file' && value.fileUri === undefined
  ) throw new ToolResultCanonicalizationError('invalid_detail_reference');
  const reference: DetailReference = { type: value.type };
  for (const key of ['runId', 'conversationId', 'sessionId', 'nodeId', 'resourceVersion'] as const) {
    if (typeof value[key] === 'string') reference[key] = value[key];
  }
  if (typeof value.fileUri === 'string') reference.fileUri = value.fileUri;
  if (typeof value.exitCode === 'number') reference.exitCode = value.exitCode;
  return reference;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every(key => allowed.has(key));
}

function boundedIdentifier(value: unknown): value is string {
  return boundedText(value, 512, false);
}

function boundedText(value: unknown, maxBytes: number, allowEmpty: boolean): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) &&
    strictUtf8ByteLengthWithin(value, maxBytes);
}

function strictUtf8ByteLengthWithin(value: string, maxBytes: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      bytes += 4;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) return false;
  }
  return true;
}

function utf8CharacterBytes(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}
