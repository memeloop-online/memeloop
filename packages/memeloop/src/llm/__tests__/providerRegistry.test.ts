import { describe, expect, it } from 'vitest';

import type { ILLMProvider } from '../../types.js';
import {
  assertProviderId,
  isProviderId,
  MAX_PROVIDER_MODEL_ROUTES,
  normalizeProviderModelRequestDefaults,
  PROVIDER_ID_MAX_UTF8_BYTES,
  PROVIDER_MODEL_ID_MAX_UTF8_BYTES,
  ProviderRegistry,
  type ProviderRegistryOwner,
} from '../providerRegistry.js';

function createProvider(name: string): ILLMProvider {
  return {
    name,
    model: {},
    chat() {
      return Promise.resolve('ok');
    },
  };
}

const builtin: ProviderRegistryOwner = { ownerId: 'core', kind: 'builtin' };
const host: ProviderRegistryOwner = { ownerId: 'runtime-a', kind: 'host' };
const plugin: ProviderRegistryOwner = { ownerId: 'plugin-a', kind: 'plugin' };
const openaiModels = {
  models: [{ modelId: 'gpt-5.4', wireModelId: 'gpt-5.4', apiMode: 'responses' as const }],
};
const memeloopModels = {
  models: [{
    modelId: 'assistant-large',
    wireModelId: 'claude/opus-4.6',
    apiMode: 'chat-completions' as const,
  }],
};

describe('provider id contract', () => {
  it.each([
    'a',
    'openai',
    'openai-compatible',
    'provider.v2_test',
    '0provider',
    'TestProvider',
    '提供方',
    '模型2',
    `a${'0'.repeat(PROVIDER_ID_MAX_UTF8_BYTES - 1)}`,
  ])('accepts canonical id %s', (providerId) => {
    expect(new TextEncoder().encode(providerId).byteLength)
      .toBeLessThanOrEqual(PROVIDER_ID_MAX_UTF8_BYTES);
    expect(isProviderId(providerId)).toBe(true);
    expect(() => {
      assertProviderId(providerId);
    }).not.toThrow();
  });

  it.each([
    undefined,
    '',
    'provider/name',
    'provider name',
    'provider\nname',
    `a${'0'.repeat(PROVIDER_ID_MAX_UTF8_BYTES)}`,
  ])('rejects non-canonical or over-budget id %s', (providerId) => {
    expect(isProviderId(providerId)).toBe(false);
    expect(() => {
      assertProviderId(providerId);
    }).toThrow(TypeError);
  });

  it('measures the public limit in UTF-8 bytes for Unicode ids', () => {
    const multibyte = `a${'界'.repeat(171)}`;
    expect(multibyte.length).toBeLessThan(PROVIDER_ID_MAX_UTF8_BYTES);
    expect(new TextEncoder().encode(multibyte).byteLength)
      .toBeGreaterThan(PROVIDER_ID_MAX_UTF8_BYTES);
    expect(isProviderId(multibyte)).toBe(false);
    expect(() => {
      assertProviderId(multibyte, 'provider name');
    })
      .toThrow(`provider name is invalid or exceeds ${PROVIDER_ID_MAX_UTF8_BYTES} UTF-8 bytes`);
  });
});

