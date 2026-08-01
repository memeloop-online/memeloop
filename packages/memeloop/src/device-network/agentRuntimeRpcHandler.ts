import type { AgentDefinition } from '../agent/types.js';
import type { ChatMessage } from '../conversation/index.js';
import type { MemeLoopRuntime } from '../runtime.js';
import type { ConversationMeta } from '../sync/protocol.js';
import type { IAgentStorage } from '../types.js';
import type { DeviceRpcHandler } from './types.js';

export interface AgentRuntimeDeviceRpcHandlerOptions {
  runtime: Pick<MemeLoopRuntime, 'createAgent' | 'sendMessage' | 'cancelAgent'>;
  storage: IAgentStorage;
  getAgentDefinitions?: () => AgentDefinition[] | Promise<AgentDefinition[]>;
  localNodeId?: string;
}

export function createAgentRuntimeDeviceRpcHandler(options: AgentRuntimeDeviceRpcHandlerOptions): DeviceRpcHandler {
  return async ({ method, parameters }) => {
    switch (method) {
      case 'memeloop.agent.getDefinitions':
        return { definitions: await options.getAgentDefinitions?.() ?? [] };
      case 'memeloop.agent.create': {
        const rpcParameters = objectParameter(parameters);
        return options.runtime.createAgent({
          definitionId: stringParameter(rpcParameters, 'definitionId'),
          initialMessage: optionalStringParameter(rpcParameters, 'initialMessage'),
        });
      }
      case 'memeloop.agent.send': {
        const rpcParameters = objectParameter(parameters);
        await options.runtime.sendMessage({
          conversationId: stringParameter(rpcParameters, 'conversationId'),
          message: stringParameter(rpcParameters, 'message'),
          definitionId: optionalStringParameter(rpcParameters, 'definitionId'),
          userMessage: chatMessageParameter(rpcParameters, 'userMessage'),
          resumeSession: chatMessageArrayParameter(rpcParameters, 'resumeSession'),
        });
        return { ok: true };
      }
      case 'memeloop.agent.runTurn': {
        const rpcParameters = objectParameter(parameters);
        const conversationId = stringParameter(rpcParameters, 'conversationId');
        const definitionId = stringParameter(rpcParameters, 'definitionId');
        await upsertConversationForRemoteTurn({
          storage: options.storage,
          conversationId,
          definitionId,
          conversation: conversationMetaParameter(rpcParameters, 'conversation'),
          localNodeId: options.localNodeId,
        });
        await options.runtime.sendMessage({
          conversationId,
          definitionId,
          message: stringParameter(rpcParameters, 'message'),
          userMessage: chatMessageParameter(rpcParameters, 'userMessage'),
          resumeSession: chatMessageArrayParameter(rpcParameters, 'resumeSession'),
        });
        return { ok: true, conversationId };
      }
      case 'memeloop.agent.cancel': {
        const rpcParameters = objectParameter(parameters);
        await options.runtime.cancelAgent(stringParameter(rpcParameters, 'conversationId'));
        return { ok: true };
      }
      case 'memeloop.chat.pullAgentRunLog': {
        const rpcParameters = objectParameter(parameters);
        const conversationId = stringParameter(rpcParameters, 'conversationId');
        const known = new Set(stringArrayParameter(rpcParameters, 'knownMessageIds'));
        const messages = await options.storage.getMessages(conversationId, { mode: 'full-content' });
        return { messages: messages.filter((message) => !known.has(message.messageId)) };
      }
      default:
        throw new Error(`rpc_method_not_found:${method}`);
    }
  };
}

async function upsertConversationForRemoteTurn(input: {
  storage: IAgentStorage;
  conversationId: string;
  definitionId: string;
  conversation?: ConversationMeta;
  localNodeId?: string;
}): Promise<void> {
  if (input.conversation) {
    await input.storage.upsertConversationMetadata(input.conversation);
    return;
  }
  const existing = await input.storage.getConversationMeta(input.conversationId).catch(() => null);
  if (existing) return;
  const now = Date.now();
  await input.storage.upsertConversationMetadata({
    conversationId: input.conversationId,
    title: input.definitionId,
    lastMessagePreview: '',
    lastMessageTimestamp: now,
    messageCount: 0,
    originNodeId: input.localNodeId ?? 'remote',
    originClock: 1,
    definitionId: input.definitionId,
    isUserInitiated: true,
  });
}

function objectParameter(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_rpc_params');
  return value as Record<string, unknown>;
}

function stringParameter(parameters: Record<string, unknown>, key: string): string {
  const value = parameters[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid_rpc_params');
  return value;
}

function optionalStringParameter(parameters: Record<string, unknown>, key: string): string | undefined {
  const value = parameters[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('invalid_rpc_params');
  return value;
}

function stringArrayParameter(parameters: Record<string, unknown>, key: string): string[] {
  const value = parameters[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('invalid_rpc_params');
  return value.filter((item): item is string => typeof item === 'string');
}

function chatMessageParameter(parameters: Record<string, unknown>, key: string): ChatMessage | undefined {
  const value = parameters[key];
  if (value === undefined) return undefined;
  if (!isChatMessage(value)) throw new Error('invalid_rpc_params');
  return value;
}

function chatMessageArrayParameter(parameters: Record<string, unknown>, key: string): ChatMessage[] | undefined {
  const value = parameters[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('invalid_rpc_params');
  return value.filter(isChatMessage);
}

function conversationMetaParameter(parameters: Record<string, unknown>, key: string): ConversationMeta | undefined {
  const value = parameters[key];
  if (value === undefined) return undefined;
  if (!isConversationMetaLike(value)) throw new Error('invalid_rpc_params');
  return value;
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.messageId === 'string' &&
    typeof record.conversationId === 'string' &&
    typeof record.originNodeId === 'string' &&
    typeof record.timestamp === 'number' &&
    typeof record.lamportClock === 'number' &&
    typeof record.role === 'string' &&
    typeof record.content === 'string'
  );
}

function isConversationMetaLike(value: unknown): value is ConversationMeta {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.conversationId === 'string' &&
    typeof record.title === 'string' &&
    typeof record.lastMessageTimestamp === 'number' &&
    typeof record.messageCount === 'number' &&
    typeof record.originNodeId === 'string' &&
    typeof record.originClock === 'number' &&
    typeof record.definitionId === 'string' &&
    typeof record.isUserInitiated === 'boolean'
  );
}
