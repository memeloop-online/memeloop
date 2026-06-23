export type {
  AgentExecutionTarget,
  MemeLoopChatAdapter,
  MemeLoopComposerProps,
  MemeLoopMessageProps,
  MemeLoopThreadProps,
  MessageDetailPayload,
  SetExecutionTargetOptions,
  WikiTiddlerAttachment,
  WikiTiddlerClickData,
} from './types.js';

export { useMemeLoopChatContext } from './runtime/MemeLoopChatContext.js';
export { MemeLoopRuntimeProvider } from './runtime/MemeLoopRuntimeProvider.js';
export { useMemeLoopRuntime } from './runtime/useMemeLoopRuntime.js';

export { MemeLoopComposer } from './composer/MemeLoopComposer.js';
export { AskQuestionContent } from './content/AskQuestionContent.js';
export { MessageContent } from './content/MessageContent.js';
export { MemeLoopMessage } from './thread/MemeLoopMessage.js';
export { MemeLoopThread } from './thread/MemeLoopThread.js';

// Re-export assistant-ui runtime hooks so hosts don't need a direct dependency.
export { useAui, useAuiState } from '@assistant-ui/react';

// Re-export core chat types for consumers.
export type { ChatMessage, ChatRole } from 'memeloop';
