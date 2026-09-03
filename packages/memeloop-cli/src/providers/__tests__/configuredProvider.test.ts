import { describe, expect, it } from 'vitest';

import type { ProviderAccountConfig } from 'memeloop';
import { applyConfiguredModelDefaults, createConfiguredProvider, resolveConfiguredModels } from '../configuredProvider.js';

const account: ProviderAccountConfig = {
  providerId: 'openai',
  providerType: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  secretRef: 'provider-config/openai/api-key',
  models: [
    { modelId: 'chat', wireModelId: 'gpt-4o-mini', apiMode: 'chat-completions' },
    { modelId: 'reasoning', wireModelId: 'gpt-4o', apiMode: 'responses' },
  ],
};

const accountWithCatalogMetadata: ProviderAccountConfig = {
  ...account,
  catalogProvider: {
    id: account.providerId,
    name: 'OpenAI catalog',
    env: ['OPENAI_API_KEY'],
    models: [
      {
        id: 'chat',
        name: 'GPT Chat',
        attachment: false,
        reasoning: false,
        toolCall: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 128_000, output: 16_384 },
      },
      {
        id: 'reasoning',
        name: 'GPT Reasoning',
        attachment: false,
        reasoning: true,
        toolCall: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 200_000, output: 32_768 },
      },
    ],
  },
};

describe('configured CLI providers', () => {
  it('uses canonical model routes without map/array normalization', () => {
    expect(resolveConfiguredModels(account)).toEqual([
      { id: 'chat', modelName: 'gpt-4o-mini', apiMode: 'chat-completions' },
      { id: 'reasoning', modelName: 'gpt-4o', apiMode: 'responses' },
    ]);
  });

  it('keeps logical ids separate from wire ids', async () => {
    const provider = await createConfiguredProvider({
      ...account,
      providerId: 'openai',
      secretRef: undefined,
    });
    expect(provider.modelId).toBe('chat');
    if (typeof provider.model !== 'function') throw new Error('missing model factory');
    expect(provider.model('chat')).toMatchObject({
      modelId: 'gpt-4o-mini',
      provider: 'openai.chat',
    });
    expect(provider.model('reasoning')).toMatchObject({
      modelId: 'gpt-4o',
      provider: 'openai.responses',
    });
  });

  it('retains catalog metadata while routes remain authoritative', () => {
    expect(resolveConfiguredModels(accountWithCatalogMetadata)).toEqual([
      {
        id: 'chat',
        modelName: 'gpt-4o-mini',
        apiMode: 'chat-completions',
        catalogModel: expect.objectContaining({
          name: 'GPT Chat',
          reasoning: false,
          toolCall: true,
          limit: { context: 128_000, output: 16_384 },
        }),
      },
      {
        id: 'reasoning',
        modelName: 'gpt-4o',
        apiMode: 'responses',
        catalogModel: expect.objectContaining({
          name: 'GPT Reasoning',
          reasoning: true,
          limit: { context: 200_000, output: 32_768 },
        }),
      },
    ]);
  });

  it('applies only the exact canonical route', () => {
    const request = {
      providerId: 'openai',
      logicalModelId: 'reasoning',
      wireModelId: 'gpt-4o-mini',
      apiMode: 'responses' as const,
      messages: [{ role: 'user' as const, content: 'hello' }],
    };
    expect(applyConfiguredModelDefaults(account, request)).toMatchObject({
      logicalModelId: 'reasoning',
      wireModelId: 'gpt-4o',
      apiMode: 'responses',
    });
  });

  it('rejects unknown provider types before invoking a factory', async () => {
    await expect(createConfiguredProvider({
      ...account,
      providerType: 'unknown-provider',
    })).rejects.toThrow(/unknown provider type/);
  });

  it('rejects malformed routes and out-of-bounds catalog metadata before creating a provider', async () => {
    await expect(createConfiguredProvider({
      ...account,
      models: [{ modelId: 'chat', wireModelId: '', apiMode: 'chat-completions' }],
    })).rejects.toThrow(/provider wireModelId/);

    await expect(createConfiguredProvider({
      ...accountWithCatalogMetadata,
      catalogProvider: {
        ...accountWithCatalogMetadata.catalogProvider!,
        models: [{
          ...accountWithCatalogMetadata.catalogProvider!.models[0],
          limit: { output: -1 },
        }],
      },
    })).rejects.toThrow(/non-negative safe integer/);
  });
});
