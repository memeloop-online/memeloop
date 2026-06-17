import { useAgentSessionContext } from "./AgentSessionContext.js";

/**
 * React hook to access the agent session snapshot.
 * Must be used within an AgentSessionProvider.
 */
export function useAgentSession() {
  const ctx = useAgentSessionContext();
  return { controller: ctx.controller, snapshot: ctx.getSnapshot() };
}
