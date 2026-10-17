/** Provider account CRUD and portable secret-aware export/import. */

import { normalizeProviderAccountConfig, type ProviderAccountConfig } from 'memeloop';

import { getApiKey, setApiKey } from '../auth/authStore.js';
import { loadRawConfig, saveConfig } from '../config.js';

const SECRET_REF_PREFIX = 'provider-config/';

/** UI projection of the canonical account; no parallel provider DTO is kept. */
export type ProviderInfo = Readonly<ProviderAccountConfig> & {
  hasApiKey: boolean;
  apiKeyMasked?: string;
};

function defaultSecretReference(providerId: string): string {
  return `${SECRET_REF_PREFIX}${providerId}/api-key`;
}

function maskSecret(value: string): string {
  return value.length <= 10
    ? `${value.slice(0, 3)}***`
    : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function providerAccounts(): ProviderAccountConfig[] {
  return [...(loadRawConfig().providers ?? [])];
}

function withSecretReference(account: ProviderAccountConfig, apiKey?: string): ProviderAccountConfig {
  if (apiKey === undefined) return account;
  const secretReference = account.secretRef ?? defaultSecretReference(account.providerId);
  setApiKey(secretReference, apiKey);
  return normalizeProviderAccountConfig({ ...account, secretRef: secretReference });
}

/** List canonical accounts with non-sensitive credential status. */
export function listProviders(): ProviderInfo[] {
  return providerAccounts().map(account => {
    const key = account.secretRef === undefined ? undefined : getApiKey(account.secretRef);
    return {
      ...account,
      hasApiKey: typeof key === 'string' && key.length > 0,
      ...(typeof key === 'string' && key.length > 0 ? { apiKeyMasked: maskSecret(key) } : {}),
    };
  });
}

/** Add or replace one canonical provider account and optionally store a key. */
export function addProvider(account: ProviderAccountConfig, apiKey?: string): void {
  const next = withSecretReference(normalizeProviderAccountConfig(account), apiKey);
  const accounts = providerAccounts();
  const index = accounts.findIndex(candidate => candidate.providerId === next.providerId);
  if (index === -1) accounts.push(next);
  else accounts[index] = next;
  saveConfig({ ...loadRawConfig(), providers: accounts });
}

export function removeProvider(providerId: string): boolean {
  const config = loadRawConfig();
  const accounts = [...(config.providers ?? [])];
  const index = accounts.findIndex(account => account.providerId === providerId);
  if (index === -1) return false;
  accounts.splice(index, 1);
  saveConfig({ ...config, providers: accounts });
  return true;
}

/** Update canonical account fields. Provider identity is immutable. */
export function updateProvider(
  providerId: string,
  updates: Partial<Pick<ProviderAccountConfig, 'providerType' | 'baseUrl' | 'secretRef' | 'enabled' | 'models' | 'catalogProvider'>>,
  apiKey?: string,
): boolean {
  const config = loadRawConfig();
  const accounts = [...(config.providers ?? [])];
  const index = accounts.findIndex(account => account.providerId === providerId);
  if (index === -1) return false;
  const current = accounts[index];
  if (current === undefined) return false;
  const merged = normalizeProviderAccountConfig({ ...current, ...updates, providerId });
  accounts[index] = withSecretReference(merged, apiKey);
  saveConfig({ ...config, providers: accounts });
  return true;
}

export interface ProviderExportOptions {
  /** Include raw API keys only when explicitly requested. Defaults to false. */
  includeSecrets?: boolean;
}

export interface ProviderImportResult {
  added: number;
  skipped: number;
  missingSecrets: string[];
}

/**
 * Export canonical accounts. By default this is portable and credential-free:
 * it carries only secretRef plus explicit missing/available status metadata.
 */
export function exportProviders(options: ProviderExportOptions = {}): string {
  const includeSecrets = options.includeSecrets === true;
  const providers = providerAccounts().map(account => {
    const key = account.secretRef === undefined ? undefined : getApiKey(account.secretRef);
    return {
      ...account,
      secretStatus: key ? 'available' as const : 'missing' as const,
      ...(includeSecrets && key ? { apiKey: key } : {}),
    };
  });
  return JSON.stringify({ providers, exportedAt: new Date().toISOString() }, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Import only strict canonical account records; malformed entries fail closed. */
export function importProviders(json: string): ProviderImportResult {
  let data: unknown;
  try {
    data = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error('Invalid JSON — cannot parse import data. / 无效的 JSON — 无法解析导入数据。', { cause: error });
  }
  if (!isRecord(data) || !Array.isArray(data.providers)) {
    throw new Error('Invalid format — expected { providers: [...] }. / 无效的格式 — 需要 { providers: [...] }。');
  }

  const config = loadRawConfig();
  const accounts = [...(config.providers ?? [])];
  const missingSecrets: string[] = [];
  for (const [index, raw] of data.providers.entries()) {
    if (!isRecord(raw)) throw new TypeError(`providers[${index}] must be an object`);
    const candidate = { ...raw };
    const secretStatus = candidate.secretStatus;
    delete candidate.secretStatus;
    const apiKey = candidate.apiKey;
    delete candidate.apiKey;
    if (secretStatus !== undefined && secretStatus !== 'available' && secretStatus !== 'missing') {
      throw new TypeError(`providers[${index}].secretStatus is invalid`);
    }
    if (apiKey !== undefined && typeof apiKey !== 'string') {
      throw new TypeError(`providers[${index}].apiKey must be a string`);
    }
    const account = normalizeProviderAccountConfig(candidate);
    const normalized = withSecretReference(account, typeof apiKey === 'string' ? apiKey : undefined);
    const existingIndex = accounts.findIndex(item => item.providerId === normalized.providerId);
    if (existingIndex === -1) accounts.push(normalized);
    else accounts[existingIndex] = normalized;
    const hasKey = normalized.secretRef !== undefined && Boolean(
      typeof apiKey === 'string' ? apiKey : getApiKey(normalized.secretRef),
    );
    if (!hasKey && normalized.secretRef !== undefined) missingSecrets.push(normalized.providerId);
  }
  saveConfig({ ...config, providers: accounts });
  return { added: data.providers.length, skipped: 0, missingSecrets };
}
