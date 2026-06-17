import type { MergedPermissions, PermissionAction, PermissionSet } from "../../permission/index.js";
import { checkPermission, mergePermissionSets } from "../../permission/index.js";
import type { ToolCallingMatch } from "../../promptUtilities/responsePatternUtility.js";
import { nextLamportClockForConversation } from "../../storage/nextLamport.js";
import { requestApproval } from "../../tools/approval.js";
import type { AgentFrameworkContext } from "../../types.js";
import { executeHooks, hasHooks } from "../hooks/registry.js";
import type { HookHandler, HookResult, PreToolUseData } from "../hooks/types.js";

import type { AgentLoopStep } from "../types.js";
import { formatToolResultMessage } from "./toolResultMessage.js";

export type PendingToolCall = ToolCallingMatch & { found: true };

/**
 * Build layered permission sets from context options.
 *
 * Layers (lowest to highest priority):
 * 1. default  - `toolPermissions.default` (e.g. "allow")
 * 2. agent    - `toolPermissions.perAgent[definitionId]`
 * 3. user     - persisted in SQLite (loaded via permission storage)
 * 4. session  - `toolPermissions.rules` (global rules)
 */
export function buildLayeredPermissions(
  options: AgentFrameworkContext["taskAgent"],
  definitionId: string,
  userSet?: PermissionSet,
): MergedPermissions {
  const global = options?.toolPermissions;
  const sets: PermissionSet[] = [];

  if (global?.default) {
    sets.push({
      source: "default",
      rules: [{ toolPattern: "*", action: global.default }],
    });
  }

  const scoped = global?.perAgent?.[definitionId];
  if (scoped) {
    if (scoped.default) {
      sets.push({
        source: `agent:${definitionId}:default`,
        rules: [{ toolPattern: "*", action: scoped.default }],
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

  if (global?.rules && global.rules.length > 0) {
    sets.push({
      source: "session",
      rules: global.rules.map((r) => ({ toolPattern: r.pattern, action: r.action })),
    });
  }

  if (!sets.some((s) => s.rules.some((r) => r.toolPattern === "*"))) {
    sets.unshift({
      source: "implied-default",
      rules: [{ toolPattern: "*", action: "allow" }],
    });
  }

  return mergePermissionSets(sets);
}

export function createPermissionPreToolUseHook(
  options: AgentFrameworkContext["taskAgent"],
  definitionId: string,
  userSet?: PermissionSet,
): HookHandler {
  const mergedPermissions = buildLayeredPermissions(options, definitionId, userSet);
  return async (_context, data) => {
    const toolId = typeof data.toolId === "string" ? data.toolId : "";
    const action = checkPermission(toolId, mergedPermissions);
    if (action === "allow") {
      return { allowed: true, permissionAction: "allow" };
    }
    return {
      allowed: true,
      permissionAction: action,
      reason: action === "deny" ? "Denied by tool permission" : undefined,
    };
  };
}

function applyModifiedCall(
  call: PendingToolCall,
  modified?: Record<string, unknown>,
): PendingToolCall {
  if (!modified) return call;
  const toolId = typeof modified.toolId === "string" ? modified.toolId : call.toolId;
  const parameters =
    modified.parameters != null && typeof modified.parameters === "object"
      ? (modified.parameters as Record<string, unknown>)
      : call.parameters;
  return { ...call, toolId, parameters };
}

function normalizePreToolUseResult(result: HookResult): {
  action: PermissionAction;
  reason?: string;
} {
  if (!result.allowed) {
    return { action: "deny", reason: result.reason ?? "Blocked by PreToolUse hook" };
  }
  if (result.permissionAction === "ask" || result.permissionAction === "deny") {
    return { action: result.permissionAction, reason: result.reason };
  }
  return { action: "allow", reason: result.reason };
}

async function persistDeniedToolResult(
  context: AgentFrameworkContext,
  conversationId: string,
  call: PendingToolCall,
  errorText: string,
): Promise<void> {
  const lamportTool = await nextLamportClockForConversation(context.storage, conversationId);
  await context.storage.appendMessage({
    messageId: `${conversationId}:t:${call.toolId}:${Date.now().toString(36)}`,
    conversationId,
    originNodeId: "local",
    timestamp: Date.now(),
    lamportClock: lamportTool,
    role: "tool",
    content: formatToolResultMessage(call.toolId, call.parameters, errorText, true),
  });
}

async function* resolveAskAction(
  conversationId: string,
  call: PendingToolCall,
): AsyncGenerator<AgentLoopStep, PermissionAction, unknown> {
  yield {
    type: "permission_request" as const,
    data: { tool: call.toolId, args: call.parameters },
  };
  const decision = await requestApproval(
    {
      approvalId: `${conversationId}:${Date.now().toString(36)}:${call.toolId}`,
      agentId: conversationId,
      toolName: call.toolId,
      parameters: call.parameters,
      created: new Date(),
    },
    60_000,
  );
  return decision === "allow" ? "allow" : "deny";
}

async function runPreToolUseHook(
  context: AgentFrameworkContext,
  data: PreToolUseData,
): Promise<HookResult> {
  if (!hasHooks("PreToolUse")) return { allowed: true };
  return executeHooks("PreToolUse", context, data);
}

export async function* gateToolCallsWithPreToolUse(
  context: AgentFrameworkContext,
  options: AgentFrameworkContext["taskAgent"],
  definitionId: string,
  conversationId: string,
  calls: PendingToolCall[],
): AsyncGenerator<AgentLoopStep, PendingToolCall[], unknown> {
  const permissionHook = createPermissionPreToolUseHook(options, definitionId);
  const allowedCalls: PendingToolCall[] = [];

  for (const originalCall of calls) {
    let call = originalCall;
    const permissionResult = await permissionHook(context, {
      toolId: call.toolId,
      parameters: call.parameters,
      conversationId,
    });
    call = applyModifiedCall(call, permissionResult.modified);

    let { action, reason } = normalizePreToolUseResult(permissionResult);
    if (action === "ask") {
      action = yield* resolveAskAction(conversationId, call);
      reason = action === "deny" ? "Tool approval denied or timed out" : reason;
    }
    if (action === "deny") {
      const errorText = reason ?? "Denied by tool permission";
      yield {
        type: "tool" as const,
        data: {
          toolId: call.toolId,
          parameters: call.parameters,
          parallel: false,
          result: errorText,
          isError: true,
        },
      };
      await persistDeniedToolResult(context, conversationId, call, errorText);
      continue;
    }

    const hookResult = await runPreToolUseHook(context, {
      toolId: call.toolId,
      parameters: call.parameters,
      conversationId,
    });
    call = applyModifiedCall(call, hookResult.modified);
    ({ action, reason } = normalizePreToolUseResult(hookResult));
    if (action === "ask") {
      action = yield* resolveAskAction(conversationId, call);
      reason = action === "deny" ? "Tool approval denied or timed out" : reason;
    }
    if (action === "deny") {
      const errorText = reason ?? "Blocked by PreToolUse hook";
      yield {
        type: "tool" as const,
        data: {
          toolId: call.toolId,
          parameters: call.parameters,
          parallel: false,
          result: errorText,
          isError: true,
        },
      };
      await persistDeniedToolResult(context, conversationId, call, errorText);
      continue;
    }

    allowedCalls.push(call);
  }

  return allowedCalls;
}
