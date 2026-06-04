export type VersionVector = Record<string, number>;

export interface ConversationMeta {
  conversationId: string;
  title: string;
  lastMessagePreview: string;
  lastMessageTimestamp: number;
  messageCount: number;
  originNodeId: string;
  definitionId: string;
  instanceDelta?: Record<string, unknown>;
  isUserInitiated: boolean;
  sourceChannel?: {
    channelId: string;
    platform: string;
    imUserId: string;
  };
}

export function isConversationMeta(value: unknown): value is ConversationMeta {
  if (value === null || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.conversationId === "string" &&
    typeof o.title === "string" &&
    typeof o.originNodeId === "string" &&
    typeof o.definitionId === "string" &&
    typeof o.messageCount === "number" &&
    typeof o.lastMessageTimestamp === "number" &&
    typeof o.isUserInitiated === "boolean"
  );
}
