import type { AgentSessionController } from 'memeloop';
import type { AgentSessionSnapshot } from 'memeloop';
import { type ReactNode, useCallback, useRef, useSyncExternalStore } from 'react';

import { AgentSessionContext } from './AgentSessionContext.js';

export interface AgentSessionProviderProps {
  controller: AgentSessionController;
  children: ReactNode;
}

/**
 * React provider that subscribes to an AgentSessionController
 * and exposes its snapshot via React context.
 */
export function AgentSessionProvider({ controller, children }: AgentSessionProviderProps) {
  const controllerReference = useRef(controller);
  controllerReference.current = controller;

  const getSnapshot = useCallback(() => controllerReference.current.getSnapshot(), []);

  const getServerSnapshot = useCallback((): AgentSessionSnapshot => ({
    agent: null,
    loading: false,
    error: null,
    messages: [],
    orderedMessageIds: [],
    streamingMessageIds: new Set(),
  }), []);

  const subscribe = useCallback(
    (callback: () => void) => {
      const unsub = controllerReference.current.subscribe(() => {
        callback();
      });
      return unsub;
    },
    [],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <AgentSessionContext.Provider value={{ controller, getSnapshot: () => snapshot }}>
      {children}
    </AgentSessionContext.Provider>
  );
}
