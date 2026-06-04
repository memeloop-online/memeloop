/** TaskAgent 对外契约（避免 types.ts ↔ taskAgent 循环引用）。 */

import type { ChatMessage } from '../protocol/index.js';

export interface TaskAgentInput {
  conversationId: string;
  message: string;
  /** If provided, these messages are loaded as conversation history on resume. */
  resumeSession?: ChatMessage[];
}

export interface TaskAgentStep {
  type: 'thinking' | 'tool' | 'message' | 'permission_request';
  data: unknown;
}

export type TaskAgentGenerator = AsyncGenerator<TaskAgentStep, void, unknown>;
