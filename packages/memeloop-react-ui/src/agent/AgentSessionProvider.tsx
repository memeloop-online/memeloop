import { useSyncExternalStore, useCallback, useRef, type ReactNode } from "react";
import type { AgentSessionController } from "memeloop";
import type { AgentSessionSnapshot } from "memeloop";

import { AgentSessionContext } from "./AgentSessionContext.js";

export interface AgentSessionProviderProps {
  controller: AgentSessionController;
  children: ReactNode;
}

/**
 * React provider that subscribes to an AgentSessionController
 * and exposes its snapshot via React context.
 */
export function AgentSessionProvider({ controller, children }: AgentSessionProviderProps) {
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  const getSnapshot = useCallback(() => controllerRef.current.getSnapshot(), []);

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
      const unsub = controllerRef.current.subscribe(() => {
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
