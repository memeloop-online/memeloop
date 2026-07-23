import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { OrchestrationError, type StorageDriver, type StorageDriverCapabilities } from 'memeloop';

export interface LocalDirectoryStorageDriverOptions {
  rootDirectory: string;
  nodeId: string;
  maxVolumeBytes?: number;
  now?: () => Date;
}

export const LOCAL_DIRECTORY_STORAGE_DRIVER_NAME = 'local-directory';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Reference process-host volume driver backed by private local directories. */
export function createLocalDirectoryStorageDriver(
  options: LocalDirectoryStorageDriverOptions,
): StorageDriver {
  const volumeRoot = path.resolve(options.rootDirectory);
  const publicationRoot = path.join(volumeRoot, '.publications');
  const publications = new Map<string, { publishHandle: string; mountPath: string }>();
  const capabilities: StorageDriverCapabilities = {
    name: LOCAL_DIRECTORY_STORAGE_DRIVER_NAME,
    accessModes: ['ReadWriteOnce', 'ReadOnlyMany'],
    snapshots: false,
    encryption: false,
    ...(options.maxVolumeBytes !== undefined
      ? { maxVolumeBytes: options.maxVolumeBytes }
      : {}),
  };

  function handleForClaimUid(uid: string): string {
    return `localdir:${digest(uid)}`;
  }

  function directoryForHandle(handle: string): string {
    const match = /^localdir:([a-f0-9]{64})$/.exec(handle);
    if (!match) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'invalid local-directory volume handle',
        retryable: false,
      });
    }
    return path.join(volumeRoot, match[1]);
  }

  return {
    async getCapabilities() {
      return capabilities;
    },
    async getHealth() {
      try {
        await fs.mkdir(volumeRoot, { recursive: true, mode: 0o700 });
        await fs.mkdir(publicationRoot, { recursive: true, mode: 0o700 });
        await fs.access(volumeRoot);
        return {
          healthy: true,
          detail: 'private host directory; process-path publication only',
          checkedAt: (options.now?.() ?? new Date()).toISOString(),
        };
      } catch (error) {
        return {
          healthy: false,
          detail: error instanceof Error ? error.message : String(error),
          checkedAt: (options.now?.() ?? new Date()).toISOString(),
        };
      }
    },
    async provision(request) {
      const handle = handleForClaimUid(request.claim.metadata.uid);
      const directory = directoryForHandle(handle);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      return {
        driverHandle: handle,
        ...(request.claim.spec.sizeBytes !== undefined
          ? { capacityBytes: request.claim.spec.sizeBytes }
          : {}),
        topology: { nodeId: options.nodeId },
      };
    },
    async delete(volume) {
      await fs.rm(directoryForHandle(volume.spec.driverHandle), {
        recursive: true,
        force: true,
      });
    },
    async publish(request) {
      if (
        request.nodeId !== options.nodeId ||
        request.volume.spec.topology?.nodeId && request.volume.spec.topology.nodeId !== options.nodeId
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: `local volume cannot publish to node '${request.nodeId}'`,
          retryable: false,
        });
      }
      const mountPath = directoryForHandle(request.volume.spec.driverHandle);
      await fs.access(mountPath);
      const publishHandle = `localpublish:${
        digest(
          `${request.volume.metadata.uid}:${request.workloadUid}:${request.nodeId}`,
        )
      }`;
      const published = { publishHandle, mountPath };
      publications.set(publishHandle, published);
      await fs.mkdir(publicationRoot, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(publicationRoot, publishHandle.slice('localpublish:'.length)),
        JSON.stringify(published),
        { encoding: 'utf8', mode: 0o600 },
      );
      return published;
    },
    async getPublished(publishHandle) {
      const live = publications.get(publishHandle);
      if (live) return live;
      const match = /^localpublish:([a-f0-9]{64})$/.exec(publishHandle);
      if (!match) return undefined;
      try {
        const parsed = JSON.parse(
          await fs.readFile(path.join(publicationRoot, match[1]), 'utf8'),
        ) as { publishHandle?: unknown; mountPath?: unknown };
        if (
          parsed.publishHandle !== publishHandle ||
          typeof parsed.mountPath !== 'string' ||
          !parsed.mountPath.startsWith(`${volumeRoot}${path.sep}`)
        ) return undefined;
        const published = { publishHandle, mountPath: parsed.mountPath };
        publications.set(publishHandle, published);
        return published;
      } catch {
        return undefined;
      }
    },
    async unpublish(publishHandle) {
      publications.delete(publishHandle);
      const match = /^localpublish:([a-f0-9]{64})$/.exec(publishHandle);
      if (match) await fs.rm(path.join(publicationRoot, match[1]), { force: true });
    },
  };
}
