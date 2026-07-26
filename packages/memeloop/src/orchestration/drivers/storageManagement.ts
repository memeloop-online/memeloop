import { OrchestrationError } from '../errors.js';
import type { VolumeAccessMode } from '../resources.js';

import type { DriverConformanceSuite } from './driverConformance.js';
import { assertDriverRequestEnvelope, type DriverRequestEnvelope } from './driverRequest.js';

export interface StorageManagementCapabilities {
  name: string;
  controllerService: boolean;
  nodeService: boolean;
  accessModes: VolumeAccessMode[];
  supportsSnapshots: boolean;
  supportsExpansion: boolean;
  supportsReplication: boolean;
  supportsBackup: boolean;
  persistence: 'process' | 'host' | 'external';
  threatAssumptions: string[];
}

export interface StorageProvisionPayload {
  capacityBytes: number;
  accessMode: VolumeAccessMode;
  storageClass: string;
  replicaCount: number;
}

export interface ManagedVolume {
  volumeHandle: string;
  resourceUid: string;
  capacityBytes: number;
  accessMode: VolumeAccessMode;
  fencingEpoch: number;
  phase: 'Available' | 'Deleted';
}

export interface ManagedVolumeSnapshot {
  snapshotHandle: string;
  volumeHandle: string;
  resourceUid: string;
  createdAt: string;
}

export interface ManagedVolumeBackup {
  backupHandle: string;
  volumeHandle: string;
  resourceUid: string;
  createdAt: string;
}

export interface ManagedReplicaHealth {
  volumeHandle: string;
  healthy: number;
  desired: number;
  rebuilding: boolean;
  checkedAt: string;
}

export interface ManagedVolumeStage {
  stageHandle: string;
  volumeHandle: string;
  resourceUid: string;
  nodeId: string;
}

export interface ManagedVolumePublication {
  publishHandle: string;
  stageHandle: string;
  resourceUid: string;
  workloadUid: string;
  readOnly: boolean;
}

export interface ManagedVolumeStats {
  capacityBytes: number;
  usedBytes: number;
  availableBytes: number;
}

/** Complete §10.6 CSI-like controller and node management surface. */
export interface StorageManagementDriver {
  getCapabilities(): Promise<StorageManagementCapabilities>;
  provision(request: DriverRequestEnvelope<StorageProvisionPayload>): Promise<ManagedVolume>;
  deleteVolume(request: DriverRequestEnvelope<{ volumeHandle: string }>): Promise<void>;
  createSnapshot(
    request: DriverRequestEnvelope<{ volumeHandle: string }>,
  ): Promise<ManagedVolumeSnapshot>;
  restoreSnapshot(
    request: DriverRequestEnvelope<{
      snapshotHandle: string;
      capacityBytes?: number;
    }>,
  ): Promise<ManagedVolume>;
  expand(
    request: DriverRequestEnvelope<{
      volumeHandle: string;
      capacityBytes: number;
    }>,
  ): Promise<ManagedVolume>;
  getReplicaHealth(
    request: DriverRequestEnvelope<{ volumeHandle: string }>,
  ): Promise<ManagedReplicaHealth>;
  rebuildReplica(
    request: DriverRequestEnvelope<{
      volumeHandle: string;
      replicaCount: number;
    }>,
  ): Promise<ManagedReplicaHealth>;
  createBackup(
    request: DriverRequestEnvelope<{ volumeHandle: string }>,
  ): Promise<ManagedVolumeBackup>;
  stage(
    request: DriverRequestEnvelope<{
      volumeHandle: string;
      nodeId: string;
    }>,
  ): Promise<ManagedVolumeStage>;
  publish(
    request: DriverRequestEnvelope<{
      stageHandle: string;
      workloadUid: string;
      readOnly: boolean;
    }>,
  ): Promise<ManagedVolumePublication>;
  unpublish(request: DriverRequestEnvelope<{ publishHandle: string }>): Promise<void>;
  unstage(request: DriverRequestEnvelope<{ stageHandle: string }>): Promise<void>;
  getStats(
    request: DriverRequestEnvelope<{ publishHandle: string }>,
  ): Promise<ManagedVolumeStats>;
}

