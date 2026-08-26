import { ProviderRegistry } from 'memeloop';
import { describe, expect, it } from 'vitest';

import { createProviderPreflight, PROVIDER_API_KEY_REQUIRED_CAPABILITY, PROVIDER_CREDENTIAL_RESOLVED_CAPABILITY, providerCredentialMetadata } from '../providerPreflight.js';

const provider = { name: 'provider-a', chat: async () => '' };
const route = {
  modelId: 'logical-model',
  wireModelId: 'wire-model',
  apiMode: 'responses' as const,
};
const input = {
  conversationId: 'conversation-a',
  definitionId: 'agent-a',
  providerId: 'provider-a',
  modelId: route.modelId,
  wireModelId: route.wireModelId,
  apiMode: route.apiMode,
};

function registryWithCredential(config: {
  capabilities?: string[];
  secretRef?: string;
}): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(
    { ownerId: 'test-host', kind: 'host' },
    provider,
    { ...config, models: [route] },
  );
  return registry;
}

describe('provider run preflight', () => {
  it('returns a stable settings error when the exact provider credential is absent', async () => {
    const registry = registryWithCredential({
      capabilities: [PROVIDER_API_KEY_REQUIRED_CAPABILITY],
    });

    await expect(Promise.resolve(createProviderPreflight(registry)(input))).resolves.toMatchObject({
      code: 'PROVIDER_AUTH_MISSING',
      providerId: 'provider-a',
      modelId: 'logical-model',
      settingTarget: { kind: 'provider', providerId: 'provider-a', field: 'apiKey' },
    });
  });

  it('accepts only a matched secretRef and resolved credential capability pair', async () => {
    const registry = registryWithCredential({
      secretRef: 'provider-config/provider-a/api-key',
      capabilities: [
        PROVIDER_API_KEY_REQUIRED_CAPABILITY,
        PROVIDER_CREDENTIAL_RESOLVED_CAPABILITY,
      ],
    });
    await expect(Promise.resolve(createProviderPreflight(registry)(input))).resolves.toBeUndefined();

    const inconsistent = registryWithCredential({
      secretRef: 'provider-config/provider-a/api-key',
      capabilities: [PROVIDER_API_KEY_REQUIRED_CAPABILITY],
    });
    await expect(Promise.resolve(createProviderPreflight(inconsistent)(input))).resolves.toMatchObject({
      code: 'PROVIDER_AUTH_MISSING',
    });
  });

  it('does not infer a different provider/model route or credential source', async () => {
    const registry = registryWithCredential({
      secretRef: 'provider-config/provider-a/api-key',
      capabilities: [
        PROVIDER_API_KEY_REQUIRED_CAPABILITY,
        PROVIDER_CREDENTIAL_RESOLVED_CAPABILITY,
      ],
    });
    await expect(Promise.resolve(
      createProviderPreflight(registry)({
        ...input,
        wireModelId: 'different-wire-model',
      }),
    )).resolves.toMatchObject({
      code: 'PROVIDER_CONFIGURATION_MISSING',
      providerId: 'provider-a',
      modelId: 'logical-model',
    });
  });

  it('publishes opaque credential metadata without retaining raw key material', () => {
    const metadata = providerCredentialMetadata({
      name: 'provider-a',
      apiKey: 'raw-super-secret',
    });
    expect(metadata).toEqual({
      secretRef: 'provider-config/provider-a/api-key',
      capabilities: [
        PROVIDER_API_KEY_REQUIRED_CAPABILITY,
        PROVIDER_CREDENTIAL_RESOLVED_CAPABILITY,
      ],
    });
    expect(JSON.stringify(metadata)).not.toContain('raw-super-secret');
    expect(providerCredentialMetadata({
      name: 'local-provider',
      apiKeyRequired: false,
    })).toEqual({ capabilities: [] });
  });
});
