import { describe, expect, it } from 'vitest';

import { createLLMProvider, createProviderFromEntry, type LLMProviderId } from '../../llm-providers.js';
import { createFetchLLMProvider } from '../fetchProvider.js';

const providerCases: Array<{
  id: LLMProviderId;
  options?: Record<string, unknown>;
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
  { id: 'azure', options: { resourceName: 'acceptance' } },
  {
    id: 'google-vertex',
    options: { project: 'acceptance', location: 'us-central1' },
  },
  { id: 'ollama' },
];

describe('AI SDK 7 provider compatibility', () => {
  it.each(providerCases)('constructs a current LanguageModel for $id', async ({ id, options }) => {
    const provider = await createLLMProvider({
      provider: id,
      apiKey: 'acceptance-key',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'acceptance-model',
      options,
    });
    const createModel = provider.model as (modelId?: string) => {
      specificationVersion?: unknown;
    };

    expect(['v2', 'v3', 'v4']).toContain(createModel('acceptance-model').specificationVersion);
  });

  it('constructs a current LanguageModel for arbitrary OpenAI-compatible endpoints', async () => {
    const provider = await createProviderFromEntry({
      name: 'private-compatible-endpoint',
      apiKey: 'acceptance-key',
      baseUrl: 'http://127.0.0.1:1/v1',
      models: {
        primary: { name: 'acceptance-model' },
      },
    });
    const createModel = provider.model as (modelId?: string) => {
      specificationVersion?: unknown;
    };

    expect(['v2', 'v3', 'v4']).toContain(createModel().specificationVersion);
  });

  it('fails before transport when an embedding host supplies an incompatible model', async () => {
    const provider = createFetchLLMProvider({
      name: 'incompatible-provider',
      createModel: () =>
        ({
          specificationVersion: 'v1',
        }) as never,
    });

    await expect(
      provider.chat({
        messages: [{ role: 'user', content: 'must not reach transport' }],
        stream: false,
      }),
    ).rejects.toThrow(/expected specificationVersion v2, v3, or v4; received v1/);
  });
});
