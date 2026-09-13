import { isProviderId } from '../llm/providerRegistry.js';
import type { AgentFrameworkConfig } from '../promptUtilities/types.js';

export interface AgentModelParameters {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  reasoningEffort?: AgentReasoningEffort;
}

export type AgentReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/** The only model-selection shape accepted by definitions, instances, profiles, and hosts. */
export interface AgentModelConfig {
  providerId: string;
  modelId: string;
  parameters?: AgentModelParameters;
}

/** Canonical model routes used by agent hosts and auxiliary AI capabilities. */
export interface ModelAssignments {
  default?: AgentModelConfig;
  embedding?: AgentModelConfig;
  speech?: AgentModelConfig;
  imageGeneration?: AgentModelConfig;
  transcriptions?: AgentModelConfig;
  free?: AgentModelConfig;
}

const MODEL_ASSIGNMENT_KEYS = [
  'default',
  'embedding',
  'speech',
  'imageGeneration',
  'transcriptions',
  'free',
] as const satisfies readonly (keyof ModelAssignments)[];

export function assertModelAssignments(value: unknown): asserts value is ModelAssignments {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid model assignments');
  }
  const assignments = value as Record<string, unknown>;
  if (Object.keys(assignments).some(key => !MODEL_ASSIGNMENT_KEYS.includes(key as keyof ModelAssignments))) {
    throw new TypeError('invalid model assignment fields');
  }
  for (const key of MODEL_ASSIGNMENT_KEYS) {
    if (assignments[key] !== undefined) assertAgentModelConfig(assignments[key]);
  }
}

/** Validate and detach the portable assignment graph at a host boundary. */
export function normalizeModelAssignments(value: unknown): ModelAssignments {
  assertModelAssignments(value);
  const normalized: ModelAssignments = {};
  for (const key of MODEL_ASSIGNMENT_KEYS) {
    const selection = value[key];
    if (selection === undefined) continue;
    normalized[key] = {
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(selection.parameters === undefined
        ? {}
        : { parameters: { ...selection.parameters } }),
    };
  }
  return normalized;
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

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  modelConfig?: AgentModelConfig;
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

export function resolveAgentModelConfig(options: {
  definition: Pick<AgentDefinition, 'modelConfig'>;
  instanceDelta?: Pick<Partial<AgentDefinition>, 'modelConfig'>;
  hostDefault?: AgentModelConfig;
}): AgentModelConfig {
  const selected = options.instanceDelta?.modelConfig ??
    options.definition.modelConfig ?? options.hostDefault;
  if (!selected) throw new Error('agent model selection is not configured');
  assertAgentModelConfig(selected);
  return {
    providerId: selected.providerId,
    modelId: selected.modelId,
    ...(selected.parameters === undefined ? {} : { parameters: { ...selected.parameters } }),
  };
}

export function assertAgentModelConfig(value: unknown): asserts value is AgentModelConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid agent modelConfig');
  }
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(key => !['providerId', 'modelId', 'parameters'].includes(key))) {
    throw new TypeError('invalid agent modelConfig fields');
  }
  if (!isProviderId(config.providerId) || !isModelIdentifier(config.modelId, true)) {
    throw new TypeError('invalid agent modelConfig providerId/modelId');
  }
  if (config.parameters !== undefined) assertAgentModelParameters(config.parameters);
}

function assertAgentModelParameters(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid agent model parameters');
  }
  const parameters = value as Record<string, unknown>;
  if (Object.keys(parameters).some(key => !['temperature', 'maxOutputTokens', 'topP', 'reasoningEffort'].includes(key))) {
    throw new TypeError('invalid agent model parameter fields');
  }
  if (
    parameters.temperature !== undefined &&
    (typeof parameters.temperature !== 'number' || !Number.isFinite(parameters.temperature) ||
      parameters.temperature < 0 || parameters.temperature > 2)
  ) throw new TypeError('invalid agent model temperature');
  if (
    parameters.maxOutputTokens !== undefined &&
    (typeof parameters.maxOutputTokens !== 'number' ||
      !Number.isSafeInteger(parameters.maxOutputTokens) || parameters.maxOutputTokens < 1 ||
      parameters.maxOutputTokens > 1_000_000)
  ) throw new TypeError('invalid agent model maxOutputTokens');
  if (
    parameters.topP !== undefined &&
    (typeof parameters.topP !== 'number' || !Number.isFinite(parameters.topP) ||
      parameters.topP < 0 || parameters.topP > 1)
  ) throw new TypeError('invalid agent model topP');
  if (
    parameters.reasoningEffort !== undefined &&
    (typeof parameters.reasoningEffort !== 'string' ||
      !['minimal', 'low', 'medium', 'high'].includes(parameters.reasoningEffort))
  ) throw new TypeError('invalid agent model reasoningEffort');
}

function isModelIdentifier(value: unknown, allowSlash: boolean): value is string {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > 512) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || !allowSlash && value[index] === '/') return false;
  }
  return true;
}
