import { useAgentSessionContext } from './AgentSessionContext.js';

/**
 * React hook to access the agent session snapshot.
 * Must be used within an AgentSessionProvider.
 */
export function useAgentSession() {
  const context = useAgentSessionContext();
  return { controller: context.controller, snapshot: context.getSnapshot() };
}
