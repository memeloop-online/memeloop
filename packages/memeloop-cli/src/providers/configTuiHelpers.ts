import { assertProviderId, type ModelCatalogProvider, type ProviderAccountConfig, type ProviderModelRoute } from 'memeloop';

import type { PresetProvider } from './presets.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function maskKey(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 3)}***`;
  return `${key.slice(0, 6)}***${key.slice(-4)}`;
}

export function base64Encode(value: string): string {
  return Buffer.from(value).toString('base64');
}

export function base64Decode(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

/** Trim and NFC-normalize a user-entered ID before applying the shared grammar. */
export function normalizeProviderId(value: string): string {
  const providerId = value.normalize('NFC').trim();
  assertProviderId(providerId, 'providerId');
  return providerId;
}

export function accountFromForm(
  providerIdInput: string,
  baseUrl: string,
  models: readonly ProviderModelRoute[],
  catalogProvider?: ModelCatalogProvider,
): ProviderAccountConfig {
  const providerId = normalizeProviderId(providerIdInput);
  const knownProviderTypes = new Set([
    'openai',
    'anthropic',
    'google',
    'deepseek',
    'groq',
    'mistral',
    'cohere',
    'xai',
    'togetherai',
    'perplexity',
    'azure',
    'google-vertex',
    'ollama',
  ]);
  const providerType = knownProviderTypes.has(providerId) ? providerId : 'openai-compatible';
  return {
    providerId,
    providerType,
    ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    models: models.length > 0
      ? models
      : [{ modelId: 'default', wireModelId: 'default', apiMode: 'chat-completions' }],
    ...(catalogProvider === undefined ? {} : { catalogProvider }),
  };
}

export function presetAccount(preset: PresetProvider): ProviderAccountConfig {
  return accountFromForm(
    preset.providerId,
    preset.baseUrl,
    preset.models.map(model => ({
      modelId: model.id,
      wireModelId: model.id,
      apiMode: 'chat-completions' as const,
    })),
    {
      id: preset.providerId,
      name: preset.name,
      ...(preset.npm === undefined ? {} : { npm: preset.npm }),
      env: [],
      models: preset.models.map(model => ({
        id: model.id,
        name: model.name,
        attachment: false,
        reasoning: false,
        toolCall: false,
        limit: { context: model.context, output: model.output },
      })),
    },
  );
}
