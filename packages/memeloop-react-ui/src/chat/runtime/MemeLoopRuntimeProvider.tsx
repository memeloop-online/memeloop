import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { type ReactNode, useCallback, useState } from 'react';

import { normalizeMemeLoopChatError } from '../coreTypes.js';
import type { MemeLoopChatOperation, WebMemeLoopChatAdapter } from '../types.js';
import { MemeLoopChatContext } from './MemeLoopChatContext.js';
import { useMemeLoopRuntime } from './useMemeLoopRuntime.js';

export interface MemeLoopRuntimeProviderProps {
  adapter: WebMemeLoopChatAdapter;
  children: ReactNode;
}

export function MemeLoopRuntimeProvider({ adapter, children }: MemeLoopRuntimeProviderProps) {
  const [operationError, setOperationError] = useState<Error | null>(null);
  const reportOperationError = useCallback((error: unknown, operation: MemeLoopChatOperation) => {
    const normalized = normalizeMemeLoopChatError(error);
    setOperationError(normalized);
    try {
      adapter.onError?.(normalized, operation);
    } catch {
      // Error observers are notifications and must never reject a UI event.
    }
  }, [adapter]);
  const clearOperationError = useCallback(() => {
    setOperationError(null);
  }, []);
  const { runtime, attachmentsRef } = useMemeLoopRuntime(adapter, reportOperationError, clearOperationError);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MemeLoopChatContext.Provider value={{ adapter, attachmentsRef, operationError, clearOperationError, reportOperationError }}>
        {children}
      </MemeLoopChatContext.Provider>
    </AssistantRuntimeProvider>
  );
}
