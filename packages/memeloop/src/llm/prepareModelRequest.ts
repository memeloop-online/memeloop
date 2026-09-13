import { type AgentModelConfig, assertAgentModelConfig } from '../agent/types.js';
import { canonicalJsonString } from '../encoding/canonicalJson.js';
import type { ILLMProvider } from '../types.js';
import { PROVIDER_OPTION_JSON_LIMITS, type ProviderApiMode, type ProviderModelRequestDefaults, type ProviderRegistryResolver } from './providerRegistry.js';
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
  apiMode: ProviderApiMode;
  /** Exact route defaults retained for provider-specific request options. */
  requestDefaults?: Readonly<ProviderModelRequestDefaults>;
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
  const requestDefaults = resolved.requestDefaults;
  const parameters = Object.freeze({
    ...(requestDefaults?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: requestDefaults.maxOutputTokens }),
    ...(requestDefaults?.temperature === undefined
      ? {}
      : { temperature: requestDefaults.temperature }),
    ...(requestDefaults?.topP === undefined ? {} : { topP: requestDefaults.topP }),
    ...(requestDefaults?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: requestDefaults.reasoningEffort }),
    ...(modelConfig.parameters?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: modelConfig.parameters.maxOutputTokens }),
    ...(modelConfig.parameters?.temperature === undefined
      ? {}
      : { temperature: modelConfig.parameters.temperature }),
    ...(modelConfig.parameters?.topP === undefined
      ? {}
      : { topP: modelConfig.parameters.topP }),
    ...(modelConfig.parameters?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: modelConfig.parameters.reasoningEffort }),
  });
  return Object.freeze({
    ...resolved,
    ...(requestDefaults === undefined ? {} : { requestDefaults }),
    parameters,
  });
}

/** Single bounded projection used by execution, prompt preview, and summarization. */
export function prepareModelRequest(options: PrepareModelRequestOptions): PreparedModelRequest {
  const parameters = mergeRouteParameters(options.route);
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
    ...(parameters.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: parameters.reasoningEffort }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.providerOptions === undefined
      ? {}
      : { providerOptions: options.providerOptions }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return {
    route: options.route,
    request: applyProviderModelRouteDefaults(options.route, request),
  };
}

/**
 * Apply one canonical route's request defaults to a portable request.
 * Explicit request fields win; provider options merge by namespace and key,
 * with call-scoped values winning over route defaults.
 */
export function applyProviderModelRouteDefaults(
  route: Pick<ResolvedAgentModelRoute, 'requestDefaults'>,
  request: PortableLlmRequest,
): PortableLlmRequest {
  assertPortableLlmRequest(request);
  const defaults = route.requestDefaults;
  const providerOptions = mergeProviderOptions(
    defaults?.providerOptions,
    request.providerOptions,
  );
  const applied: PortableLlmRequest = {
    ...request,
    ...(request.maxOutputTokens === undefined && defaults?.maxOutputTokens !== undefined
      ? { maxOutputTokens: defaults.maxOutputTokens }
      : {}),
    ...(request.temperature === undefined && defaults?.temperature !== undefined
      ? { temperature: defaults.temperature }
      : {}),
    ...(request.topP === undefined && defaults?.topP !== undefined
      ? { topP: defaults.topP }
      : {}),
    ...(request.reasoningEffort === undefined && defaults?.reasoningEffort !== undefined
      ? { reasoningEffort: defaults.reasoningEffort }
      : {}),
    ...(request.providerOptions === undefined && providerOptions === undefined
      ? {}
      : providerOptions === undefined
      ? {}
      : { providerOptions }),
  };
  assertPortableLlmRequest(applied);
  return applied;
}

function mergeRouteParameters(
  route: ResolvedAgentModelRoute,
): Readonly<NonNullable<AgentModelConfig['parameters']>> {
  const defaults = route.requestDefaults;
  return Object.freeze({
    ...(defaults?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: defaults.maxOutputTokens }),
    ...(defaults?.temperature === undefined ? {} : { temperature: defaults.temperature }),
    ...(defaults?.topP === undefined ? {} : { topP: defaults.topP }),
    ...(defaults?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: defaults.reasoningEffort }),
    ...route.parameters,
  });
}

/** Merge provider-specific defaults by provider and then by option key. */
function mergeProviderOptions(
  defaults: ProviderModelRequestDefaults['providerOptions'],
  overrides: PortableLlmRequest['providerOptions'],
): PortableLlmRequest['providerOptions'] {
  if (defaults === undefined && overrides === undefined) return undefined;
  const providers = new Set<string>([
    ...(defaults === undefined ? [] : Object.keys(defaults)),
    ...(overrides === undefined ? [] : Object.keys(overrides)),
  ]);
  const merged: NonNullable<PortableLlmRequest['providerOptions']> = {};
  for (const provider of providers) {
    const defaultOptions = defaults?.[provider];
    const overrideOptions = overrides?.[provider];
    if (defaultOptions === undefined && overrideOptions === undefined) continue;
    merged[provider] = {
      ...(defaultOptions === undefined ? {} : defaultOptions),
      ...(overrideOptions === undefined ? {} : overrideOptions),
    };
  }
  const detached: unknown = JSON.parse(canonicalJsonString(merged, PROVIDER_OPTION_JSON_LIMITS));
  return detached as PortableLlmRequest['providerOptions'];
}
