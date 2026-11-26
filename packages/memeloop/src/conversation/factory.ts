/**
 * Domain factories for creating canonical ChatMessage and AgentInstance objects.
 *
 * These factories ensure that every host (Desktop, Mobile, CLI, Cloud)
 * constructs messages and instances with the same required fields,
 * default values, and clock behavior.
 *
 * Hosts that need a different originNodeId, message ID scheme, or lamport
 * clock source should pass those values explicitly rather than creating
 * their own factory.
 */
import type { AgentDefinition } from '../agent/types.js';
import type { AgentFrameworkConfig } from '../promptUtilities/types.js';
import type { AgentInstanceLatestStatus, AgentInstanceMetadata, AgentInstanceModel } from '../types.js';
import type { ConversationEventDraft } from './events.js';
import { buildCanonicalChatMessageParts, projectChatMessageParts } from './parts.js';
import type { ChatMessage, ChatRole } from './types.js';

/**
 * Create a canonical ChatMessage with required defaults.
 *
 * @param input.messageId - Unique message identifier. Use nanoid or equivalent.
 * @param input.conversationId - The conversation/agent-instance this message belongs to.
 * @param input.role - Message role (user, assistant, tool, agent, error).
 * @param input.content - Message text content.
 * @param input.originNodeId - Node that originated this message. Core default is "unknown";
 *   hosts should pass their own identifier (e.g. "tidgi-desktop", "memeloop-cli").
 * @param input.contentType - MIME type override (default "text/plain").
 * @param input.metadata - Optional metadata map.
 * @param input.duration - Processing duration in ms.
 * @param input.lamportClock - Lamport clock value. Defaults to `Date.now()`.
 * @param input.toolCalls - Tool calls associated with assistant messages.
 * @param input.reasoning_content - Reasoning/thinking content.
 * @param input.hidden - Whether the message is hidden from the UI.
 * @param input.detailRef - Reference to large tool output stored elsewhere.
 */
export function createChatMessage(input: {
  messageId: string;
  turnId: string;
  conversationId: string;
  role: ChatRole;
  content?: string;
  originNodeId: string;
  originSequence: number;
  contentType?: string;
  metadata?: Record<string, unknown>;
  duration?: number | null;
  timestamp: number;
  lamportClock: number;
  parts?: ChatMessage['parts'];
  toolCalls?: ChatMessage['toolCalls'];
  reasoning_content?: string;
  hidden?: boolean;
  attachments?: ChatMessage['attachments'];
  detailRef?: ChatMessage['detailRef'];
}): ChatMessage {
  const parts = buildCanonicalChatMessageParts({
    role: input.role,
    content: input.content,
    parts: input.parts,
    reasoning_content: input.reasoning_content,
    toolCalls: input.toolCalls,
    attachments: input.attachments,
    detailRef: input.detailRef,
    metadata: input.metadata,
  });
  const projection = projectChatMessageParts(parts);
  return {
    messageId: input.messageId,
    turnId: input.turnId,
    conversationId: input.conversationId,
    originNodeId: input.originNodeId,
    originSequence: input.originSequence,
    timestamp: input.timestamp,
    lamportClock: input.lamportClock,
    role: input.role,
    parts,
    content: input.content ?? projection.content,
    contentType: input.contentType ?? 'text/plain',
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.duration === undefined ? {} : { duration: input.duration }),
    ...(projection.toolCalls === undefined ? {} : { toolCalls: projection.toolCalls }),
    ...(projection.reasoning_content === undefined ? {} : { reasoning_content: projection.reasoning_content }),
    ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
    ...(projection.attachments === undefined ? {} : { attachments: projection.attachments }),
    ...(input.detailRef === undefined ? {} : { detailRef: input.detailRef }),
  };
}

