import { createContext, type RefObject, useContext } from "react";

import type { MemeLoopChatAdapter } from "../types.js";
import type { PendingAttachments } from "./useMemeLoopRuntime.js";

export interface MemeLoopChatContextValue {
  adapter: MemeLoopChatAdapter;
  attachmentsRef: RefObject<PendingAttachments>;
}

export const MemeLoopChatContext = createContext<MemeLoopChatContextValue | null>(null);

export function useMemeLoopChatContext(): MemeLoopChatContextValue {
  const context = useContext(MemeLoopChatContext);
  if (!context) {
    throw new Error("useMemeLoopChatContext must be used within a MemeLoopRuntimeProvider");
  }
  return context;
}
