import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { ReactNode } from "react";

import type { MemeLoopChatAdapter } from "../types.js";
import { MemeLoopChatContext } from "./MemeLoopChatContext.js";
import { useMemeLoopRuntime } from "./useMemeLoopRuntime.js";

export interface MemeLoopRuntimeProviderProps {
  adapter: MemeLoopChatAdapter;
  children: ReactNode;
}

export function MemeLoopRuntimeProvider({ adapter, children }: MemeLoopRuntimeProviderProps) {
  const { runtime, attachmentsRef } = useMemeLoopRuntime(adapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MemeLoopChatContext.Provider value={{ adapter, attachmentsRef }}>
        {children}
      </MemeLoopChatContext.Provider>
    </AssistantRuntimeProvider>
  );
}
