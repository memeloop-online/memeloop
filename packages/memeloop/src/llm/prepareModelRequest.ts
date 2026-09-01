import { type AgentModelConfig, assertAgentModelConfig } from '../agent/types.js';
import type { ILLMProvider } from '../types.js';
import type { ProviderRegistryResolver } from './providerRegistry.js';
import {
  assertPortableLlmRequest,
  type PortableLlmMessage,
  type PortableLlmRequest,
  type PortableLlmStructuredOutput,
  type PortableLlmToolChoice,
  type PortableLlmToolDefinition,
} from './request.js';

export interface ResolvedAgentModelRoute {
  provider: ILLMProvider;
  providerId: string;
  modelId: string;
  wireModelId: string;
  apiMode: 'chat-completions' | 'responses';
  parameters: Readonly<NonNullable<AgentModelConfig['parameters']>>;
}

export interface PrepareModelRequestOptions {
  route: ResolvedAgentModelRoute;
  messages: PortableLlmMessage[];
  conversationId?: string;
  stream?: boolean;
  tools?: PortableLlmToolDefinition[];
  toolChoice?: PortableLlmToolChoice;
  output?: PortableLlmStructuredOutput;
  providerOptions?: PortableLlmRequest['providerOptions'];
  signal?: AbortSignal;
}

export interface PreparedModelRequest {
  route: ResolvedAgentModelRoute;
  request: PortableLlmRequest;
}

export function resolveAgentModelRoute(
  registry: ProviderRegistryResolver,
  modelConfig: AgentModelConfig,
): ResolvedAgentModelRoute {
  assertAgentModelConfig(modelConfig);
  const resolved = registry.resolve(modelConfig.providerId, modelConfig.modelId);
  return Object.freeze({
    ...resolved,
    parameters: Object.freeze({ ...modelConfig.parameters }),
  });
}

/** Single bounded projection used by execution, prompt preview, and summarization. */
export function prepareModelRequest(options: PrepareModelRequestOptions): PreparedModelRequest {
  const parameters = options.route.parameters;
  const request: PortableLlmRequest = {
    providerId: options.route.providerId,
    logicalModelId: options.route.modelId,
    wireModelId: options.route.wireModelId,
    apiMode: options.route.apiMode,
    messages: options.messages,
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    ...(options.stream === undefined ? {} : { stream: options.stream }),
    ...(parameters.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: parameters.maxOutputTokens }),
    ...(parameters.temperature === undefined ? {} : { temperature: parameters.temperature }),
    ...(parameters.topP === undefined ? {} : { topP: parameters.topP }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.providerOptions === undefined
      ? {}
      : { providerOptions: options.providerOptions }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  assertPortableLlmRequest(request);
  return { route: options.route, request };
}
