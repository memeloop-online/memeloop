import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getAuthPath, loadAuth, saveAuth, setInputSecret } from '../auth/authStore';
import { getCloudAccessTokenSecretId, getDefaultConfigPath, loadConfig, loadRawConfig, normalizeAgentDefinition, saveConfig } from '../config';

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
      providers: [{ name: 'x', baseUrl: 'https://api.example.com' }],
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

  it('resolves ${env:...} interpolation for provider apiKey', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-config-'));
    tmpDirs.push(dir);
    const p = path.join(dir, 'memeloop-cli.yaml');
    process.env.MEMELOOP_TEST_API_KEY = 'env-secret-key';
    fs.writeFileSync(
      p,
      [
        'providers:',
        '  - name: env-provider',
        '    baseUrl: https://api.example.com',
        '    apiKey: ${env:MEMELOOP_TEST_API_KEY}',
      ].join('\n'),
      'utf8',
    );

    const loaded = loadConfig(p);
    expect(loaded.providers?.[0]?.apiKey).toBe('env-secret-key');

    const raw = loadRawConfig(p);
    raw.cloudUrl = 'https://cloud.example.com';
    saveConfig(raw, p);
    const saved = fs.readFileSync(p, 'utf8');
    expect(saved).toContain('${env:MEMELOOP_TEST_API_KEY}');
    expect(saved).not.toContain('env-secret-key');
  });

  it('resolves ${input:chat.lm.secret.*} interpolation via auth store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-config-'));
    tmpDirs.push(dir);
    const p = path.join(dir, 'memeloop-cli.yaml');
    const secretId = 'chat.lm.secret.test-config';
    const secretValue = 'sk-test-secret';

    // Backup existing auth store and restore after test.
    const authPath = getAuthPath();
    const hadAuth = fs.existsSync(authPath);
    const prevRaw = hadAuth ? fs.readFileSync(authPath, 'utf8') : '';
    const previousMode = hadAuth ? fs.statSync(authPath).mode & 0o777 : undefined;
    try {
      const auth = loadAuth();
      auth[secretId] = { type: 'api', key: secretValue };
      saveAuth(auth);
      if (process.platform !== 'win32') {
        fs.chmodSync(authPath, 0o644);
        saveAuth(auth);
        expect(fs.statSync(authPath).mode & 0o777).toBe(0o600);
      }

      fs.writeFileSync(
        p,
        [
          'providers:',
          '  - name: input-provider',
          '    baseUrl: https://api.example.com',
          `    apiKey: \${input:${secretId}}`,
        ].join('\n'),
        'utf8',
      );

      const loaded = loadConfig(p);
      expect(loaded.providers?.[0]?.apiKey).toBe(secretValue);
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
