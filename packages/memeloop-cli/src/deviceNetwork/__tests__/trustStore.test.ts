import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DeviceCloudCommitFence, TrustedDeviceRecord } from 'memeloop';
import { afterEach, describe, expect, it } from 'vitest';

import { FileDeviceTrustStore as PublicFileDeviceTrustStore, getDefaultDeviceTrustStorePath } from '../../index.js';
import type { CliCloudDirectorySnapshotTrustStore } from '../../index.js';
import { FileDeviceTrustStore } from '../trustStore.js';

const temporaryDirectories: string[] = [];

function fence(current: () => boolean, generation = 1): DeviceCloudCommitFence {
  const signal = new AbortController().signal;
  return {
    generation,
    signal,
    isCurrent: current,
    throwIfStale: () => {
      if (!current()) throw new Error('stale generation');
    },
    commitSynchronous: (operation) => {
      if (!current()) return false;
      operation();
      return true;
    },
  };
}

function record(
  peerId: string,
  trustMode: TrustedDeviceRecord['trustMode'],
  accountId?: string,
): TrustedDeviceRecord {
  return {
    peerId,
    publicKeyMultibase: `z-${peerId}`,
    deviceName: peerId,
    platform: 'cli',
    trustMode,
    ...(accountId === undefined ? {} : { accountId }),
    createdAt: 1,
  };
}

describe('FileDeviceTrustStore Cloud snapshot CAS', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('is available from the package public entry with its strict host type', () => {
    const constructor: new(filePath?: string) => CliCloudDirectorySnapshotTrustStore = PublicFileDeviceTrustStore;
    expect(constructor).toBe(FileDeviceTrustStore);
    expect(path.isAbsolute(getDefaultDeviceTrustStorePath())).toBe(true);
  });

  it('persists one fenced snapshot atomically and preserves it across restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cloud-trust-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'trusted-devices.json');
    const store = new FileDeviceTrustStore(filePath);
    await store.saveTrustedDevice(record('local-peer', 'local-pairing'));
    let current = true;

    const committed = store.commitCloudAccountSnapshot(
      [record('cloud-peer', 'cloud-account', 'account-b')],
      fence(() => current),
    );
    current = false;
    const staleCommit = store.commitCloudAccountSnapshot(
      [record('stale-peer', 'cloud-account', 'account-a')],
      fence(() => current, 0),
    );

    expect(committed?.map(value => value.peerId)).toEqual([
      'cloud-peer',
      'local-peer',
    ]);
    expect(staleCommit).toBeUndefined();
    const restarted = new FileDeviceTrustStore(filePath);
    expect((await restarted.loadTrustedDevices()).map(value => value.peerId)).toEqual([
      'cloud-peer',
      'local-peer',
    ]);
  });
});
