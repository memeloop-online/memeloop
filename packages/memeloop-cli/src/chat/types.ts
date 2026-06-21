import type { AgentLoopGenerator, AgentLoopInput, AgentLoopStep } from 'memeloop';
import { createAgentLoopRunner } from 'memeloop';
import type { NodeRuntimeResult } from '../runtime/nodeRuntime.js';
import type { createTUIDispatcher } from '../tui/index.js';
import type { TUIMessage } from '../tui/types.js';

const DEFAULT_CHAT_DEFINITION_ID = 'memeloop:general-assistant';

export interface ChatOptions {
  model?: string;
  mode?: 'chat' | 'plan' | 'autopilot';
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
  providerMissingAction: 'retry' | 'continue' | 'exit';

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

export type AgentLoopRunnerFunction = (input: AgentLoopInput) => AgentLoopGenerator;

export async function createCliAgentRunner(
  runtime: NodeRuntimeResult,
  conversationId: string,
  definitionId = DEFAULT_CHAT_DEFINITION_ID,
): Promise<AgentLoopRunnerFunction | undefined> {
  await runtime.storage.upsertConversationMetadata({
    conversationId,
    title: definitionId,
    lastMessagePreview: '',
    lastMessageTimestamp: Date.now(),
    messageCount: 0,
    originNodeId: 'memeloop-cli',
    definitionId,
    isUserInitiated: true,
  });
  return (await createAgentLoopRunner(runtime.context, { definitionId, conversationId })) ?? undefined;
}

export function hasValidProvider(runtime: NodeRuntimeResult): boolean {
  return Boolean(runtime.context.llmProvider?.model);
}
