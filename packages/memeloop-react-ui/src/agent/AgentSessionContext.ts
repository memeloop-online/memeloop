import { createContext, useContext } from 'react';

import type { AgentSessionController, AgentSessionSnapshot } from 'memeloop';

export interface AgentSessionContextValue {
  controller: AgentSessionController;
  getSnapshot: () => AgentSessionSnapshot;
}

export const AgentSessionContext = createContext<AgentSessionContextValue | null>(null);

export function useAgentSessionContext(): AgentSessionContextValue {
  const context = useContext(AgentSessionContext);
  if (!context) {
    throw new Error(
      'useAgentSessionContext must be used within an AgentSessionProvider',
    );
  }
  return context;
}
