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
import type { AgentInstance, AgentInstanceLatestStatus } from '../types.js';
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
  conversationId: string;
  role: ChatRole;
  content: string;
  originNodeId?: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  duration?: number | null;
  lamportClock?: number;
  toolCalls?: ChatMessage['toolCalls'];
  reasoning_content?: string;
  hidden?: boolean;
  attachments?: ChatMessage['attachments'];
  detailRef?: ChatMessage['detailRef'];
}): ChatMessage {
  const now = Date.now();
  return {
    messageId: input.messageId,
    conversationId: input.conversationId,
    originNodeId: input.originNodeId ?? 'unknown',
    timestamp: now,
    lamportClock: input.lamportClock ?? now,
    role: input.role,
    content: input.content,
    contentType: input.contentType ?? 'text/plain',
    metadata: input.metadata,
    duration: input.duration,
    toolCalls: input.toolCalls,
    reasoning_content: input.reasoning_content,
    hidden: input.hidden,
    attachments: input.attachments,
    detailRef: input.detailRef,
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
): AgentInstance {
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
