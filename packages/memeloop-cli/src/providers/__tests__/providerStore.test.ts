import yaml from 'js-yaml';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderAccountConfig } from 'memeloop';
import { getApiKey } from '../../auth/authStore.js';
import { addProvider, exportProviders, importProviders, listProviders, removeProvider, updateProvider } from '../providerStore.js';

function account(providerId: string, baseUrl = `https://${providerId}.example.com`): ProviderAccountConfig {
  return {
    providerId,
    providerType: 'openai-compatible',
    baseUrl,
    secretRef: `provider-config/${providerId}/api-key`,
    models: [{ modelId: 'default', wireModelId: 'default', apiMode: 'chat-completions' }],
  };
}

let tmpDir: string;
let configPath: string;
let authPath: string;

describe('providerStore', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-ps-'));
    configPath = path.join(tmpDir, 'memeloop-cli.yaml');
    authPath = path.join(tmpDir, 'auth.yaml');
    fs.writeFileSync(configPath, yaml.dump({ name: 'test-node' }), 'utf-8');
    fs.writeFileSync(authPath, '{}\n', 'utf-8');
    process.env.MEMELOOP_DATA_DIR = tmpDir;
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MEMELOOP_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists canonical accounts and opaque secret status', () => {
    addProvider(account('test-ai'), 'sk-test-key-12345');
    expect(listProviders()).toMatchObject([{
      providerId: 'test-ai',
      providerType: 'openai-compatible',
      secretRef: 'provider-config/test-ai/api-key',
      hasApiKey: true,
    }]);
    expect(listProviders()[0]).not.toHaveProperty('apiKey');
  });

  it('replaces an existing account by providerId', () => {
    addProvider(account('dup', 'https://old.example.com'), 'key1');
    addProvider(account('dup', 'https://new.example.com'), 'key2');
    expect(listProviders()).toHaveLength(1);
    expect(listProviders()[0]?.baseUrl).toBe('https://new.example.com');
    expect(getApiKey('provider-config/dup/api-key')).toBe('key2');
  });

  it('removes and updates canonical accounts', () => {
    addProvider(account('mutable'), 'key');
    expect(updateProvider('mutable', { baseUrl: 'https://new.example.com' })).toBe(true);
    expect(listProviders()[0]?.baseUrl).toBe('https://new.example.com');
    expect(removeProvider('mutable')).toBe(true);
    expect(listProviders()).toEqual([]);
  });

  it('exports portable secretRef plus explicit missing-secret metadata', () => {
    addProvider(account('portable'), 'secret');
    const parsed = JSON.parse(exportProviders());
    expect(parsed.providers[0]).toMatchObject({
      providerId: 'portable',
      secretRef: 'provider-config/portable/api-key',
      secretStatus: 'available',
    });
    expect(parsed.providers[0]).not.toHaveProperty('apiKey');
    const missing = account('missing');
    addProvider({ ...missing, secretRef: 'provider-config/missing/api-key' });
    const missingParsed = JSON.parse(exportProviders());
    expect(missingParsed.providers.find((item: { providerId: string }) => item.providerId === 'missing')).toMatchObject({ secretStatus: 'missing' });
  });

  it('requires explicit opt-in for sensitive export and round-trips accounts', () => {
    addProvider(account('exporter'), 'ek-secret');
    const sensitive = JSON.parse(exportProviders({ includeSecrets: true }));
    expect(sensitive.providers[0].apiKey).toBe('ek-secret');
    removeProvider('exporter');
    const result = importProviders(JSON.stringify(sensitive));
    expect(result).toEqual({ added: 1, skipped: 0, missingSecrets: [] });
    expect(listProviders()[0]?.providerId).toBe('exporter');
  });

  it('imports missing secrets without silently skipping the account', () => {
    const result = importProviders(JSON.stringify({ providers: [{ ...account('remote'), secretStatus: 'missing' }] }));
    expect(result).toEqual({ added: 1, skipped: 0, missingSecrets: ['remote'] });
    expect(listProviders()[0]).toMatchObject({ providerId: 'remote', hasApiKey: false });
  });

  it('rejects legacy provider DTOs and malformed input', () => {
    expect(() => importProviders(JSON.stringify({ providers: [{ name: 'legacy', models: {} }] }))).toThrow();
    expect(() => importProviders('not json')).toThrow();
    expect(() => importProviders('{}')).toThrow();
  });

  it('persists canonical provider fields and never inline keys', () => {
    addProvider(account('yaml-ai'), 'yk-secret');
    const data = yaml.load(fs.readFileSync(configPath, 'utf-8')) as { providers: Array<Record<string, unknown>> };
    expect(data.providers[0]).toMatchObject({ providerId: 'yaml-ai', providerType: 'openai-compatible' });
    expect(data.providers[0]).not.toHaveProperty('apiKey');
    expect(fs.readFileSync(authPath, 'utf-8')).toContain('yk-secret');
  });
});
