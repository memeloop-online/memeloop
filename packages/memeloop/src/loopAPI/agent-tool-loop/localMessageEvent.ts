import { type ChatMessage, conversationEventToMessage, type ConversationMessagePayload } from '../../conversation/index.js';
import type { AgentFrameworkContext } from '../../types.js';
import { normalizeGeneratedConversationMessageForAdmission } from '../../userMessageAdmission.js';

export function requireLocalNodeId(context: AgentFrameworkContext): string {
  const localNodeId = context.localNodeId?.trim();
  if (!localNodeId) {
    throw new Error('Local conversation events require a stable AgentFrameworkContext.localNodeId');
  }
  return localNodeId;
}

/** Atomically append and project one locally originated message event. */
export async function appendLocalMessageEvent(
  context: AgentFrameworkContext,
  input: {
    conversationId: string;
    timestamp?: number;
    message: ConversationMessagePayload;
  },
): Promise<ChatMessage> {
  const originNodeId = requireLocalNodeId(context);
  const timestamp = input.timestamp ?? Date.now();
  const message = normalizeGeneratedConversationMessageForAdmission({
    conversationId: input.conversationId,
    originNodeId,
    timestamp,
    message: input.message,
  });
  const event = await context.storage.appendLocalEvent({
    kind: 'message',
    eventId: message.messageId,
    conversationId: input.conversationId,
    originNodeId,
    timestamp,
    message,
  });
  if (event.kind !== 'message') {
    throw new Error(`storage.appendLocalEvent returned ${event.kind} for a message draft`);
  }
  return conversationEventToMessage(event);
}
