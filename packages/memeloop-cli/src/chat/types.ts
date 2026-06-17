import type { AgentLoopGenerator, AgentLoopInput, AgentLoopStep } from "memeloop";
import type { NodeRuntimeResult } from "../runtime/nodeRuntime.js";
import type { createTUIDispatcher } from "../tui/index.js";
import type { TUIMessage } from "../tui/types.js";

export interface ChatOptions {
  model?: string;
  mode?: "chat" | "plan" | "autopilot";
  dataDir?: string;
  config?: Record<string, unknown>;
  print?: boolean;
  prompt?: string;
  localNodeId?: string;
  /** Resume the most recent session */
  continueLast?: boolean;
  /** Resume a specific session by ID */
  resumeSessionId?: string;
}

export interface ChatHookContext {
  options: ChatOptions;
  dataDir: string;
  tui: ReturnType<typeof createTUIDispatcher>;
  runtime?: NodeRuntimeResult;
  initialMessages: TUIMessage[];

  // Provider-missing handling
  providerMissingHandled: boolean;
  providerMissingAction: "retry" | "continue" | "exit";

  // Message handling state
  messageHandled: boolean;

  // Agent runtime
  conversationId?: string;
  currentText?: string;
  currentStep?: AgentLoopStep;
  responseContent?: string;
  error?: Error;

  // Print mode
  prompt?: string;
}

export type AgentLoopRunnerFn = (input: AgentLoopInput) => AgentLoopGenerator;

export function getTaskRunner(runtime: NodeRuntimeResult): AgentLoopRunnerFn | undefined {
  return (runtime.context as unknown as Record<string, unknown>).runTaskAgent as
    | AgentLoopRunnerFn
    | undefined;
}

export function hasValidProvider(runtime: NodeRuntimeResult): boolean {
  return Boolean(runtime.context.llmProvider?.model);
}
