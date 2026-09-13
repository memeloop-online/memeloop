import { defaultPermissionActionForTrustClass } from '../../orchestration/security/admission.js';
import type { MergedPermissions, PermissionAction, PermissionSet } from '../../permission/index.js';
import { checkPermission, mergePermissionSets } from '../../permission/index.js';
import type { ToolCallingMatch } from '../../promptUtilities/responsePatternUtility.js';
import { canonicalizePreToolUseHookResult, canonicalizeToolCallIdentity, ToolArgumentNormalizationError } from '../../tools/structuredToolArguments.js';
import type { AgentFrameworkContext } from '../../types.js';
import type { HookHandler, HookResult, PreToolUseData } from '../hooks/types.js';

import type { AgentLoopStep } from '../types.js';
import { appendLocalMessageEvent } from './localMessageEvent.js';

export const TOOL_ARGUMENT_NORMALIZATION_ERROR_KEY = '__memeloopToolArgumentError';

export type PendingToolCall = ToolCallingMatch & {
  found: true;
  /** Canonical detached argument bytes used for audit/debug boundaries. */
  parameterCanonical: string;
  /** Stable digest of parameters only. */
  parameterDigest: string;
  /** Stable digest of the tool id + parameters logical call. */
  callDigest: string;
  /** Stable error for a rejected model/hook argument envelope. */
  argumentError?: string;
};

type UnnormalizedPendingToolCall = ToolCallingMatch & { found: true };

/**
 * The single model/hook -> tool input boundary. It always returns detached,
 * bounded data; malformed input becomes a harmless non-executable call whose
 * stable error can be persisted without retaining the hostile source object.
 */
export function normalizePendingToolCall(call: UnnormalizedPendingToolCall): PendingToolCall {
  try {
    const identity = canonicalizeToolCallIdentity(call.toolId, call.parameters);
    return buildPendingToolCall(call, identity);
  } catch (error) {
    const argumentError = error instanceof ToolArgumentNormalizationError ? error.message : 'tool_arguments_unsafe';
    let safeToolId = 'invalid-tool';
    try {
      safeToolId = canonicalizeToolCallIdentity(call.toolId, {}).toolId;
    } catch (fallbackError) {
      if (!(fallbackError instanceof ToolArgumentNormalizationError)) throw fallbackError;
    }
    const identity = canonicalizeToolCallIdentity(safeToolId, {
      [TOOL_ARGUMENT_NORMALIZATION_ERROR_KEY]: argumentError,
    });
    return {
      ...buildPendingToolCall(call, identity),
      argumentError,
    };
  }
}

export function normalizePendingToolCalls(
  calls: readonly UnnormalizedPendingToolCall[],
): PendingToolCall[] {
  return calls.map(normalizePendingToolCall);
}

function buildPendingToolCall(
  call: UnnormalizedPendingToolCall,
  identity: ReturnType<typeof canonicalizeToolCallIdentity>,
): PendingToolCall {
  return {
    found: true,
    ...(typeof call.toolCallId === 'string' ? { toolCallId: call.toolCallId } : {}),
    toolId: identity.toolId,
    parameters: identity.parameters,
    originalText: typeof call.originalText === 'string' ? call.originalText : '',
    parameterCanonical: identity.canonical,
    parameterDigest: identity.digest,
    callDigest: identity.callDigest,
  };
}

/**
 * Build layered permission sets from context options.
 *
 * Layers (lowest to highest priority):
 * 1. default  - `toolPermissions.default` (e.g. "allow")
 * 2. agent    - `toolPermissions.perAgent[definitionId]`
 * 3. user     - persisted in SQLite (loaded via permission storage)
 * 4. session  - `toolPermissions.rules` (global rules)
 *
 * When no wildcard rule exists, an implied default is derived from the
 * host-bound trust class: restricted/quarantine workers deny by default,
 * trusted workers keep the historical allow default.
 */
