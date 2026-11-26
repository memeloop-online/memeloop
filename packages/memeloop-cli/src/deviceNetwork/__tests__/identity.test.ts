import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeviceIdentitySecretStore } from '../identity.js';
import { loadOrCreateDeviceIdentity } from '../identity.js';

const temporaryDirectories: string[] = [];

function temporaryIdentityPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-identity-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'device-identity.json');
}

function memorySecretStore(): DeviceIdentitySecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: async (account) => values.get(account),
    set: async (account, value) => {
      values.set(account, value);
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('CLI device identity storage', () => {
  it('stores a new seed in the OS keyring and keeps only public metadata on disk', async () => {
    const identityPath = temporaryIdentityPath();
    const secretStore = memorySecretStore();

    const created = await loadOrCreateDeviceIdentity(identityPath, 'test-device', {
      secretStore,
    });
    const onDisk = JSON.parse(fs.readFileSync(identityPath, 'utf8')) as Record<string, unknown>;

    expect(created.privateKeyRawSeedBase64Url).toBeTruthy();
    expect(onDisk.privateKeyRawSeedBase64Url).toBeUndefined();
    expect(onDisk.privateKeyRef).toMatch(/^keyring:device-/);
    expect([...secretStore.values.values()]).toEqual([created.privateKeyRawSeedBase64Url]);
    expect(fs.statSync(identityPath).mode & 0o777).toBe(0o600);

    await expect(
      loadOrCreateDeviceIdentity(identityPath, 'ignored-name', { secretStore }),
    ).resolves.toEqual(created);
  });

  it('migrates an existing plaintext identity into the keyring without rotating it', async () => {
    const identityPath = temporaryIdentityPath();
    const warn = vi.fn();
    const original = await loadOrCreateDeviceIdentity(identityPath, 'test-device', {
      secretStore: null,
      warn,
    });
    const secretStore = memorySecretStore();

    const migrated = await loadOrCreateDeviceIdentity(identityPath, 'ignored-name', {
      secretStore,
      warn,
    });
    const onDisk = fs.readFileSync(identityPath, 'utf8');

    expect(migrated.peerId).toBe(original.peerId);
    expect(migrated.privateKeyRawSeedBase64Url).toBe(original.privateKeyRawSeedBase64Url);
    expect(onDisk).not.toContain('privateKeyRawSeedBase64Url');
    expect(secretStore.values.size).toBe(1);
  });

  it('warns once per path when a keyring is unavailable and keeps a 0600 fallback', async () => {
    const identityPath = temporaryIdentityPath();
    const warn = vi.fn();

    const created = await loadOrCreateDeviceIdentity(identityPath, 'test-device', {
      secretStore: null,
      warn,
    });
    await loadOrCreateDeviceIdentity(identityPath, 'test-device', {
      secretStore: null,
      warn,
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('OS keyring unavailable');
    expect(fs.readFileSync(identityPath, 'utf8')).toContain(
      created.privateKeyRawSeedBase64Url,
    );
    expect(fs.statSync(identityPath).mode & 0o777).toBe(0o600);
  });

  it('fails closed instead of rotating an identity whose keyring entry is unavailable', async () => {
    const identityPath = temporaryIdentityPath();
    const secretStore = memorySecretStore();
    const created = await loadOrCreateDeviceIdentity(identityPath, 'test-device', {
      secretStore,
    });
    secretStore.values.clear();

    await expect(
      loadOrCreateDeviceIdentity(identityPath, 'test-device', { secretStore }),
    ).rejects.toThrow('keyring entry is unavailable');
    const onDisk = JSON.parse(fs.readFileSync(identityPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.peerId).toBe(created.peerId);
  });
});