interface VolumeRecord {
  volume: ManagedVolume;
  desiredReplicas: number;
}

export interface FakeStorageManagementState {
  volumes: Map<string, VolumeRecord>;
  snapshots: Map<string, ManagedVolumeSnapshot>;
  backups: Map<string, ManagedVolumeBackup>;
  stages: Map<string, ManagedVolumeStage>;
  publications: Map<string, ManagedVolumePublication>;
  idempotency: Map<string, string>;
  fences: Map<string, number>;
  nextHandle: number;
}

export function createFakeStorageManagementState(): FakeStorageManagementState {
  return {
    volumes: new Map(),
    snapshots: new Map(),
    backups: new Map(),
    stages: new Map(),
    publications: new Map(),
    idempotency: new Map(),
    fences: new Map(),
    nextHandle: 1,
  };
}

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function requiredString(payload: unknown, field: string): string {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof (payload as Record<string, unknown>)[field] !== 'string' ||
    !(payload as Record<string, string>)[field]
  ) {
    invalid(`storage payload '${field}' is required`);
  }
  return (payload as Record<string, string>)[field];
}

function requiredPositiveInteger(payload: unknown, field: string): number {
  if (payload === null || typeof payload !== 'object') {
    invalid(`storage payload '${field}' is required`);
  }
  const value = (payload as Record<string, unknown>)[field];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid(`storage payload '${field}' must be a positive safe integer`);
  }
  return value as number;
}

/**
 * Stateful reference implementation. Reusing its state across instances
 * simulates a driver-host restart and proves that opaque handles remain
 * inspectable without relying on process memory.
 */
