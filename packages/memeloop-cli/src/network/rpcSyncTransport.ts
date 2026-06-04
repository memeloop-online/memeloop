import type { ChatMessage, ConversationMeta } from "memeloop";
import type { PeerNodeTransport } from "memeloop";

/**
 * 将 ChatSyncEngine 的 peer 调用映射为对远端节点的 JSON-RPC（memeloop.sync.* / storage.getAttachmentBlob）。
 */
export function createPeerRpcSyncTransport(
  sendRpc: (nodeId: string, method: string, params: unknown) => Promise<unknown>,
): PeerNodeTransport {
  return {
    nodeId: "local",
    async exchangeVersionVector(targetNodeId, localVersion) {
      const result = (await sendRpc(targetNodeId, "memeloop.sync.exchangeVersionVector", {
        localVersion,
      })) as { remoteVersion?: Record<string, number>; missingForRemote?: ConversationMeta[] };
      return {
        remoteVersion: result?.remoteVersion ?? {},
        missingForRemote: Array.isArray(result?.missingForRemote) ? result.missingForRemote : [],
      };
    },
    async pullMissingMetadata(targetNodeId, sinceVersion) {
      const result = (await sendRpc(targetNodeId, "memeloop.sync.pullMissingMetadata", {
        sinceVersion,
      })) as { metas?: ConversationMeta[] };
      return Array.isArray(result?.metas) ? result.metas : [];
    },
    async pullMissingMessages(targetNodeId, conversationId, knownMessageIds) {
      const result = (await sendRpc(targetNodeId, "memeloop.sync.pullMissingMessages", {
        conversationId,
        knownMessageIds,
      })) as { messages?: ChatMessage[] };
      return Array.isArray(result?.messages) ? result.messages : [];
    },
    async pullAttachmentBlob(targetNodeId, contentHash) {
      const result = (await sendRpc(targetNodeId, "memeloop.storage.getAttachmentBlob", {
        contentHash,
      })) as {
        found?: boolean;
        dataBase64?: string;
        filename?: string;
        mimeType?: string;
        size?: number;
      };
      if (!result?.found || typeof result.dataBase64 !== "string") {
        return null;
      }
      const data = Buffer.from(result.dataBase64, "base64");
      return {
        data: new Uint8Array(data),
        filename: result.filename ?? "attachment",
        mimeType: result.mimeType ?? "application/octet-stream",
        size: result.size ?? data.length,
      };
    },
  };
}