describe('ProviderRegistry', () => {
  it('retains bounded route request defaults as detached, deeply frozen metadata', () => {
    const source = {
      maxOutputTokens: 32_768,
      temperature: 0.2,
      topP: 0.95,
      reasoningEffort: 'high' as const,
      providerOptions: {
        openai: {
          top_p: 0.95,
          nested: { enabled: true, labels: ['route'] },
        },
      },
    };
    const normalized = normalizeProviderModelRequestDefaults(source);
    source.providerOptions.openai.nested.labels[0] = 'mutated';

    expect(normalized).toEqual({
      maxOutputTokens: 32_768,
      temperature: 0.2,
      topP: 0.95,
      reasoningEffort: 'high',
      providerOptions: {
        openai: {
          top_p: 0.95,
          nested: { enabled: true, labels: ['route'] },
        },
      },
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.providerOptions)).toBe(true);
    expect(Object.isFrozen(normalized.providerOptions?.openai)).toBe(true);
    expect(Object.isFrozen(normalized.providerOptions?.openai.nested)).toBe(true);
  });

  it('rejects legacy route-default fields instead of preserving host DTOs', () => {
    expect(() => normalizeProviderModelRequestDefaults({ modelOptions: {} }))
      .toThrow(/unknown fields/);
    expect(() => normalizeProviderModelRequestDefaults({ reasoningEffortFormat: 'tagged' }))
      .toThrow(/unknown fields/);
  });

  it('registers, lists, and resolves exact provider/model identities', () => {
    const registry = new ProviderRegistry();
    registry.register(host, createProvider('memeloop'), memeloopModels);
    registry.register(builtin, createProvider('openai'), openaiModels);

    expect(registry.list()).toEqual(['memeloop', 'openai']);
    expect(registry.resolve('memeloop', 'assistant-large')).toMatchObject({
      providerId: 'memeloop',
      modelId: 'assistant-large',
      wireModelId: 'claude/opus-4.6',
      apiMode: 'chat-completions',
      provider: { name: 'memeloop' },
    });
    expect(() => registry.resolve('memeloop', '')).toThrow(/modelId/);
    expect(() => registry.resolve('unknown', 'model')).toThrow(/Provider not found/);
  });

  it('preserves route defaults through registration, resolution, and cloned config reads', () => {
    const registry = new ProviderRegistry();
    registry.register(host, createProvider('defaults'), {
      models: [{
        modelId: 'logical',
        wireModelId: 'wire',
        apiMode: 'responses',
        requestDefaults: {
          maxOutputTokens: 128_000,
          reasoningEffort: 'high',
          providerOptions: { openai: { temperature: 0.2 } },
        },
      }],
    });

    expect(registry.resolve('defaults', 'logical')).toMatchObject({
      requestDefaults: {
        maxOutputTokens: 128_000,
        reasoningEffort: 'high',
        providerOptions: { openai: { temperature: 0.2 } },
      },
    });
    const config = registry.getConfig('defaults');
    expect(config?.models[0]?.requestDefaults).toEqual(
      registry.resolve('defaults', 'logical').requestDefaults,
    );
    expect(config?.models[0]?.requestDefaults).not.toBe(
      registry.resolve('defaults', 'logical').requestDefaults,
    );
    expect(Object.isFrozen(config?.models[0]?.requestDefaults)).toBe(true);
  });

  it('fails closed on cross-owner collision, including plugin replacement attempts', () => {
    const registry = new ProviderRegistry();
    registry.register(builtin, createProvider('openai'), openaiModels);

    expect(() => registry.register(plugin, createProvider('openai'), openaiModels))
      .toThrow(/registration collision.*core/);
    expect(registry.get('openai')?.name).toBe('openai');
    expect(() => registry.register(plugin, createProvider('OpenAI/Proxy'), openaiModels))
      .toThrow(/begin with a letter or number/);
  });

  it('uses tokenized disposal so a stale handle cannot remove a new owner', () => {
    const registry = new ProviderRegistry();
    const old = registry.register(host, createProvider('openai'), openaiModels);
    expect(old.providerId).toBe('openai');
    expect('name' in old).toBe(false);
    expect(old.dispose()).toBe(true);
    const replacement = registry.register(plugin, createProvider('openai'), openaiModels);

    expect(old.dispose()).toBe(false);
    expect(registry.get('openai')).toBeDefined();
    expect(replacement.dispose()).toBe(true);
    expect(registry.get('openai')).toBeUndefined();
  });

  it('isolates registrations across runtime-local registries', () => {
    const left = new ProviderRegistry();
    const right = new ProviderRegistry();
    left.register({ ownerId: 'left', kind: 'host' }, createProvider('openai'), openaiModels);
    right.register({ ownerId: 'right', kind: 'host' }, createProvider('openai'), openaiModels);

    expect(left.resolve('openai', 'gpt-5.4').provider).not.toBe(
      right.resolve('openai', 'gpt-5.4').provider,
    );
  });

  it('never represents or exposes raw API keys and clones public metadata', () => {
    const registry = new ProviderRegistry();
    registry.register(host, createProvider('openai'), {
      baseUrl: 'https://api.openai.com/v1',
      secretRef: 'keyring:openai',
      capabilities: ['responses', 'chat-completions'],
      ...openaiModels,
    });
    expect(() =>
      registry.register(plugin, createProvider('bad'), {
        apiKey: 'must-not-enter-registry',
        ...openaiModels,
      } as never)
    ).toThrow('invalid provider config');
    expect(() =>
      registry.register(plugin, createProvider('legacy-name'), {
        name: 'legacy-name',
        ...openaiModels,
      } as never)
    ).toThrow('invalid provider config');

    const configs = registry.listConfigs();
    expect(configs).toEqual([{
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      secretRef: 'keyring:openai',
      capabilities: ['chat-completions', 'responses'],
      models: openaiModels.models,
    }]);
    expect(JSON.stringify(configs)).not.toContain('must-not-enter-registry');
    expect(Object.isFrozen(configs[0])).toBe(true);
    expect(Object.isFrozen(configs[0].capabilities)).toBe(true);
    expect('name' in configs[0]).toBe(false);
  });

  it('accepts the shared model-route cap and rejects only values above it', () => {
    const maximumRoutes = Array.from(
      { length: MAX_PROVIDER_MODEL_ROUTES },
      (_, index) => ({
        modelId: `logical-${String(index).padStart(5, '0')}`,
        wireModelId: `vendor/wire-${index}`,
        apiMode: 'responses' as const,
      }),
    );
    const registry = new ProviderRegistry();
    registry.register(host, createProvider('large-catalog'), {
      models: maximumRoutes,
    });
    expect(registry.getConfig('large-catalog')?.models).toHaveLength(
      MAX_PROVIDER_MODEL_ROUTES,
    );
    expect(() =>
      registry.register(host, createProvider('too-large-catalog'), {
        models: [
          ...maximumRoutes,
          {
            modelId: 'logical-over-limit',
            wireModelId: 'vendor/over-limit',
            apiMode: 'responses',
          },
        ],
      })
    ).toThrow(/bounded array/);
  });

  it('uses the same UTF-8 boundary when registering and resolving model routes', () => {
    const maximumModelId = 'm'.repeat(PROVIDER_MODEL_ID_MAX_UTF8_BYTES);
    const registry = new ProviderRegistry();
    registry.register(host, createProvider('bounded-model'), {
      models: [{
        modelId: maximumModelId,
        wireModelId: maximumModelId,
        apiMode: 'responses',
      }],
    });
    expect(registry.resolve('bounded-model', maximumModelId).modelId)
      .toBe(maximumModelId);
    expect(() =>
      registry.register(host, createProvider('oversized-model'), {
        models: [{
          modelId: `${maximumModelId}x`,
          wireModelId: 'wire',
          apiMode: 'responses',
        }],
      })
    ).toThrow(/provider modelId/);
  });

  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://[::1]:11434/v1',
  ])('allows explicit loopback HTTP baseUrl %s', (baseUrl) => {
    const registry = new ProviderRegistry();
    registry.register(host, createProvider('loopback'), {
      baseUrl,
      ...openaiModels,
    });
    expect(registry.getConfig('loopback')?.baseUrl).toBe(baseUrl);
  });

  it.each([
    'https://user:password@provider.example.test/v1',
    'https://user@provider.example.test/v1',
    'http://provider.example.test/v1',
    'ftp://localhost/v1',
    ' https://provider.example.test/v1',
  ])('rejects credential-bearing or unsafe baseUrl %s', (baseUrl) => {
    const registry = new ProviderRegistry();
    expect(() =>
      registry.register(host, createProvider('unsafe-url'), {
        baseUrl,
        ...openaiModels,
      })
    ).toThrow(TypeError);
  });
});
