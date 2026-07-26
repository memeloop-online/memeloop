import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentVolumeClaimResource, AgentVolumeResource, StorageClassResource } from 'memeloop';
import { describe, expect, it } from 'vitest';

import { createFileManagedStorageStateStore, createLocalDirectoryStorageDriver, LOCAL_DIRECTORY_STORAGE_DRIVER_NAME } from '../orchestration/localDirectoryStorageDriver.js';

function claim(): AgentVolumeClaimResource {
  return {
    apiVersion: 'storage.memeloop.io/v1alpha1',
    kind: 'AgentVolumeClaim',
    metadata: {
      name: 'data',
      uid: 'claim-uid',
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '',
    },
    spec: {
      storageClassRef: {
        apiVersion: 'storage.memeloop.io/v1alpha1',
        kind: 'StorageClass',
        name: 'local',
      },
      accessMode: 'ReadWriteOnce',
      sizeBytes: 1024,
    },
  };
}

function storageClass(): StorageClassResource {
  return {
    apiVersion: 'storage.memeloop.io/v1alpha1',
    kind: 'StorageClass',
    metadata: {
      name: 'local',
      uid: 'class-uid',
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '',
    },
    spec: { driver: LOCAL_DIRECTORY_STORAGE_DRIVER_NAME },
  };
}

describe('createLocalDirectoryStorageDriver', () => {
  it('persists managed protocol state atomically without using keys as paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-storage-state-'));
    try {
      const first = createFileManagedStorageStateStore(root);
      await first.put('../foreign/path', {
        fence: 7,
        handle: 'storage-stage:opaque',
      });
      await expect(
        createFileManagedStorageStateStore(root).get('../foreign/path'),
      ).resolves.toEqual({
        fence: 7,
        handle: 'storage-stage:opaque',
      });
      expect(fs.readdirSync(root)).toHaveLength(1);
      await first.delete('../foreign/path');
      await expect(first.get('../foreign/path')).resolves.toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('provisions and publishes idempotently without exposing caller-controlled paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-local-volume-'));
    const driver = createLocalDirectoryStorageDriver({
      rootDirectory: root,
      nodeId: 'node-a',
    });
    try {
      const first = await driver.provision({ claim: claim(), storageClass: storageClass() });
      const retried = await driver.provision({ claim: claim(), storageClass: storageClass() });
      expect(retried.driverHandle).toBe(first.driverHandle);
      expect(first.driverHandle).toMatch(/^localdir:[a-f0-9]{64}$/);
      const volume: AgentVolumeResource = {
        apiVersion: 'storage.memeloop.io/v1alpha1',
        kind: 'AgentVolume',
        metadata: {
          name: 'volume',
          uid: 'volume-uid',
          generation: 1,
          resourceVersion: '1',
          creationTimestamp: '',
        },
        spec: {
          storageClassRef: claim().spec.storageClassRef,
          driverHandle: first.driverHandle,
          topology: first.topology,
        },
      };
      const published = await driver.publish({
        volume,
        nodeId: 'node-a',
        workloadUid: 'workload-uid',
        readOnly: false,
      });
      expect(published.mountPath.startsWith(`${path.resolve(root)}${path.sep}`)).toBe(true);
      expect(fs.statSync(published.mountPath).isDirectory()).toBe(true);
      expect(fs.statSync(published.mountPath).mode & 0o777).toBe(0o700);
      expect(
        (await driver.publish({
          volume,
          nodeId: 'node-a',
          workloadUid: 'workload-uid',
          readOnly: false,
        })).publishHandle,
      ).toBe(published.publishHandle);
      const restarted = createLocalDirectoryStorageDriver({
        rootDirectory: root,
        nodeId: 'node-a',
      });
      expect(await restarted.getPublished(published.publishHandle)).toEqual(published);
      await driver.unpublish(published.publishHandle);
      await driver.delete(volume);
      expect(fs.existsSync(published.mountPath)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects publishing a node-local volume to another node', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-local-volume-'));
    const driver = createLocalDirectoryStorageDriver({ rootDirectory: root, nodeId: 'node-a' });
    try {
      const provisioned = await driver.provision({ claim: claim(), storageClass: storageClass() });
      await expect(driver.publish({
        volume: {
          apiVersion: 'storage.memeloop.io/v1alpha1',
          kind: 'AgentVolume',
          metadata: {
            name: 'volume',
            uid: 'volume-uid',
            generation: 1,
            resourceVersion: '1',
            creationTimestamp: '',
          },
          spec: {
            storageClassRef: claim().spec.storageClassRef,
            driverHandle: provisioned.driverHandle,
          },
        },
        nodeId: 'node-b',
        workloadUid: 'workload-uid',
        readOnly: false,
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
