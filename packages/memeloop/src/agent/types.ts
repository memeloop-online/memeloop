import type { AgentFrameworkConfig } from '../promptUtilities/types.js';

export interface AgentDefinitionModelConfig {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ModelSelection {
  provider: string;
  model: string;
  [key: string]: unknown;
}

export interface ModelParameters {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  [key: string]: unknown;
}

export interface AiAPIConfig {
  default?: ModelSelection;
  embedding?: ModelSelection;
  speech?: ModelSelection;
  imageGeneration?: ModelSelection;
  transcriptions?: ModelSelection;
  free?: ModelSelection;
  modelParameters: ModelParameters;
  [key: string]: unknown;
}

export interface AgentHeartbeatConfig {
  enabled: boolean;
  intervalSeconds: number;
  message: string;
  activeHoursStart?: string;
  activeHoursEnd?: string;
}

export interface AgentDefinitionToolConfig {
  toolId: string;
  enabled?: boolean;
  parameters?: Record<string, unknown>;
  tags?: string[];
}

export type HostAgentToolConfig = AgentDefinitionToolConfig;

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  modelConfig?: AgentDefinitionModelConfig;
  // JSON Schema object; kept as unknown to avoid tight coupling
  promptSchema?: unknown;
  /**
   * TidGi-Desktop / memeloop：prompt 树、插件、maxIterations 等（结构见 memeloop prompt 类型）
   * Typed as `AgentFrameworkConfig` so all hosts share a single canonical shape.
   */
  agentFrameworkConfig?: AgentFrameworkConfig;
  /** Host-specific explicit tool configuration. Hosts map this to prompt plugins at runtime. */
  agentTools?: AgentDefinitionToolConfig[];
  /** Host-specific avatar or icon URL. */
  avatarUrl?: string;
  /** Host-specific agent handler / framework ID. */
  agentFrameworkID?: string;
  /** Periodic auto-wake configuration. */
  heartbeat?: AgentHeartbeatConfig;
  /** Host-specific AI API config override. */
  aiApiConfig?: AiAPIConfig;
  version: string;
}

export interface AgentInstanceMeta {
  instanceId: string;
  definitionId: string;
  nodeId: string;
  conversationId: string;
  createdAt: number;
  updatedAt: number;
  // Only store fields that differ from the base definition
  definitionDelta?: Partial<AgentDefinition>;
}
