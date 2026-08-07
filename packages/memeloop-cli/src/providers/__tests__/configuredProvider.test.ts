import { describe, expect, it } from 'vitest';

import type { ProviderEntry } from '../../config.js';
import { applyConfiguredModelDefaults, createConfiguredProvider, resolveConfiguredModels, resolveConfiguredProviderModelId } from '../configuredProvider.js';

const cpaProvider: ProviderEntry = {
  name: 'cpa',
  baseUrl: 'https://cpa.example.test/v1',
  apiKey: 'test-only',
  models: [
    {
      id: 'westlake/deepseek',
      name: 'DeepSeek V4 Flash',
      apiMode: 'chat-completions',
      toolCalling: true,
      thinking: true,
      vision: false,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 32_768,
      modelOptions: { top_p: 0.9 },
      supportsReasoningEffort: ['minimal', 'low', 'medium', 'high'],
      reasoningEffortFormat: 'chat-completions',
    },
    {
      id: 'kimi-k3-256k',
      name: 'Kimi K3 256K',
      apiMode: 'chat-completions',
      limit: { context: 262_144, output: 131_072 },
      modelOptions: { top_p: 0.95 },
      toolCalling: true,
      vision: true,
      thinking: true,
    },
    {
      id: 'gpt-5.6-luna',
      name: 'GPT-5.6 Luna',
      apiMode: 'responses',
      maxInputTokens: 1_050_000,
      maxOutputTokens: 128_000,
      reasoningEffort: 'medium',
      toolCalling: true,
      vision: true,
      thinking: true,
    },
    {
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      openAIApiMode: 'responses',
      maxInputTokens: 1_050_000,
      maxOutputTokens: 128_000,
      toolCalling: true,
      vision: true,
      thinking: true,
    },
  ],
};

describe('configured CLI providers', () => {
  it('normalizes the rich model array and retains scheduling metadata', () => {
    const models = resolveConfiguredModels(cpaProvider);
    expect(models.map(model => [model.id, model.apiMode])).toEqual([
      ['westlake/deepseek', 'chat-completions'],
      ['kimi-k3-256k', 'chat-completions'],
      ['gpt-5.6-luna', 'responses'],
      ['gpt-5.6-sol', 'responses'],
    ]);
    expect(models[0]?.model).toMatchObject({
      name: 'DeepSeek V4 Flash',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 32_768,
      supportsReasoningEffort: ['minimal', 'low', 'medium', 'high'],
      toolCalling: true,
      vision: false,
    });
    expect(resolveConfiguredProviderModelId(cpaProvider)).toBe('cpa/westlake/deepseek');
    expect(models.map(model => model.modelName)).toEqual([
      'westlake/deepseek',
      'kimi-k3-256k',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
    ]);
  });

  it('strictly dispatches Luna/Sol to Responses and DeepSeek/Kimi to Chat Completions', async () => {
    const provider = await createConfiguredProvider(cpaProvider);
    const createModel = provider.model as (modelId: string) => { provider?: unknown };

    expect(createModel('gpt-5.6-luna').provider).toBe('openai.responses');
    expect(createModel('gpt-5.6-sol').provider).toBe('openai.responses');
    expect(createModel('westlake/deepseek').provider).toBe('cpa.chat');
    expect(createModel('kimi-k3-256k').provider).toBe('cpa.chat');
  });

  it('applies limit/top_p/reasoning defaults but preserves explicit call settings', () => {
    expect(applyConfiguredModelDefaults(cpaProvider, { model: 'kimi-k3-256k' })).toMatchObject({
      model: 'kimi-k3-256k',
      maxOutputTokens: 131_072,
      topP: 0.95,
    });
    expect(applyConfiguredModelDefaults(cpaProvider, { model: 'gpt-5.6-luna' })).toMatchObject({
      model: 'gpt-5.6-luna',
      maxOutputTokens: 128_000,
      providerOptions: { openai: { reasoningEffort: 'medium' } },
    });
    expect(applyConfiguredModelDefaults(cpaProvider, {
      model: 'kimi-k3-256k',
      maxOutputTokens: 2048,
      topP: 0.5,
    })).toMatchObject({
      maxOutputTokens: 2048,
      topP: 0.5,
    });
  });

  it('rejects ambiguous API modes and invalid generation bounds', () => {
    expect(() =>
      resolveConfiguredModels({
        name: 'bad',
        models: [{
          id: 'bad-model',
          name: 'bad-model',
          apiMode: 'responses',
          openAIApiMode: 'chat-completions',
        }],
      })
    ).toThrow(/conflicting apiMode/);
    expect(() =>
      resolveConfiguredModels({
        name: 'bad',
        models: [{ id: 'bad-model', name: 'bad-model', maxOutputTokens: 0 }],
      })
    ).toThrow(/positive safe integer/);
  });

  it('keeps the existing simple model map valid', () => {
    expect(resolveConfiguredModels({
      name: 'legacy-compatible',
      models: { primary: { name: 'legacy-model', limit: { context: 8192 } } },
    })).toMatchObject([{
      id: 'primary',
      modelName: 'legacy-model',
      apiMode: 'chat-completions',
    }]);
  });
});
