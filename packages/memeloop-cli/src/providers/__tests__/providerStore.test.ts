/**
 * providerStore.test.ts — Tests for provider CRUD operations.
 *
 * Uses MEMELOOP_DATA_DIR env var to redirect auth.yaml, and creates a
 * memeloop-cli.yaml config in a temp CWD so getDefaultConfigPath works.
 */
import yaml from 'js-yaml';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addProvider, exportProviders, importProviders, listProviders, removeProvider, updateProvider } from '../providerStore.js';

/** Write a minimal config YAML to the given path. */
function writeConfig(filePath: string, providers?: Array<Record<string, unknown>>): void {
  const data: Record<string, unknown> = { name: 'test-node' };
  if (providers) data.providers = providers;
  fs.writeFileSync(filePath, yaml.dump(data), 'utf-8');
}

let tmpDir: string;
let configPath: string;
let authPath: string;

describe('providerStore', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-ps-'));
    configPath = path.join(tmpDir, 'memeloop-cli.yaml');
    authPath = path.join(tmpDir, 'auth.yaml');

    // Empty YAML config and auth
    writeConfig(configPath);
    fs.writeFileSync(authPath, '{}\n', 'utf-8');

    // Redirect data dir and CWD to tmpDir
    process.env.MEMELOOP_DATA_DIR = tmpDir;
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MEMELOOP_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Basic CRUD ───────────────────────────────────────────────────

  it('listProviders returns empty when no providers configured', () => {
    expect(listProviders()).toEqual([]);
  });

  it('addProvider and listProviders', () => {
    addProvider('TestAI', 'https://api.test.com/v1', 'sk-test-key-12345');

    const list = listProviders();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('TestAI');
    expect(list[0].baseUrl).toBe('https://api.test.com/v1');
    expect(list[0].hasApiKey).toBe(true);
    expect(list[0].apiKeyMasked).toContain('...');
  });

  it('addProvider with duplicate name updates existing', () => {
    addProvider('DupAI', 'https://old.example.com', 'key1');
    addProvider('DupAI', 'https://new.example.com', 'key2');

    const list = listProviders();
    expect(list).toHaveLength(1);
    expect(list[0].baseUrl).toBe('https://new.example.com');
  });

  it('removeProvider removes existing', () => {
    addProvider('Removable', 'https://api.r.com', 'rk');
    expect(listProviders()).toHaveLength(1);

    expect(removeProvider('Removable')).toBe(true);
    expect(listProviders()).toHaveLength(0);
  });

  it('removeProvider returns false for non-existing', () => {
    expect(removeProvider('Ghost')).toBe(false);
  });

  it('updateProvider updates fields', () => {
    addProvider('Updatable', 'https://old.example.com', 'uk');
    expect(updateProvider('Updatable', { baseUrl: 'https://new.example.com', name: 'Renamed' })).toBe(true);

    const list = listProviders();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Renamed');
    expect(list[0].baseUrl).toBe('https://new.example.com');
  });

  it('updateProvider returns false for non-existing', () => {
    expect(updateProvider('Ghost', { baseUrl: 'x' })).toBe(false);
  });

  // ── Export / Import ──────────────────────────────────────────────

  it('exportProviders and importProviders roundtrip with keys', () => {
    addProvider('Exporter', 'https://api.e.com', 'ek-abcdefghijklmnop');

    const json = exportProviders(false);
    const parsed = JSON.parse(json);
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0].apiKey).toBe('ek-abcdefghijklmnop');

    removeProvider('Exporter');
    const result = importProviders(json);
    expect(result.added).toBe(1);

    const list = listProviders();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Exporter');
  });

  it('exportProviders can mask keys', () => {
    addProvider('Secretive', 'https://api.s.com', 'sk-secret-123');

    const json = exportProviders(true);
    const parsed = JSON.parse(json);
    expect(parsed.providers[0].apiKey).toBeUndefined();
  });

  it('importProviders handles multiple providers', () => {
    const json = JSON.stringify({
      providers: [
        { name: 'A', baseUrl: 'https://a.com', apiKey: 'ka' },
        { name: 'B', baseUrl: 'https://b.com', apiKey: 'kb' },
      ],
    });

    const result = importProviders(json);
    expect(result.added).toBe(2);
    expect(listProviders()).toHaveLength(2);
  });

  it('importProviders skips entries without name', () => {
    const json = JSON.stringify({
      providers: [
        { name: 'Valid', apiKey: 'kv' },
        { apiKey: 'no-name' },
      ],
    });

    const result = importProviders(json);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('importProviders throws on invalid JSON', () => {
    expect(() => importProviders('not json')).toThrow();
  });

  it('importProviders throws on missing providers array', () => {
    expect(() => importProviders('{}')).toThrow();
  });

  // ── YAML file integrity ──────────────────────────────────────────

  it('persists providers to YAML config file', () => {
    addProvider('YamlAI', 'https://yaml.example.com', 'yk');

    const raw = fs.readFileSync(configPath, 'utf-8');
    const data = yaml.load(raw) as Record<string, unknown>;
    const providers = data.providers as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe('YamlAI');
    expect(providers[0].baseUrl).toBe('https://yaml.example.com');
  });

  it('persists API key to auth.yaml', () => {
    addProvider('AuthYamlAI', 'https://auth.example.com', 'ak-secret');

    const raw = fs.readFileSync(authPath, 'utf-8');
    const data = yaml.load(raw) as Record<string, { type: string; key: string }>;
    expect(data.AuthYamlAI).toBeDefined();
    expect(data.AuthYamlAI.type).toBe('api');
    expect(data.AuthYamlAI.key).toBe('ak-secret');
  });
});