export function createFakeStorageManagementDriver(options: {
  state?: FakeStorageManagementState;
  now?: () => Date;
} = {}): StorageManagementDriver {
  const state = options.state ?? createFakeStorageManagementState();
  const now = options.now ?? (() => new Date());

  function validate<T>(
    request: DriverRequestEnvelope<T>,
    expectedMethod: string,
  ): number {
    assertDriverRequestEnvelope<T>(request, {
      now,
      requireFencing: true,
      requireCapability: true,
      expectedMethod,
    });
    const fence = request.fencingEpoch as number;
    const current = state.fences.get(request.resource.uid) ?? 0;
    if (fence < current) {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: `stale storage fencing epoch ${fence}; current epoch is ${current}`,
        retryable: false,
      });
    }
    state.fences.set(request.resource.uid, fence);
    return fence;
  }

  function nextHandle(prefix: string): string {
    const handle = `${prefix}:${state.nextHandle}`;
    state.nextHandle += 1;
    return handle;
  }

  function operationKey(request: DriverRequestEnvelope, operation: string): string {
    return `${request.resource.uid}:${operation}:${request.idempotencyKey}`;
  }

  function getVolume(handle: string, resourceUid: string): VolumeRecord {
    const record = state.volumes.get(handle);
    if (!record || record.volume.phase === 'Deleted') {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `volume handle '${handle}' was not found`,
        retryable: false,
      });
    }
    if (record.volume.resourceUid !== resourceUid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `volume handle '${handle}' belongs to another resource`,
        retryable: false,
      });
    }
    return record;
  }

  function owned<T extends { resourceUid: string }>(
    collection: Map<string, T>,
    handle: string,
    resourceUid: string,
    kind: string,
  ): T {
    const value = collection.get(handle);
    if (!value) {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `${kind} handle '${handle}' was not found`,
        retryable: false,
      });
    }
    if (value.resourceUid !== resourceUid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `${kind} handle '${handle}' belongs to another resource`,
        retryable: false,
      });
    }
    return value;
  }

  function createVolume(
    request: DriverRequestEnvelope,
    capacityBytes: number,
    accessMode: VolumeAccessMode,
    replicaCount: number,
    operation: string,
  ): ManagedVolume {
    const key = operationKey(request, operation);
    const existing = state.idempotency.get(key);
    if (existing) return getVolume(existing, request.resource.uid).volume;
    const volume: ManagedVolume = {
      volumeHandle: nextHandle('volume'),
      resourceUid: request.resource.uid,
      capacityBytes,
      accessMode,
      fencingEpoch: request.fencingEpoch as number,
      phase: 'Available',
    };
    state.volumes.set(volume.volumeHandle, { volume, desiredReplicas: replicaCount });
    state.idempotency.set(key, volume.volumeHandle);
    return volume;
  }

  return {
    async getCapabilities() {
      return {
        name: 'fake-managed-storage',
        controllerService: true,
        nodeService: true,
        accessModes: ['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany'],
        supportsSnapshots: true,
        supportsExpansion: true,
        supportsReplication: true,
        supportsBackup: true,
        persistence: 'host',
        threatAssumptions: ['the injected fake state is durable and trusted'],
      };
    },
    async provision(request) {
      validate(request, 'storage.provision');
      const capacityBytes = requiredPositiveInteger(request.payload, 'capacityBytes');
      const replicaCount = requiredPositiveInteger(request.payload, 'replicaCount');
      const storageClass = requiredString(request.payload, 'storageClass');
      if (!storageClass) invalid('storage class is required');
      if (
        !['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany'].includes(
          request.payload.accessMode,
        )
      ) invalid('unsupported volume access mode');
      return createVolume(
        request,
        capacityBytes,
        request.payload.accessMode,
        replicaCount,
        'provision',
      );
    },
    async deleteVolume(request) {
      validate(request, 'storage.delete');
      const handle = requiredString(request.payload, 'volumeHandle');
      const record = state.volumes.get(handle);
      if (!record || record.volume.phase === 'Deleted') return;
      getVolume(handle, request.resource.uid);
      if (
        [...state.publications.values()].some(
          (publication) => state.stages.get(publication.stageHandle)?.volumeHandle === handle,
        )
      ) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: `volume '${handle}' is still published`,
          retryable: true,
        });
      }
      record.volume = { ...record.volume, phase: 'Deleted' };
    },
    async createSnapshot(request) {
      validate(request, 'storage.snapshot');
      const volumeHandle = requiredString(request.payload, 'volumeHandle');
      getVolume(volumeHandle, request.resource.uid);
      const key = operationKey(request, 'snapshot');
      const existing = state.idempotency.get(key);
      if (existing) return owned(state.snapshots, existing, request.resource.uid, 'snapshot');
      const snapshot: ManagedVolumeSnapshot = {
        snapshotHandle: nextHandle('snapshot'),
        volumeHandle,
        resourceUid: request.resource.uid,
        createdAt: now().toISOString(),
      };
      state.snapshots.set(snapshot.snapshotHandle, snapshot);
      state.idempotency.set(key, snapshot.snapshotHandle);
      return snapshot;
    },
    async restoreSnapshot(request) {
      validate(request, 'storage.restore');
      const snapshot = owned(
        state.snapshots,
        requiredString(request.payload, 'snapshotHandle'),
        request.resource.uid,
        'snapshot',
      );
      const source = getVolume(snapshot.volumeHandle, request.resource.uid);
      const capacityBytes = request.payload.capacityBytes ?? source.volume.capacityBytes;
      if (
        !Number.isSafeInteger(capacityBytes) ||
        capacityBytes < source.volume.capacityBytes
      ) invalid('restored capacity cannot be smaller than the source volume');
      return createVolume(
        request,
        capacityBytes,
        source.volume.accessMode,
        source.desiredReplicas,
        'restore',
      );
    },
    async expand(request) {
      const fence = validate(request, 'storage.expand');
      const record = getVolume(
        requiredString(request.payload, 'volumeHandle'),
        request.resource.uid,
      );
      const capacityBytes = requiredPositiveInteger(request.payload, 'capacityBytes');
      if (capacityBytes < record.volume.capacityBytes) {
        invalid('volume shrink is not supported');
      }
      record.volume = { ...record.volume, capacityBytes, fencingEpoch: fence };
      return record.volume;
    },
    async getReplicaHealth(request) {
      validate(request, 'storage.replica-health');
      const record = getVolume(
        requiredString(request.payload, 'volumeHandle'),
        request.resource.uid,
      );
      return {
        volumeHandle: record.volume.volumeHandle,
        healthy: record.desiredReplicas,
        desired: record.desiredReplicas,
        rebuilding: false,
        checkedAt: now().toISOString(),
      };
    },
    async rebuildReplica(request) {
      validate(request, 'storage.rebuild');
      const record = getVolume(
        requiredString(request.payload, 'volumeHandle'),
        request.resource.uid,
      );
      record.desiredReplicas = requiredPositiveInteger(request.payload, 'replicaCount');
      return {
        volumeHandle: record.volume.volumeHandle,
        healthy: record.desiredReplicas,
        desired: record.desiredReplicas,
        rebuilding: false,
        checkedAt: now().toISOString(),
      };
    },
    async createBackup(request) {
      validate(request, 'storage.backup');
      const volumeHandle = requiredString(request.payload, 'volumeHandle');
      getVolume(volumeHandle, request.resource.uid);
      const key = operationKey(request, 'backup');
      const existing = state.idempotency.get(key);
      if (existing) return owned(state.backups, existing, request.resource.uid, 'backup');
      const backup: ManagedVolumeBackup = {
        backupHandle: nextHandle('backup'),
        volumeHandle,
        resourceUid: request.resource.uid,
        createdAt: now().toISOString(),
      };
      state.backups.set(backup.backupHandle, backup);
      state.idempotency.set(key, backup.backupHandle);
      return backup;
    },
    async stage(request) {
      validate(request, 'storage.stage');
      const volumeHandle = requiredString(request.payload, 'volumeHandle');
      getVolume(volumeHandle, request.resource.uid);
      const nodeId = requiredString(request.payload, 'nodeId');
      const key = operationKey(request, 'stage');
      const existing = state.idempotency.get(key);
      if (existing) return owned(state.stages, existing, request.resource.uid, 'stage');
      const stage: ManagedVolumeStage = {
        stageHandle: nextHandle('stage'),
        volumeHandle,
        resourceUid: request.resource.uid,
        nodeId,
      };
      state.stages.set(stage.stageHandle, stage);
      state.idempotency.set(key, stage.stageHandle);
      return stage;
    },
    async publish(request) {
      validate(request, 'storage.publish');
      const stage = owned(
        state.stages,
        requiredString(request.payload, 'stageHandle'),
        request.resource.uid,
        'stage',
      );
      getVolume(stage.volumeHandle, request.resource.uid);
      const workloadUid = requiredString(request.payload, 'workloadUid');
      if (typeof request.payload.readOnly !== 'boolean') invalid('publish readOnly is required');
      const key = operationKey(request, 'publish');
      const existing = state.idempotency.get(key);
      if (existing) {
        return owned(state.publications, existing, request.resource.uid, 'publication');
      }
      const publication: ManagedVolumePublication = {
        publishHandle: nextHandle('publication'),
        stageHandle: stage.stageHandle,
        resourceUid: request.resource.uid,
        workloadUid,
        readOnly: request.payload.readOnly,
      };
      state.publications.set(publication.publishHandle, publication);
      state.idempotency.set(key, publication.publishHandle);
      return publication;
    },
    async unpublish(request) {
      validate(request, 'storage.unpublish');
      const handle = requiredString(request.payload, 'publishHandle');
      const publication = state.publications.get(handle);
      if (!publication) return;
      owned(state.publications, handle, request.resource.uid, 'publication');
      state.publications.delete(handle);
    },
    async unstage(request) {
      validate(request, 'storage.unstage');
      const handle = requiredString(request.payload, 'stageHandle');
      const stage = state.stages.get(handle);
      if (!stage) return;
      owned(state.stages, handle, request.resource.uid, 'stage');
      if (
        [...state.publications.values()].some(
          (publication) => publication.stageHandle === handle,
        )
      ) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: `stage '${handle}' is still published`,
          retryable: true,
        });
      }
      state.stages.delete(handle);
    },
    async getStats(request) {
      validate(request, 'storage.stats');
      const publication = owned(
        state.publications,
        requiredString(request.payload, 'publishHandle'),
        request.resource.uid,
        'publication',
      );
      const stage = owned(
        state.stages,
        publication.stageHandle,
        request.resource.uid,
        'stage',
      );
      const capacityBytes = getVolume(
        stage.volumeHandle,
        request.resource.uid,
      ).volume.capacityBytes;
      return { capacityBytes, usedBytes: 0, availableBytes: capacityBytes };
    },
  };
}

