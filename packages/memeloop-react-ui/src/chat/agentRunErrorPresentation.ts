import {
  type AgentRunError,
  type AgentRunErrorLocalizationParameters,
  type AgentRunErrorMessageKey,
  type AgentRunErrorSettingTarget,
  type ChatMessage,
  type ConversationMessageListProjection,
  extractAgentRunError,
} from 'memeloop';

import type { MemeLoopChatErrorPresentation } from './coreTypes.js';

export interface AgentRunErrorLocalizedText {
  title: string;
  message: string;
}

export interface AgentRunErrorPresentationOptions {
  localize: (
    messageKey: AgentRunErrorMessageKey,
    parameters: AgentRunErrorLocalizationParameters,
  ) => AgentRunErrorLocalizedText;
  settingActionLabel?: (target: AgentRunErrorSettingTarget) => string;
}

export interface AgentRunErrorPresentation extends MemeLoopChatErrorPresentation {
  actionId?: 'agent-run-setting';
  settingTarget?: AgentRunErrorSettingTarget;
  errorCode: AgentRunError['code'];
  retryable: boolean;
}

type AgentRunErrorMessage = ChatMessage | ConversationMessageListProjection;

function extractFromMessage(message: AgentRunErrorMessage): AgentRunError | undefined {
  if (message.role !== 'error') return undefined;
  const metadata = message.metadata as Readonly<Record<string, unknown>> | undefined;
  return extractAgentRunError(metadata?.agentRunError);
}

/** Strictly maps the durable typed contract; it never reads or parses Error.message/content. */
export function resolveAgentRunErrorPresentation(
  value: Error | AgentRunErrorMessage,
  options: AgentRunErrorPresentationOptions,
): AgentRunErrorPresentation | null {
  const error = extractAgentRunError(value) ?? (value instanceof Error ? undefined : extractFromMessage(value));
  if (!error) return null;
  const localized = options.localize(error.messageKey, error.localizedParams ?? {});
  const settingTarget = error.settingTarget;
  return {
    ...localized,
    diagnosticId: error.diagnosticId,
    errorCode: error.code,
    retryable: error.retryable,
    ...(settingTarget && options.settingActionLabel
      ? {
        actionId: 'agent-run-setting' as const,
        actionLabel: options.settingActionLabel(settingTarget),
        settingTarget,
      }
      : {}),
  };
}
