/**
 * @memeloop/react-ui/agent — React bindings for headless agent management controllers.
 *
 * Provides:
 * - AgentSessionProvider / useAgentSession — Subscribe to an active agent conversation
 *   session via the headless AgentSessionController.
 * - PromptConfigForm — RJSF-based prompt configuration form.
 * - PromptTree — read-only tree view of agent prompts.
 *
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

// Reusable prompt/editor UI components
export { PromptConfigForm } from './prompts/PromptConfigForm.js';
export type { PromptConfigFormProps } from './prompts/PromptConfigForm.js';

export { PromptTree } from './prompts/PromptTree.js';
export type { PromptTreeProps } from './prompts/PromptTree.js';

// Reusable chat view
export { AgentChatView } from './AgentChatView.js';
export type { AgentChatViewProps } from './AgentChatView.js';