/** Construct an unassigned local message event for storage.appendLocalEvent. */
export function createLocalMessageDraft(input: {
  messageId: string;
  turnId: string;
  conversationId: string;
  originNodeId: string;
  timestamp: number;
  role: ChatRole;
  content?: string;
  parts?: ChatMessage['parts'];
  toolCalls?: ChatMessage['toolCalls'];
  attachments?: ChatMessage['attachments'];
  detailRef?: ChatMessage['detailRef'];
  reasoning_content?: string;
  contentType?: string;
  hidden?: boolean;
  duration?: number | null;
  metadata?: Record<string, unknown>;
}): ConversationEventDraft {
  const parts = buildCanonicalChatMessageParts(input);
  const projection = projectChatMessageParts(parts);
  return {
    eventId: input.messageId,
    conversationId: input.conversationId,
    originNodeId: input.originNodeId,
    timestamp: input.timestamp,
    kind: 'message',
    message: {
      messageId: input.messageId,
      turnId: input.turnId,
      role: input.role,
      parts,
      content: input.content ?? projection.content,
      ...(projection.toolCalls === undefined ? {} : { toolCalls: projection.toolCalls }),
      ...(projection.attachments === undefined ? {} : { attachments: projection.attachments }),
      ...(input.detailRef === undefined ? {} : { detailRef: input.detailRef }),
      ...(projection.reasoning_content === undefined ? {} : { reasoning_content: projection.reasoning_content }),
      contentType: input.contentType ?? 'text/plain',
      ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
      ...(input.duration === undefined ? {} : { duration: input.duration }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  };
}

/**
 * Default status applied to newly created agent instances.
 */
const DEFAULT_INSTANCE_STATUS: AgentInstanceLatestStatus = {
  state: 'completed',
  modified: new Date(),
};

/**
 * Create an AgentInstance from an AgentDefinition.
 *
 * The returned instance has an empty message list, a default "completed"
 * status, and copies all definition-level fields as instance defaults.
 *
 * @param definition - The AgentDefinition to base the instance on.
 * @param overrides - Optional overrides for instance-specific fields:
 *   - `id`: Instance ID (default: nanoid-equivalent, must be provided by host)
 *   - `name`: Display name (default: definition.name)
 *   - `status`: Initial status
 *   - `volatile`: Whether the instance is ephemeral
 *   - `closed`: Whether closed on creation
 *   - `isDelegatedAgentRun`, `parentAgentRunId`: Delegated agent relationship
 *   - `agentFrameworkConfig`: Per-instance framework config override
 */
export function createAgentInstanceFromDefinition(
  definition: AgentDefinition,
  overrides: {
    id: string;
    name?: string;
    status?: AgentInstanceLatestStatus;
    volatile?: boolean;
    closed?: boolean;
    isDelegatedAgentRun?: boolean;
    parentAgentRunId?: string;
    agentFrameworkConfig?: AgentFrameworkConfig;
  },
): AgentInstanceModel {
  const now = new Date();
  return {
    ...definition,
    id: overrides.id,
    agentDefId: definition.id,
    name: overrides.name ?? definition.name,
    status: overrides.status ?? DEFAULT_INSTANCE_STATUS,
    messages: [],
    created: now,
    modified: now,
    closed: overrides.closed ?? false,
    volatile: overrides.volatile ?? false,
    isDelegatedAgentRun: overrides.isDelegatedAgentRun,
    parentAgentRunId: overrides.parentAgentRunId,
    agentFrameworkConfig: overrides.agentFrameworkConfig,
  };
}

/**
 * Materialize the exact execution model from bounded durable metadata and its
 * matching definition. Hosts must not fabricate definition fields merely to
 * satisfy defineTool/plugin hooks.
 */
export function materializeAgentInstanceModel(
  metadata: AgentInstanceMetadata,
  definition: AgentDefinition,
  messages: ChatMessage[],
): AgentInstanceModel {
  if (metadata.agentDefId !== definition.id) {
    throw new Error('agent instance definition mismatch');
  }
  return {
    ...definition,
    id: metadata.id,
    agentDefId: metadata.agentDefId,
    name: metadata.name ?? definition.name,
    messages,
    status: metadata.status,
    created: metadata.created,
    ...(metadata.modified === undefined ? {} : { modified: metadata.modified }),
    ...(metadata.modelConfig === undefined ? {} : { modelConfig: metadata.modelConfig }),
    ...(metadata.avatarUrl === undefined ? {} : { avatarUrl: metadata.avatarUrl }),
    ...(metadata.agentFrameworkConfig === undefined ? {} : { agentFrameworkConfig: metadata.agentFrameworkConfig }),
    closed: metadata.closed,
    volatile: metadata.volatile,
  };
}
