/**
 * @memeloop/react-ui/agent — React bindings for headless agent management controllers.
 *
 * Provides:
 * - AgentSessionProvider / useAgentSession — Subscribe to an active agent conversation
 *   session via the headless AgentSessionController.
 * Usage:
 * ```tsx
 * import { AgentSessionProvider, useAgentSession } from "@memeloop/react-ui/agent";
 *
 * function ChatView() {
 *   const { snapshot } = useAgentSession();
 *   // render snapshot.agent, snapshot.messages, etc.
 * }
 * ```
 */

export { AgentSessionContext, useAgentSessionContext } from './AgentSessionContext.js';
export type { AgentSessionContextValue } from './AgentSessionContext.js';

export { AgentSessionProvider } from './AgentSessionProvider.js';
export type { AgentSessionProviderProps } from './AgentSessionProvider.js';

export { useAgentSession } from './useAgentSession.js';
export { useAgentSessionChatAdapter } from './useAgentSessionChatAdapter.js';
export type { AgentSessionChatAdapterOptions } from './useAgentSessionChatAdapter.js';
export { useAgentSessionCoreAdapter } from './useAgentSessionCoreAdapter.js';
export type { AgentSessionCoreAdapterOptions, AgentSessionCoreChatAdapter, AgentSessionPreparedMessage, AgentSessionSendContext } from './useAgentSessionCoreAdapter.js';

// Reusable chat view
export { AgentChatConfigError, AgentChatHeader, AgentChatShell, AgentChatToolbar, WikiAttachmentSelector } from './AgentChatShell.js';
export type {
  AgentChatConfigErrorProps,
  AgentChatErrorPresentation,
  AgentChatHeaderProps,
  AgentChatShellProps,
  AgentChatToolbarProps,
  WikiAttachmentOption,
  WikiAttachmentSelectorLabels,
  WikiAttachmentSelectorProps,
} from './AgentChatShell.js';
export { AgentChatView } from './AgentChatView.js';
export type { AgentChatActionLabels, AgentChatViewProps } from './AgentChatView.js';
export { ExecutionTargetSelector } from './ExecutionTargetSelector.js';
export type { ExecutionTargetSelectorLabels, ExecutionTargetSelectorProps } from './ExecutionTargetSelector.js';
