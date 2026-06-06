import { describe, expect, it } from 'vitest';

import type { ILLMProvider } from '../../types.js';
import { ProviderRegistry } from '../providerRegistry.js';

function createProvider(name: string): ILLMProvider {
  return {
    name,
    model: {},
    chat() {
      return Promise.resolve('ok');
    },
  };
}

describe('ProviderRegistry', () => {
  it('registers and lists providers', () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('memeloop'));
    registry.register(createProvider('openai'));

    expect(registry.list()).toEqual(['memeloop', 'openai']);
  });

  it('unregisters provider', () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('memeloop'));
    registry.unregister('memeloop');

    expect(registry.get('memeloop')).toBeUndefined();
  });

  it('resolves provider by modelId prefix', () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('memeloop'));

    const result = registry.resolve('memeloop/claude-opus-4.6');

    expect(result.providerName).toBe('memeloop');
    expect(result.modelName).toBe('claude-opus-4.6');
    expect(result.provider.name).toBe('memeloop');
  });

  it('resolve returns modelName=undefined for bare provider name', () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider('openai'));

    const result = registry.resolve('openai');
    expect(result.providerName).toBe('openai');
    expect(result.modelName).toBeUndefined();
  });

  it('throws if provider not found', () => {
    const registry = new ProviderRegistry();

    expect(() => registry.resolve('unknown/model')).toThrow(
      /Provider not found/,
    );
  });
});