export function buildLayeredPermissions(
  options: AgentFrameworkContext['agentToolLoop'],
  definitionId: string,
  userSet?: PermissionSet,
): MergedPermissions {
  const globalPerms = options?.toolPermissions;
  const sets: PermissionSet[] = [];

  if (globalPerms?.default) {
    sets.push({
      source: 'default',
      rules: [{ toolPattern: '*', action: globalPerms.default }],
    });
  }

  const scoped = globalPerms?.perAgent?.[definitionId];
  if (scoped) {
    if (scoped.default) {
      sets.push({
        source: `agent:${definitionId}:default`,
        rules: [{ toolPattern: '*', action: scoped.default }],
      });
    }
    if (scoped.rules && scoped.rules.length > 0) {
      sets.push({
        source: `agent:${definitionId}`,
        rules: scoped.rules.map((r) => ({ toolPattern: r.pattern, action: r.action })),
      });
    }
  }

  if (userSet && userSet.rules.length > 0) {
    sets.push(userSet);
  }

  if (globalPerms?.rules && globalPerms.rules.length > 0) {
    sets.push({
      source: 'session',
      rules: globalPerms.rules.map((r) => ({ toolPattern: r.pattern, action: r.action })),
    });
  }

  if (!sets.some((s) => s.rules.some((r) => r.toolPattern === '*'))) {
    sets.unshift({
      source: 'implied-default',
      rules: [
        { toolPattern: '*', action: defaultPermissionActionForTrustClass(options?.trustClass) },
      ],
    });
  }

  return mergePermissionSets(sets);
}

export function createPermissionPreToolUseHook(
  options: AgentFrameworkContext['agentToolLoop'],
  definitionId: string,
  userSet?: PermissionSet,
): HookHandler {
  const mergedPermissions = buildLayeredPermissions(options, definitionId, userSet);
  return async (_context, data) => {
    const toolId = typeof data.toolId === 'string' ? data.toolId : '';
    const action = checkPermission(toolId, mergedPermissions);
    if (action === 'allow') {
      return { allowed: true, permissionAction: 'allow' };
    }
    return {
      allowed: true,
      permissionAction: action,
      reason: action === 'deny' ? 'Denied by tool permission' : undefined,
    };
  };
}

function applyModifiedCall(
  call: PendingToolCall,
  modified?: Record<string, unknown>,
): PendingToolCall {
  if (!modified) return call;
  return normalizePendingToolCall({
    found: true,
    ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
    toolId: Object.hasOwn(modified, 'toolId') ? (modified.toolId as string) : call.toolId,
    parameters: Object.hasOwn(modified, 'parameters')
      ? (modified.parameters as Record<string, unknown>)
      : call.parameters,
    originalText: call.originalText,
  });
}

function normalizePreToolUseResult(result: HookResult): {
  action: PermissionAction;
  reason?: string;
} {
  if (!result.allowed) {
    return { action: 'deny', reason: result.reason ?? 'Blocked by PreToolUse hook' };
  }
  if (result.permissionAction === 'ask' || result.permissionAction === 'deny') {
    return { action: result.permissionAction, reason: result.reason };
  }
  return { action: 'allow', reason: result.reason };
}

async function persistDeniedToolResult(
  context: AgentFrameworkContext,
  conversationId: string,
  turnId: string,
  messageIdentity: string,
  callIndex: number,
  call: PendingToolCall,
  errorText: string,
): Promise<void> {
  const messageId = `${conversationId}:t:${messageIdentity}:${callIndex}:${call.toolId}:denied`;
  await appendLocalMessageEvent(context, {
    conversationId,
    message: {
      messageId,
      turnId,
      role: 'tool',
      content: errorText,
      parts: [
        {
          type: 'tool-result',
          ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
          toolName: call.toolId,
          parameters: call.parameters,
          result: errorText,
          isError: true,
        },
      ],
      metadata: {
        isToolResult: true,
        isError: true,
        toolId: call.toolId,
        toolParameters: call.parameters,
      },
    },
  });
}

async function* resolveAskAction(
  context: AgentFrameworkContext,
  runId: string,
  conversationId: string,
  call: PendingToolCall,
  signal?: AbortSignal,
): AsyncGenerator<AgentLoopStep, PermissionAction, unknown> {
  signal?.throwIfAborted();
  yield {
    type: 'permission_request' as const,
    data: { tool: call.toolId, args: call.parameters },
  };
  const broker = context.toolApprovals;
  if (!broker || !context.runtimeId) {
    throw new Error('Tool approval requires a runtime-scoped ToolApprovalBroker');
  }
  const decision = await broker.requestApproval(
    {
      approvalId: `approval:${crypto.randomUUID()}`,
      runtimeId: context.runtimeId,
      runId,
      conversationId,
      agentId: conversationId,
      toolName: call.toolId,
      parameters: call.parameters,
      created: new Date(),
    },
    { timeoutMs: 60_000, signal },
  );
  signal?.throwIfAborted();
  return decision === 'allow' ? 'allow' : 'deny';
}

