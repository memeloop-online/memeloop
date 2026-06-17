/**
 * @memeloop/react-ui/agent — React bindings for headless agent management controllers.
 *
 * Provides:
 * - AgentSessionProvider / useAgentSession — Subscribe to an active agent conversation
 *   session via the headless AgentSessionController.
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

export { AgentSessionContext, useAgentSessionContext } from "./AgentSessionContext.js";
export type { AgentSessionContextValue } from "./AgentSessionContext.js";

export { AgentSessionProvider } from "./AgentSessionProvider.js";
export type { AgentSessionProviderProps } from "./AgentSessionProvider.js";

export { useAgentSession } from "./useAgentSession.js";
