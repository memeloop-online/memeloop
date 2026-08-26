import type { AgentSessionController } from 'memeloop';
import type { AgentSessionSnapshot } from 'memeloop';
import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from 'react';

import { AgentSessionContext } from './AgentSessionContext.js';

export interface AgentSessionProviderProps {
  controller: AgentSessionController;
  children: ReactNode;
}

const EMPTY_STREAMING_MESSAGE_IDS: ReadonlySet<string> = Object.freeze(
  new Proxy(new Set<string>(), {
    get(target, property) {
      if (property === 'add' || property === 'clear' || property === 'delete') {
        return () => {
          throw new TypeError('the server snapshot is immutable');
        };
      }
      if (property === 'valueOf') return () => EMPTY_STREAMING_MESSAGE_IDS;
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...arguments_: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, target, arguments_);
        return result;
      };
    },
  }),
);

const EMPTY_AGENT_SESSION_SERVER_SNAPSHOT: AgentSessionSnapshot = Object.freeze({
  agent: null,
  loading: false,
  loadingMoreBefore: false,
  loadingMoreAfter: false,
  error: null,
  messages: Object.freeze([]),
  orderedMessageIds: Object.freeze([]),
  streamingMessageIds: EMPTY_STREAMING_MESSAGE_IDS,
  pendingNewMessageCount: 0,
});

/**
 * React provider that subscribes to an AgentSessionController
 * and exposes its snapshot via React context.
 */
export function AgentSessionProvider({ controller, children }: AgentSessionProviderProps) {
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);

  const getServerSnapshot = useCallback(() => EMPTY_AGENT_SESSION_SERVER_SNAPSHOT, []);

  const subscribe = useCallback((callback: () => void) => controller.subscribe(callback), [controller]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const value = useMemo(() => ({ controller, getSnapshot: () => snapshot }), [controller, snapshot]);
  return (
    <AgentSessionContext.Provider value={value}>
      {children}
    </AgentSessionContext.Provider>
  );
}