async function runPreToolUseHook(
  context: AgentFrameworkContext,
  data: PreToolUseData,
): Promise<HookResult> {
  const hooks = context.hooks;
  if (hooks === undefined || !hooks.hasHooks('PreToolUse')) return { allowed: true };
  try {
    const result = await hooks.executeHooks('PreToolUse', context, data);
    context.operationSignal?.throwIfAborted();
    return canonicalizePreToolUseHookResult(result);
  } catch (error) {
    if (context.operationSignal?.aborted) context.operationSignal.throwIfAborted();
    return {
      allowed: false,
      reason: error instanceof ToolArgumentNormalizationError ? error.message : 'tool_arguments_unsafe',
    };
  }
}

export async function* gateToolCallsWithPreToolUse(
  context: AgentFrameworkContext,
  options: AgentFrameworkContext['agentToolLoop'],
  definitionId: string,
  conversationId: string,
  turnId: string,
  runId: string,
  messageIdentity: string,
  calls: PendingToolCall[],
  signal?: AbortSignal,
): AsyncGenerator<AgentLoopStep, PendingToolCall[], unknown> {
  const hookContext: AgentFrameworkContext = { ...context, operationSignal: signal };
  const permissionHook = createPermissionPreToolUseHook(options, definitionId);
  const allowedCalls: PendingToolCall[] = [];

  for (const [callIndex, originalCall] of calls.entries()) {
    signal?.throwIfAborted();
    let call = originalCall;
    if (call.argumentError !== undefined) {
      const errorText = call.argumentError;
      yield {
        type: 'tool' as const,
        data: {
          toolId: call.toolId,
          parameters: call.parameters,
          parallel: false,
          result: errorText,
          isError: true,
        },
      };
      signal?.throwIfAborted();
      await persistDeniedToolResult(
        context,
        conversationId,
        turnId,
        messageIdentity,
        callIndex,
        call,
        errorText,
      );
      continue;
    }
    const permissionResult = await permissionHook(hookContext, {
      toolId: call.toolId,
      parameters: call.parameters,
      conversationId,
    });
    call = applyModifiedCall(call, permissionResult.modified);

    if (call.argumentError !== undefined) {
      const errorText = call.argumentError;
      yield {
        type: 'tool' as const,
        data: {
          toolId: call.toolId,
          parameters: call.parameters,
          parallel: false,
          result: errorText,
          isError: true,
        },
      };
      signal?.throwIfAborted();
      await persistDeniedToolResult(
        context,
        conversationId,
        turnId,
        messageIdentity,
        callIndex,
        call,
        errorText,
      );
      continue;
    }

    let { action, reason } = normalizePreToolUseResult(permissionResult);
    if (action === 'ask') {
      action = yield* resolveAskAction(hookContext, runId, conversationId, call, signal);
      reason = action === 'deny' ? 'Tool approval denied or timed out' : reason;
    }
    if (action === 'deny') {
      const errorText = reason ?? 'Denied by tool permission';
      yield {
        type: 'tool' as const,
        data: {
          toolId: call.toolId,
          parameters: call.parameters,
          parallel: false,
          result: errorText,
          isError: true,
        },
      };
      signal?.throwIfAborted();
      await persistDeniedToolResult(
        context,
        conversationId,
        turnId,
        messageIdentity,
        callIndex,
        call,
        errorText,
      );
      continue;
    }

    const hookResult = await runPreToolUseHook(hookContext, {
      toolId: call.toolId,
      parameters: call.parameters,
      conversationId,
    });
    call = applyModifiedCall(call, hookResult.modified);
    if (call.argumentError !== undefined) {
      const errorText = call.argumentError;
      yield {
        type: 'tool' as const,
        data: {
          toolId: call.toolId,
          parameters: call.parameters,
          parallel: false,
          result: errorText,
          isError: true,
        },
      };
      signal?.throwIfAborted();
      await persistDeniedToolResult(
        context,
        conversationId,
        turnId,
        messageIdentity,
        callIndex,
        call,
        errorText,
      );
      continue;
    }
    ({ action, reason } = normalizePreToolUseResult(hookResult));
    if (action === 'ask') {
      action = yield* resolveAskAction(hookContext, runId, conversationId, call, signal);
      reason = action === 'deny' ? 'Tool approval denied or timed out' : reason;
    }
    if (action === 'deny') {
      const errorText = reason ?? 'Blocked by PreToolUse hook';
      yield {
        type: 'tool' as const,
        data: {
          toolId: call.toolId,
          parameters: call.parameters,
          parallel: false,
          result: errorText,
          isError: true,
        },
      };
      signal?.throwIfAborted();
      await persistDeniedToolResult(
        context,
        conversationId,
        turnId,
        messageIdentity,
        callIndex,
        call,
        errorText,
      );
      continue;
    }

    allowedCalls.push(call);
  }

  return allowedCalls;
}
