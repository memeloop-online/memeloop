import { describe, expect, it } from 'vitest';

import type { ILLMProvider } from '../../types.js';
import { ProviderRegistry, type ProviderRegistryOwner } from '../providerRegistry.js';

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
    modelId: 'claude/opus-4.6',
    wireModelId: 'claude/opus-4.6',
    apiMode: 'chat-completions' as const,
  }],
};

describe('ProviderRegistry', () => {
  it('registers, lists, and resolves exact provider/model identities', () => {
    const registry = new ProviderRegistry();
    registry.register(host, createProvider('memeloop'), memeloopModels);
    registry.register(builtin, createProvider('openai'), openaiModels);

    expect(registry.list()).toEqual(['memeloop', 'openai']);
    expect(registry.resolve('memeloop', 'claude/opus-4.6')).toMatchObject({
      providerId: 'memeloop',
      modelId: 'claude/opus-4.6',
      wireModelId: 'claude/opus-4.6',
      apiMode: 'chat-completions',
      provider: { name: 'memeloop' },
    });
    expect(() => registry.resolve('memeloop', '')).toThrow(/modelId/);
    expect(() => registry.resolve('unknown', 'model')).toThrow(/Provider not found/);
  });

  it('fails closed on cross-owner collision, including plugin replacement attempts', () => {
    const registry = new ProviderRegistry();
    registry.register(builtin, createProvider('openai'), openaiModels);

    expect(() => registry.register(plugin, createProvider('openai'), openaiModels))
      .toThrow(/registration collision.*core/);
    expect(registry.get('openai')?.name).toBe('openai');
    expect(() => registry.register(plugin, createProvider('OpenAI'), openaiModels))
      .toThrow(/canonical lowercase/);
  });

  it('uses tokenized disposal so a stale handle cannot remove a new owner', () => {
    const registry = new ProviderRegistry();
    const old = registry.register(host, createProvider('openai'), openaiModels);
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

    const configs = registry.listConfigs();
    expect(configs).toEqual([{
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      secretRef: 'keyring:openai',
      capabilities: ['chat-completions', 'responses'],
      models: openaiModels.models,
    }]);
    expect(JSON.stringify(configs)).not.toContain('must-not-enter-registry');
    expect(Object.isFrozen(configs[0])).toBe(true);
    expect(Object.isFrozen(configs[0].capabilities)).toBe(true);
  });
});
