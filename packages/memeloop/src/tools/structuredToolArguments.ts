import { CanonicalJsonError, type CanonicalJsonLimits, canonicalJsonString } from '../encoding/canonicalJson.js';
import { sha256HexSync } from '../encoding/sha256.js';

export const MAX_TOOL_ARGUMENT_CANONICAL_BYTES = 64 * 1_024;
export const MAX_TOOL_ARGUMENT_DEPTH = 32;
export const MAX_TOOL_ARGUMENT_NODES = 4_096;
export const MAX_TOOL_ID_BYTES = 512;

export const TOOL_ARGUMENT_CANONICAL_LIMITS: Readonly<CanonicalJsonLimits> = Object.freeze({
  maxDepth: MAX_TOOL_ARGUMENT_DEPTH,
  maxNodes: MAX_TOOL_ARGUMENT_NODES,
  maxStringCodeUnits: MAX_TOOL_ARGUMENT_CANONICAL_BYTES,
  maxStringBytes: MAX_TOOL_ARGUMENT_CANONICAL_BYTES,
  maxBytes: MAX_TOOL_ARGUMENT_CANONICAL_BYTES,
});

const TOOL_CALL_CANONICAL_LIMITS: Readonly<CanonicalJsonLimits> = Object.freeze({
  ...TOOL_ARGUMENT_CANONICAL_LIMITS,
  maxBytes: MAX_TOOL_ARGUMENT_CANONICAL_BYTES + 1_024,
});

const PRE_TOOL_USE_MODIFICATION_LIMITS: Readonly<CanonicalJsonLimits> = Object.freeze({
  ...TOOL_ARGUMENT_CANONICAL_LIMITS,
  maxNodes: MAX_TOOL_ARGUMENT_NODES + 16,
  maxBytes: MAX_TOOL_ARGUMENT_CANONICAL_BYTES + 4_096,
});

export type ToolArgumentNormalizationErrorCode =
  | 'invalid_tool_id'
  | 'not_object'
  | 'result_too_large'
  | 'unsafe';

/** Stable error persisted when a model or hook supplies unsafe tool input. */
export class ToolArgumentNormalizationError extends Error {
  public constructor(public readonly code: ToolArgumentNormalizationErrorCode) {
    super(`tool_arguments_${code}`);
    this.name = 'ToolArgumentNormalizationError';
  }
}

export interface CanonicalToolArguments {
  /** Detached plain JSON record. The model/provider/hook object is discarded. */
  parameters: Record<string, unknown>;
  canonical: string;
  digest: string;
}

export interface CanonicalToolCallIdentity extends CanonicalToolArguments {
  toolId: string;
  callDigest: string;
}

export interface CanonicalPreToolUseHookResult {
  allowed: boolean;
  reason?: string;
  modified?: Record<string, unknown>;
  permissionAction?: 'allow' | 'ask' | 'deny';
}

/** Descriptor-safe, bounded and locale-independent tool argument boundary. */
export function canonicalizeToolArguments(value: unknown): CanonicalToolArguments {
  const canonical = boundedCanonical(value, TOOL_ARGUMENT_CANONICAL_LIMITS);
  const parameters = JSON.parse(canonical) as unknown;
  if (!isPlainRecord(parameters)) throw new ToolArgumentNormalizationError('not_object');
  return {
    parameters,
    canonical,
    digest: sha256HexSync(new TextEncoder().encode(canonical)),
  };
}

/** Normalize both the externally selected tool name and its arguments. */
export function canonicalizeToolCallIdentity(
  toolId: unknown,
  value: unknown,
): CanonicalToolCallIdentity {
  if (!isBoundedToolId(toolId)) throw new ToolArgumentNormalizationError('invalid_tool_id');
  const normalized = canonicalizeToolArguments(value);
  const callCanonical = boundedCanonical(
    {
      parameters: normalized.parameters,
      toolId,
    },
    TOOL_CALL_CANONICAL_LIMITS,
  );
  return {
    ...normalized,
    toolId,
    callDigest: sha256HexSync(new TextEncoder().encode(callCanonical)),
  };
}

/**
 * Detach a PreToolUse modification before HookRegistry merges it into the data
 * passed to later hooks. Parameter values receive the same strict boundary a
 * second time when the gate applies the modification.
 */
export function canonicalizePreToolUseModification(value: unknown): Record<string, unknown> {
  const canonical = boundedCanonical(value, PRE_TOOL_USE_MODIFICATION_LIMITS);
  const detached = JSON.parse(canonical) as unknown;
  if (!isPlainRecord(detached)) throw new ToolArgumentNormalizationError('not_object');
  if (Object.hasOwn(detached, 'parameters')) {
    detached.parameters = canonicalizeToolArguments(detached.parameters).parameters;
  }
  return detached;
}

/**
 * Validate and detach the complete result returned by an untrusted PreToolUse
 * hook. Traversing the complete envelope before reading any field prevents an
 * accessor on `allowed`, `reason`, or `modified` from running in HookRegistry.
 */
export function canonicalizePreToolUseHookResult(value: unknown): CanonicalPreToolUseHookResult {
  const canonical = boundedCanonical(value, PRE_TOOL_USE_MODIFICATION_LIMITS);
  const detached = JSON.parse(canonical) as unknown;
  if (!isPlainRecord(detached)) throw new ToolArgumentNormalizationError('unsafe');
  const allowedKeys = new Set(['allowed', 'reason', 'modified', 'permissionAction']);
  if (Object.keys(detached).some((key) => !allowedKeys.has(key))) {
    throw new ToolArgumentNormalizationError('unsafe');
  }
  if (typeof detached.allowed !== 'boolean') {
    throw new ToolArgumentNormalizationError('unsafe');
  }
  if (Object.hasOwn(detached, 'reason') && typeof detached.reason !== 'string') {
    throw new ToolArgumentNormalizationError('unsafe');
  }
  if (
    Object.hasOwn(detached, 'permissionAction') &&
    detached.permissionAction !== 'allow' &&
    detached.permissionAction !== 'ask' &&
    detached.permissionAction !== 'deny'
  ) {
    throw new ToolArgumentNormalizationError('unsafe');
  }
  const result: CanonicalPreToolUseHookResult = { allowed: detached.allowed };
  if (typeof detached.reason === 'string') result.reason = detached.reason;
  if (Object.hasOwn(detached, 'modified')) {
    result.modified = canonicalizePreToolUseModification(detached.modified);
  }
  if (
    detached.permissionAction === 'allow' ||
    detached.permissionAction === 'ask' ||
    detached.permissionAction === 'deny'
  ) {
    result.permissionAction = detached.permissionAction;
  }
  return result;
}

function boundedCanonical(value: unknown, limits: Readonly<CanonicalJsonLimits>): string {
  try {
    return canonicalJsonString(value, limits);
  } catch (error) {
    if (
      error instanceof CanonicalJsonError &&
      (error.code === 'max_bytes' ||
        error.code === 'max_depth' ||
        error.code === 'max_nodes' ||
        error.code === 'max_string_bytes' ||
        error.code === 'max_string_code_units')
    ) {
      throw new ToolArgumentNormalizationError('result_too_large');
    }
    throw new ToolArgumentNormalizationError('unsafe');
  }
}

function isBoundedToolId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    canonicalJsonString(value, {
      maxDepth: 0,
      maxNodes: 1,
      maxStringCodeUnits: MAX_TOOL_ID_BYTES,
      maxStringBytes: MAX_TOOL_ID_BYTES,
      maxBytes: MAX_TOOL_ID_BYTES + 2,
    });
    return true;
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
