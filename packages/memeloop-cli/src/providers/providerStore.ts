/**
 * providerStore.ts — CRUD operations for provider configuration.
 * providerStore.ts — Provider 配置的 CRUD 操作。
 *
 * Reads/writes memeloop-cli.yaml for provider entries and auth.yaml for API keys.
 * 读写 memeloop-cli.yaml 中的 provider 条目和 auth.yaml 中的 API keys。
 */
import { getApiKey, setApiKey } from '../auth/authStore.js';
import { loadRawConfig, saveConfig } from '../config.js';
import type { ProviderEntry, ProviderModelEntry } from '../config.js';

/** Full provider view including API key status. / 完整 provider 视图，含 API key 状态。 */
export interface ProviderInfo {
  name: string;
  baseUrl?: string;
  hasApiKey: boolean;
  apiKeyMasked?: string;
  models: Record<string, ProviderModelEntry>;
}

/** List all configured providers with key status. / 列出所有已配置的 provider 及 key 状态。 */
export function listProviders(): ProviderInfo[] {
  const config = loadRawConfig();

  return (config.providers ?? []).map((p) => {
    const key = getApiKey(p.name);
    const hasApiKey = typeof key === 'string' && key.length > 0;
    const masked = hasApiKey ? key.slice(0, 6) + '...' + key.slice(-4) : undefined;
    return {
      name: p.name,
      baseUrl: p.baseUrl ?? (p.options?.baseURL as string | undefined),
      hasApiKey,
      apiKeyMasked: masked,
      models: p.models ?? {},
    };
  });
}

/** Add a new provider with API key. / 添加新的 provider 及 API key。 */
export function addProvider(name: string, baseUrl: string, apiKey: string, models?: Record<string, ProviderModelEntry>): void {
  const config = loadRawConfig();

  // Ensure no duplicate name
  const existing = (config.providers ?? []).find((p) => p.name === name);
  if (existing) {
    // Update existing
    existing.baseUrl = baseUrl;
    if (models) existing.models = { ...existing.models, ...models };
  } else {
    const entry: ProviderEntry = { name, baseUrl, models: models ?? {} };
    config.providers = [...(config.providers ?? []), entry];
  }

  // Determine options.baseURL for Vercel AI SDK compatibility
  if (baseUrl) {
    const entry = (config.providers ?? []).find((p) => p.name === name)!;
    entry.options = { ...entry.options, baseURL: baseUrl };
  }

  saveConfig(config);
  setApiKey(name, apiKey);
}

/** Remove a provider by name. / 按名称删除 provider。 */
export function removeProvider(name: string): boolean {
  const config = loadRawConfig();
  const index = (config.providers ?? []).findIndex((p) => p.name === name);
  if (index === -1) return false;

  config.providers = [...(config.providers ?? [])];
  config.providers.splice(index, 1);
  saveConfig(config);
  return true;
}

/** Update a provider's non-key fields. / 更新 provider 的非 key 字段。 */
export function updateProvider(name: string, updates: { name?: string; baseUrl?: string; models?: Record<string, ProviderModelEntry> }): boolean {
  const config = loadRawConfig();
  const entry = (config.providers ?? []).find((p) => p.name === name);
  if (!entry) return false;

  if (updates.name) entry.name = updates.name;
  if (updates.baseUrl) {
    entry.baseUrl = updates.baseUrl;
    entry.options = { ...entry.options, baseURL: updates.baseUrl };
  }
  if (updates.models) entry.models = { ...entry.models, ...updates.models };

  saveConfig(config);
  return true;
}

/** Export all providers as JSON (with optional key masking). / 导出所有 provider 为 JSON（可选脱敏）。 */
export function exportProviders(maskKeys: boolean): string {
  const info = listProviders();
  const exportData = info.map((p) => ({
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: maskKeys ? undefined : getApiKey(p.name),
    models: p.models,
  }));
  return JSON.stringify({ providers: exportData, exportedAt: new Date().toISOString() }, null, 2);
}

/** Import providers from JSON. / 从 JSON 导入 provider。 */
export function importProviders(json: string): { added: number; skipped: number } {
  let data: { providers?: Array<{ name: string; baseUrl?: string; apiKey?: string; models?: Record<string, ProviderModelEntry> }> };
  try {
    data = JSON.parse(json) as { providers?: Array<{ name: string; baseUrl?: string; apiKey?: string; models?: Record<string, ProviderModelEntry> }> };
  } catch {
    throw new Error('Invalid JSON — cannot parse import data. / 无效的 JSON — 无法解析导入数据。');
  }

  if (!data.providers || !Array.isArray(data.providers)) {
    throw new Error('Invalid format — expected { providers: [...] }. / 无效的格式 — 需要 { providers: [...] }。');
  }

  let added = 0;
  let skipped = 0;

  for (const p of data.providers) {
    if (!p.name) {
      skipped++;
      continue;
    }
    if (p.apiKey) {
      addProvider(p.name, p.baseUrl ?? '', p.apiKey, p.models);
      added++;
    } else {
      // Add without key
      const config = loadRawConfig();
      const existing = (config.providers ?? []).find((entry) => entry.name === p.name);
      if (!existing) {
        config.providers = [...(config.providers ?? []), { name: p.name, baseUrl: p.baseUrl, models: p.models ?? {} }];
        saveConfig(config);
        added++;
      } else {
        skipped++;
      }
    }
  }

  return { added, skipped };
}
