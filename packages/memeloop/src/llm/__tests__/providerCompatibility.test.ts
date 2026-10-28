import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLLMProviderFromAccount, createLLMProviderFromAccountRoute, type LLMProviderId } from '../../llm-providers.js';
import { createFetchLLMProvider, resolveFetchLLMCallSettings } from '../fetchProvider.js';
import type { ProviderAccountConfig } from '../providerAccount.js';

const providerCases: Array<{
  id: LLMProviderId;
}> = [
  { id: 'openai' },
  { id: 'anthropic' },
  { id: 'google' },
  { id: 'deepseek' },
  { id: 'groq' },
  { id: 'mistral' },
  { id: 'cohere' },
  { id: 'xai' },
  { id: 'togetherai' },
  { id: 'perplexity' },
  { id: 'azure' },
  { id: 'google-vertex' },
  { id: 'ollama' },
];

describe('AI SDK 7 provider compatibility', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(providerCases)('constructs a current LanguageModel for $id', async ({ id }) => {
    if (id === 'google-vertex') {
      vi.stubEnv('GOOGLE_VERTEX_LOCATION', 'us-central1');
      vi.stubEnv('GOOGLE_VERTEX_PROJECT', 'acceptance');
    }
    const provider = await createLLMProviderFromAccount({
      providerId: `compat-${id}`,
      providerType: id,
      baseUrl: 'http://127.0.0.1:1/v1',
      models: [{ modelId: 'acceptance-model', wireModelId: 'acceptance-model', apiMode: 'chat-completions' }],
    }, { apiKey: 'acceptance-key' });
    const createModel = provider.model as (modelId?: string) => {
      specificationVersion?: unknown;
    };

    expect(['v2', 'v3', 'v4']).toContain(createModel('acceptance-model').specificationVersion);
  });

  it('binds two routes from one compatible account to distinct wire APIs and model ids', async () => {
    const account: ProviderAccountConfig = {
      providerId: 'private-compatible-endpoint',
      providerType: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      models: [
        {
          modelId: 'logical-chat',
          wireModelId: 'vendor/chat-model',
          apiMode: 'chat-completions',
        },
        {
          modelId: 'logical-reasoning',
          wireModelId: 'vendor/responses-model',
          apiMode: 'responses',
        },
      ],
    };
    const provider = await createLLMProviderFromAccount(account, {
      apiKey: 'acceptance-key',
    });
    const chatModel = (provider.model as (modelId: string) => {
      modelId?: unknown;
      provider?: unknown;
    })('logical-chat');
    const responsesModel = (provider.model as (modelId: string) => {
      modelId?: unknown;
      provider?: unknown;
    })('logical-reasoning');

    expect(provider).toMatchObject({
      name: account.providerId,
      modelId: 'logical-chat',
    });
    expect(chatModel).toMatchObject({
      modelId: 'vendor/chat-model',
      provider: 'private-compatible-endpoint.chat',
    });
    expect(responsesModel).toMatchObject({
      modelId: 'vendor/responses-model',
      provider: 'openai.responses',
    });

    expect(() =>
      provider.chat({
        providerId: account.providerId,
        logicalModelId: 'logical-reasoning',
        wireModelId: 'logical-reasoning',
        apiMode: 'responses',
        messages: [],
      })
    ).toThrow(/request route does not match configured model/);
  });

  it.each(['chat-completions', 'responses'] as const)(
    'fails closed for an OpenAI-compatible %s route without baseUrl',
    async apiMode => {
      let secretResolved = false;
      const account: ProviderAccountConfig = {
        providerId: 'custom-account',
        providerType: 'openai-compatible',
        secretRef: 'provider.custom-account.apiKey',
        models: [{ modelId: 'logical', wireModelId: 'wire', apiMode }],
      };

      await expect(createLLMProviderFromAccount(account, {
        resolveSecret: () => {
          secretResolved = true;
          return 'must-not-be-sent-to-openai';
        },
      })).rejects.toThrow(/requires an explicit baseUrl/);
      expect(secretResolved).toBe(false);
    },
  );

  it('allows only the known OpenAI provider type to use its official default URL', async () => {
    const account: ProviderAccountConfig = {
      providerId: 'official-openai',
      providerType: 'openai',
      models: [{
        modelId: 'logical',
        wireModelId: 'gpt-5.6-luna',
        apiMode: 'responses',
      }],
    };

    const provider = await createLLMProviderFromAccount(account, {
      apiKey: 'acceptance-key',
    });
    expect((provider.model as () => { provider?: unknown })()).toMatchObject({
      provider: 'openai.responses',
    });
  });

  it('rejects a route that is not an exact account member', async () => {
    const account: ProviderAccountConfig = {
      providerId: 'private-compatible-endpoint',
      providerType: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      models: [{
        modelId: 'logical-model',
        wireModelId: 'vendor/model-v1',
        apiMode: 'chat-completions',
      }],
    };

    await expect(createLLMProviderFromAccountRoute({
      account,
      route: {
        modelId: 'logical-model',
        wireModelId: 'vendor/model-v2',
        apiMode: 'chat-completions',
      },
    })).rejects.toThrow(/not an exact member/);
  });

  it.each(
    [
      ['chat-completions', 'openai.chat'],
      ['responses', 'openai.responses'],
    ] as const,
  )('selects the %s OpenAI wire API from its canonical route', async (apiMode, expectedProvider) => {
    const provider = await createLLMProviderFromAccount({
      providerId: 'official-openai-routing',
      providerType: 'openai',
      baseUrl: 'http://127.0.0.1:1/v1',
      models: [{ modelId: 'acceptance-model', wireModelId: 'acceptance-model', apiMode }],
    }, { apiKey: 'acceptance-key' });
    const createModel = provider.model as (modelId?: string) => { provider?: unknown };

    expect(createModel('acceptance-model').provider).toBe(expectedProvider);
  });

  it('fails before transport when an embedding host supplies an incompatible model', async () => {
    const provider = createFetchLLMProvider({
      name: 'incompatible-provider',
      apiMode: 'chat-completions',
      createModel: () =>
        ({
          specificationVersion: 'v1',
        }) as never,
    });

    await expect(
      provider.chat({
        providerId: 'incompatible-provider',
        logicalModelId: 'acceptance-model',
        wireModelId: 'acceptance-model',
        apiMode: 'chat-completions',
        messages: [{ role: 'user', content: 'must not reach transport' }],
        stream: false,
      }),
    ).rejects.toThrow(/expected specificationVersion v2, v3, or v4; received "v1"/);
  });

  it('maps host request settings to AI SDK settings with explicit values taking precedence', () => {
    const providerOptions = { openai: { reasoningEffort: 'high' } };
    expect(resolveFetchLLMCallSettings({
      providerId: 'openai',
      logicalModelId: 'gpt-5.4',
      wireModelId: 'gpt-5.4',
      apiMode: 'responses',
      messages: [],
      maxOutputTokens: 2048,
      temperature: 0.2,
      topP: 0.95,
      providerOptions,
    })).toMatchObject({
      maxOutputTokens: 2048,
      temperature: 0.2,
      topP: 0.95,
      providerOptions,
    });
  });
});
