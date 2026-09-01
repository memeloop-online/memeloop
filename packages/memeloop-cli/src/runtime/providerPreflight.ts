import { type AgentRunError, createMissingApiKeyAgentRunError, createMissingProviderSettingAgentRunError, type ProviderRegistry } from 'memeloop';

import type { ProviderEntry } from '../config.js';

export const PROVIDER_API_KEY_REQUIRED_CAPABILITY = 'credential/api-key-required/v1';
export const PROVIDER_CREDENTIAL_RESOLVED_CAPABILITY = 'credential/resolved/v1';

export interface ProviderPreflightInput {
  conversationId: string;
  definitionId: string;
  providerId: string;
  modelId: string;
  wireModelId: string;
  apiMode: 'chat-completions' | 'responses';
}

export type ProviderPreflight = (
  input: ProviderPreflightInput,
) => AgentRunError | undefined | Promise<AgentRunError | undefined>;

/**
 * Publish credential state as opaque metadata. The raw value is deliberately
 * neither accepted by ProviderRegistry nor captured by the preflight closure.
 */
export function providerCredentialMetadata(
  entry: Pick<ProviderEntry, 'apiKey' | 'apiKeyRequired' | 'name'>,
): { secretRef?: string; capabilities: string[] } {
  if (entry.apiKeyRequired === false) return { capabilities: [] };
  const hasCredential = typeof entry.apiKey === 'string' && entry.apiKey.length > 0;
  return {
    capabilities: [
      PROVIDER_API_KEY_REQUIRED_CAPABILITY,
      ...(hasCredential ? [PROVIDER_CREDENTIAL_RESOLVED_CAPABILITY] : []),
    ],
    ...(hasCredential
      ? { secretRef: `provider-config/${entry.name}/api-key` }
      : {}),
  };
}

/** Build the host-owned exact-route credential gate used before durable acceptance. */
export function createProviderPreflight(
  providerRegistry: ProviderRegistry,
): ProviderPreflight {
  return input => {
    const config = providerRegistry.getConfig(input.providerId);
    const route = config?.models.find(candidate =>
      candidate.modelId === input.modelId &&
      candidate.wireModelId === input.wireModelId &&
      candidate.apiMode === input.apiMode
    );
    if (!config || config.providerId !== input.providerId || !route) {
      return createMissingProviderSettingAgentRunError({
        providerId: input.providerId,
        modelId: input.modelId,
        field: 'model',
      });
    }

    const capabilities = new Set(config.capabilities ?? []);
    const requiresApiKey = capabilities.has(PROVIDER_API_KEY_REQUIRED_CAPABILITY);
    const hasResolvedCredential = capabilities.has(PROVIDER_CREDENTIAL_RESOLVED_CAPABILITY) &&
      typeof config.secretRef === 'string' &&
      config.secretRef.length > 0;
    const inconsistentCredentialMetadata = requiresApiKey !== (config.secretRef !== undefined) ||
      capabilities.has(PROVIDER_CREDENTIAL_RESOLVED_CAPABILITY) !==
        (config.secretRef !== undefined);
    if (requiresApiKey && !hasResolvedCredential || inconsistentCredentialMetadata) {
      return createMissingApiKeyAgentRunError({
        providerId: input.providerId,
        modelId: input.modelId,
      });
    }
    return undefined;
  };
}
