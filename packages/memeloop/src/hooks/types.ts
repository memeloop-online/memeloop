/**
 * Hook system types for memeloop.
 * Hooks are lifecycle callbacks that execute before/after key events in the agent loop.
 */

import type { PermissionAction } from "../permission/types.js";
import type { AgentFrameworkContext } from "../types.js";

/** Context passed to all hook handlers. */
export type HookContext = AgentFrameworkContext;

/** Result returned by a hook handler. */
export interface HookResult {
  /** Whether to allow the action to proceed (false = block/deny) */
  allowed: boolean;
  /** Optional message explaining why the action was blocked */
  reason?: string;
  /** Optional data modified by the hook (e.g., transformed tool args) */
  modified?: Record<string, unknown>;
  /** Optional tool permission action. Interpreted by PreToolUse callers. */
  permissionAction?: PermissionAction;
}

/** Signature of a hook handler function. */
export type HookHandler = (context: HookContext, data: Record<string, unknown>) => Promise<HookResult>;

/** Enum of supported hook event types. */
export type HookType =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "AgentStart"
  | "AgentStop";

/** Data passed to PreToolUse hooks. */
export interface PreToolUseData extends Record<string, unknown> {
  toolId: string;
  parameters: Record<string, unknown>;
  conversationId: string;
}

/** Data passed to PostToolUse hooks. */
export interface PostToolUseData extends Record<string, unknown> {
  toolId: string;
  parameters: Record<string, unknown>;
  result: string;
  isError: boolean;
  conversationId: string;
}

/** Data passed to UserPromptSubmit hooks. */
export interface UserPromptSubmitData extends Record<string, unknown> {
  message: string;
  conversationId: string;
}

/** Data passed to AgentStart hooks. */
export interface AgentStartData extends Record<string, unknown> {
  conversationId: string;
  definitionId?: string;
}

/** Data passed to AgentStop hooks. */
export interface AgentStopData extends Record<string, unknown> {
  conversationId: string;
  reason: "completed" | "cancelled" | "max-iterations" | "error";
}
