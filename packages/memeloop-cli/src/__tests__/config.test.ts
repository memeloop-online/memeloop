import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getAuthPath, setInputSecret } from '../auth/authStore.js';
import { getCloudAccessTokenSecretId, getDefaultConfigPath, loadConfig, normalizeAgentDefinition, saveConfig } from '../config.js';

describe('config', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('returns default config path under cwd', () => {
    const p = getDefaultConfigPath('/tmp/abc');
    expect(p).toBe(path.join('/tmp/abc', 'memeloop-cli.yaml'));
  });

  it('loads empty config when file does not exist', () => {
    const p = path.join(os.tmpdir(), `missing-${Date.now()}.yaml`);
    expect(loadConfig(p)).toEqual({});
  });

  it('saves and loads yaml config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-config-'));
    tmpDirs.push(dir);
    const p = path.join(dir, 'memeloop-cli.yaml');
    const data = {
      name: 'node-a',
      cloudUrl: 'https://cloud.example.com',
      providers: [{
        providerId: 'x',
        providerType: 'openai',
        baseUrl: 'https://api.example.com',
        models: [{ modelId: 'default', wireModelId: 'default', apiMode: 'chat-completions' }],
      }],
    };
    saveConfig(data, p);
    const loaded = loadConfig(p);
    expect(loaded.name).toBe('node-a');
    expect(loaded.cloudUrl).toBe('https://cloud.example.com');
    if (process.platform !== 'win32') {
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  it('returns empty config when yaml root is not object', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-config-'));
    tmpDirs.push(dir);
    const p = path.join(dir, 'memeloop-cli.yaml');
    fs.writeFileSync(p, '- a\n- b\n', 'utf8');
    expect(loadConfig(p)).toEqual({});
  });

  it('normalizes agent definition defaults', () => {
    const normalized = normalizeAgentDefinition({ id: 'agent-x' });
    expect(normalized).toEqual({
      id: 'agent-x',
      name: 'agent-x',
      description: '',
      systemPrompt: '',
      tools: [],
      modelConfig: undefined,
      promptSchema: undefined,
      agentFrameworkConfig: undefined,
      version: '1',
    });
  });

  it('rejects inline provider apiKey instead of silently migrating secrets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-config-'));
    tmpDirs.push(dir);
    const p = path.join(dir, 'memeloop-cli.yaml');
    fs.writeFileSync(
      p,
      [
        'providers:',
        '  - providerId: env-provider',
        '    providerType: openai',
        '    baseUrl: https://api.example.com',
        '    apiKey: should-not-be-inline',
        '    models:',
        '      - modelId: default',
        '        wireModelId: default',
        '        apiMode: chat-completions',
      ].join('\n'),
      'utf8',
    );

    expect(() => loadConfig(p)).toThrow(/removed field 'apiKey'/);
  });

  it('rejects legacy provider name/map fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-config-'));
    tmpDirs.push(dir);
    const p = path.join(dir, 'memeloop-cli.yaml');
    fs.writeFileSync(
      p,
      [
        'providers:',
        '  - name: legacy-provider',
        '    baseUrl: https://api.example.com',
        '    models: {}',
      ].join('\n'),
      'utf8',
    );

    expect(() => loadConfig(p)).toThrow(/removed field 'name'/);
  });

  it('binds a stored Cloud token to its configured origin', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-config-'));
    tmpDirs.push(dir);
    const p = path.join(dir, 'memeloop-cli.yaml');
    const trustedOrigin = 'https://cloud.example.com';
    const secretId = getCloudAccessTokenSecretId(trustedOrigin);
    const authPath = getAuthPath();
    const hadAuth = fs.existsSync(authPath);
    const prevRaw = hadAuth ? fs.readFileSync(authPath, 'utf8') : '';
    const previousMode = hadAuth ? fs.statSync(authPath).mode & 0o777 : undefined;
    try {
      setInputSecret(secretId, 'cloud-secret');
      fs.writeFileSync(
        p,
        `cloudUrl: https://attacker.example.com\ncloudAccessToken: \${input:${secretId}}\n`,
        'utf8',
      );
      expect(loadConfig(p).cloudAccessToken).toBe('');

      fs.writeFileSync(
        p,
        `cloudUrl: ${trustedOrigin}\ncloudAccessToken: \${input:${secretId}}\n`,
        'utf8',
      );
      expect(loadConfig(p).cloudAccessToken).toBe('cloud-secret');
    } finally {
      if (hadAuth) {
        fs.mkdirSync(path.dirname(authPath), { recursive: true });
        fs.writeFileSync(authPath, prevRaw, 'utf8');
        if (previousMode !== undefined) fs.chmodSync(authPath, previousMode);
      } else if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { force: true });
      }
    }
  });
});
