export interface AgentDefinitionModelConfig {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  modelConfig?: AgentDefinitionModelConfig;
  // JSON Schema object; kept as unknown to avoid tight coupling
  promptSchema?: unknown;
  /** TidGi-Desktop / memeloop：prompt 树、插件、maxIterations 等（结构见 memeloop prompt 类型） */
  agentFrameworkConfig?: unknown;
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