export function createStorageManagementConformanceSuite(options: {
  createRequest<T>(
    method: string,
    payload: T,
    idempotencyKey: string,
    fencingEpoch?: number,
    resourceUid?: string,
  ): DriverRequestEnvelope<T>;
  recreate(driver: StorageManagementDriver): StorageManagementDriver;
}): DriverConformanceSuite {
  const provision = (driver: StorageManagementDriver, suffix: string, epoch = 1) =>
    driver.provision(options.createRequest(
      'storage.provision',
      {
        capacityBytes: 1024,
        accessMode: 'ReadWriteOnce' as const,
        storageClass: 'local',
        replicaCount: 1,
      },
      `provision-${suffix}`,
      epoch,
    ));

  return {
    interfaceKind: 'storage',
    tests: [
      {
        name: 'declares controller, node, persistence, and threat capabilities',
        description: 'Storage capability negotiation is explicit and fail-closed',
        run: async (value) => {
          const capabilities = await (value as StorageManagementDriver).getCapabilities();
          if (!capabilities.controllerService || !capabilities.nodeService) {
            throw new Error('storage services are incomplete');
          }
          if (!capabilities.accessModes.length || !capabilities.threatAssumptions.length) {
            throw new Error('storage capability declarations are incomplete');
          }
        },
      },
      {
        name: 'provision is idempotent and expansion never shrinks',
        description: 'Controller-side allocation is stable and monotonic',
        run: async (value) => {
          const driver = value as StorageManagementDriver;
          const request = options.createRequest(
            'storage.provision',
            {
              capacityBytes: 1024,
              accessMode: 'ReadWriteOnce' as const,
              storageClass: 'local',
              replicaCount: 1,
            },
            'idempotent',
          );
          const first = await driver.provision(request);
          const second = await driver.provision(request);
          if (first.volumeHandle !== second.volumeHandle) {
            throw new Error('provision is not idempotent');
          }
          const expanded = await driver.expand(options.createRequest(
            'storage.expand',
            { volumeHandle: first.volumeHandle, capacityBytes: 2048 },
            'expand',
          ));
          if (expanded.capacityBytes !== 2048) throw new Error('expand did not converge');
        },
      },
      {
        name: 'snapshot, restore, backup, and replica rebuild survive restart',
        description: 'Durable controller handles remain usable after driver recreation',
        run: async (value) => {
          let driver = value as StorageManagementDriver;
          const volume = await provision(driver, 'durable');
          const snapshot = await driver.createSnapshot(options.createRequest(
            'storage.snapshot',
            { volumeHandle: volume.volumeHandle },
            'snapshot',
          ));
          const backup = await driver.createBackup(options.createRequest(
            'storage.backup',
            { volumeHandle: volume.volumeHandle },
            'backup',
          ));
          if (!backup.backupHandle) throw new Error('backup handle is missing');
          driver = options.recreate(driver);
          const restored = await driver.restoreSnapshot(options.createRequest(
            'storage.restore',
            { snapshotHandle: snapshot.snapshotHandle, capacityBytes: 2048 },
            'restore',
          ));
          const health = await driver.rebuildReplica(options.createRequest(
            'storage.rebuild',
            { volumeHandle: restored.volumeHandle, replicaCount: 3 },
            'rebuild',
          ));
          if (health.healthy !== 3 || health.desired !== 3) {
            throw new Error('replica rebuild did not converge');
          }
          const inspected = await driver.getReplicaHealth(options.createRequest(
            'storage.replica-health',
            { volumeHandle: restored.volumeHandle },
            'replica-health',
          ));
          if (inspected.healthy !== 3 || inspected.desired !== 3) {
            throw new Error('replica health did not preserve rebuilt state');
          }
        },
      },
      {
        name: 'stage, publish, stats, unpublish, unstage, and delete converge',
        description: 'Node lifecycle cleanup is ordered and idempotent',
        run: async (value) => {
          const driver = value as StorageManagementDriver;
          const volume = await provision(driver, 'node');
          const stage = await driver.stage(options.createRequest(
            'storage.stage',
            { volumeHandle: volume.volumeHandle, nodeId: 'node-1' },
            'stage',
          ));
          const publication = await driver.publish(options.createRequest(
            'storage.publish',
            {
              stageHandle: stage.stageHandle,
              workloadUid: 'workload-1',
              readOnly: false,
            },
            'publish',
          ));
          const stats = await driver.getStats(options.createRequest(
            'storage.stats',
            { publishHandle: publication.publishHandle },
            'stats',
          ));
          if (stats.capacityBytes !== volume.capacityBytes) {
            throw new Error('published stats do not match the volume');
          }
          const unpublish = options.createRequest(
            'storage.unpublish',
            { publishHandle: publication.publishHandle },
            'unpublish',
          );
          await driver.unpublish(unpublish);
          await driver.unpublish(unpublish);
          const unstage = options.createRequest(
            'storage.unstage',
            { stageHandle: stage.stageHandle },
            'unstage',
          );
          await driver.unstage(unstage);
          await driver.unstage(unstage);
          const deletion = options.createRequest(
            'storage.delete',
            { volumeHandle: volume.volumeHandle },
            'delete',
          );
          await driver.deleteVolume(deletion);
          await driver.deleteVolume(deletion);
        },
      },
      {
        name: 'rejects stale fencing and cross-resource opaque handles',
        description: 'Old controllers and unrelated resources cannot mutate storage',
        run: async (value) => {
          const driver = value as StorageManagementDriver;
          const volume = await provision(driver, 'fenced', 8);
          let staleRejected = false;
          try {
            await driver.expand(options.createRequest(
              'storage.expand',
              { volumeHandle: volume.volumeHandle, capacityBytes: 2048 },
              'stale',
              7,
            ));
          } catch (error) {
            staleRejected = error instanceof OrchestrationError && error.code === 'STALE_EPOCH';
          }
          if (!staleRejected) throw new Error('stale storage epoch was accepted');
          let foreignRejected = false;
          try {
            await driver.createSnapshot(options.createRequest(
              'storage.snapshot',
              { volumeHandle: volume.volumeHandle },
              'foreign',
              8,
              'foreign-volume-uid',
            ));
          } catch (error) {
            foreignRejected = error instanceof OrchestrationError && error.code === 'FORBIDDEN';
          }
          if (!foreignRejected) throw new Error('foreign volume handle was accepted');
        },
      },
    ],
  };
}
