import { OrchestrationError } from '../errors.js';
import type { AgentVolumeClaimResource, AgentVolumeResource, StorageClassResource } from '../resources.js';

import { assertDriverRequestEnvelope, canonicalDriverValue, type DriverRequestEnvelope } from './driverRequest.js';
import type { StorageDriver } from './storageDriver.js';
import type { ManagedVolumePublication, ManagedVolumeStage, StorageManagementDriver, StorageProvisionPayload } from './storageManagement.js';

interface StoredOperation {
  fingerprint: string;
  result?: string;
}

export interface ManagedStorageAdapterStateStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ManagedStorageDriverAdapterOptions {
  authorizeRequest(request: DriverRequestEnvelope): boolean | Promise<boolean>;
  resolveProvisionInput(
    request: DriverRequestEnvelope<StorageProvisionPayload>,
  ): Promise<{
    claim: AgentVolumeClaimResource;
    storageClass: StorageClassResource;
  }>;
  resolveVolume(
    volumeHandle: string,
    request: DriverRequestEnvelope,
  ): Promise<AgentVolumeResource | undefined>;
  stateStore?: ManagedStorageAdapterStateStore;
  stableStageHandleFor?(
    request: DriverRequestEnvelope<{ volumeHandle: string; nodeId: string }>,
  ): string;
  threatAssumptions: string[];
  now?: () => Date;
}

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function unsupported(capability: string): never {
  throw new OrchestrationError({
    code: 'UNSUPPORTED',
    message: `the narrow storage driver does not support ${capability}`,
    retryable: false,
  });
}

function fields(
  value: unknown,
  allowed: readonly string[],
  location: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`storage ${location} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    invalid(`storage ${location} contains unsupported fields: ${unknown.join(', ')}`);
  }
  return record;
}

function stringField(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    invalid(`storage ${location} must be a bounded non-empty string`);
  }
  return value;
}

/**
 * Production bridge for the existing CSI-like StorageDriver. Unsupported data
 * management operations fail explicitly instead of fabricating capabilities.
 */
export function createManagedStorageDriverAdapter(
  driver: StorageDriver,
  options: ManagedStorageDriverAdapterOptions,
): StorageManagementDriver {
  if (
    typeof options.authorizeRequest !== 'function' ||
    !options.threatAssumptions.length
  ) invalid('managed storage adapter authority and threat assumptions are required');
  const now = options.now ?? (() => new Date());
  const processState = new Map<string, unknown>();
  let nextStage = 1;

  const getState = async <T>(key: string): Promise<T | undefined> =>
    (options.stateStore
      ? await options.stateStore.get(key)
      : processState.get(key)) as T | undefined;
  const putState = async (key: string, value: unknown): Promise<void> => {
    if (options.stateStore) await options.stateStore.put(key, value);
    else processState.set(key, value);
  };
  const deleteState = async (key: string): Promise<void> => {
    if (options.stateStore) await options.stateStore.delete(key);
    else processState.delete(key);
  };

  async function validate<T>(
    request: DriverRequestEnvelope<T>,
    method: string,
  ): Promise<void> {
    assertDriverRequestEnvelope(request, {
      now,
      requireFencing: true,
      requireCapability: true,
      expectedMethod: method,
    });
    if (!await options.authorizeRequest(request)) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'storage management capability was rejected',
        retryable: false,
      });
    }
    const fenceKey = `fence:${request.resource.uid}`;
    const current = await getState<number>(fenceKey) ?? 0;
    const fence = request.fencingEpoch as number;
    if (fence < current) {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: `stale storage fencing epoch ${fence}; current epoch is ${current}`,
        retryable: false,
      });
    }
    if (fence > current) await putState(fenceKey, fence);
  }

  function operationKey(request: DriverRequestEnvelope): string {
    return `operation:${request.resource.uid}:${request.method}:${request.idempotencyKey}`;
  }

  function fingerprint(request: DriverRequestEnvelope): string {
    return canonicalDriverValue({
      resource: request.resource,
      run: request.run,
      actor: request.actor,
      payloadSchemaDigest: request.payloadSchemaDigest,
      payload: request.payload,
    });
  }

  async function previous(
    request: DriverRequestEnvelope,
  ): Promise<StoredOperation | undefined> {
    const operation = await getState<StoredOperation>(operationKey(request));
    if (operation && operation.fingerprint !== fingerprint(request)) {
      throw new OrchestrationError({
        code: 'CONFLICT',
        message: 'storage idempotency key was reused with different input',
        retryable: false,
      });
    }
    return operation;
  }

  async function remember(
    request: DriverRequestEnvelope,
    result?: string,
  ): Promise<void> {
    await putState(
      operationKey(request),
      {
        fingerprint: fingerprint(request),
        ...(result ? { result } : {}),
      } satisfies StoredOperation,
    );
  }

  const stageKey = (handle: string) => `stage:${handle}`;
  const publicationKey = (handle: string) => `publication:${handle}`;
  const volumeStagesKey = (handle: string) => `volume-stages:${handle}`;
  const activePublicationKey = (handle: string) => `stage-active-publication:${handle}`;

  return {
    async getCapabilities() {
      const capabilities = await driver.getCapabilities();
      return {
        name: capabilities.name,
        controllerService: true,
        nodeService: true,
        accessModes: [...capabilities.accessModes],
        supportsSnapshots: false,
        supportsExpansion: false,
        supportsReplication: false,
        supportsBackup: false,
        persistence: options.stateStore ? 'host' : 'process',
        threatAssumptions: [...options.threatAssumptions],
      };
    },
    async provision(request) {
      await validate(request, 'storage.provision');
      fields(request.payload, [
        'capacityBytes',
        'accessMode',
        'storageClass',
        'replicaCount',
      ], 'provision payload');
      if (
        !Number.isSafeInteger(request.payload.capacityBytes) ||
        request.payload.capacityBytes < 1 ||
        !Number.isSafeInteger(request.payload.replicaCount) ||
        request.payload.replicaCount !== 1
      ) invalid('narrow storage provisioning requires positive capacity and replicaCount 1');
      stringField(request.payload.storageClass, 'provision storageClass');
      const prior = await previous(request);
      const { claim, storageClass } = await options.resolveProvisionInput(request);
      if (
        claim.metadata.uid !== request.resource.uid ||
        claim.spec.accessMode !== request.payload.accessMode ||
        (claim.spec.sizeBytes ?? 1) !== request.payload.capacityBytes ||
        storageClass.metadata.name !== request.payload.storageClass
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'resolved storage claim/class differs from the managed request',
          retryable: false,
        });
      }
      if (prior?.result) {
        const volume = await options.resolveVolume(prior.result, request);
        if (volume) {
          return {
            volumeHandle: prior.result,
            resourceUid: request.resource.uid,
            capacityBytes: volume.spec.capacityBytes ?? request.payload.capacityBytes,
            accessMode: request.payload.accessMode,
            fencingEpoch: request.fencingEpoch as number,
            phase: 'Available',
          };
        }
      }
      const provisioned = await driver.provision({ claim, storageClass });
      await remember(request, provisioned.driverHandle);
      return {
        volumeHandle: provisioned.driverHandle,
        resourceUid: request.resource.uid,
        capacityBytes: provisioned.capacityBytes ?? request.payload.capacityBytes,
        accessMode: request.payload.accessMode,
        fencingEpoch: request.fencingEpoch as number,
        phase: 'Available',
      };
    },
    async deleteVolume(request) {
      await validate(request, 'storage.delete');
      fields(request.payload, ['volumeHandle'], 'delete payload');
      const volumeHandle = stringField(request.payload.volumeHandle, 'delete volumeHandle');
      if (await previous(request)) return;
      const stages = await getState<string[]>(volumeStagesKey(volumeHandle)) ?? [];
      if (stages.length > 0) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: 'storage volume must be unstaged before deletion',
          retryable: false,
        });
      }
      const volume = await options.resolveVolume(volumeHandle, request);
      if (volume) await driver.delete(volume);
      await remember(request);
    },
    async createSnapshot(request) {
      await validate(request, 'storage.snapshot.create');
      fields(request.payload, ['volumeHandle'], 'snapshot payload');
      return unsupported('snapshots');
    },
    async restoreSnapshot(request) {
      await validate(request, 'storage.snapshot.restore');
      fields(request.payload, ['snapshotHandle', 'capacityBytes'], 'restore payload');
      return unsupported('snapshot restore');
    },
    async expand(request) {
      await validate(request, 'storage.expand');
      fields(request.payload, ['volumeHandle', 'capacityBytes'], 'expand payload');
      return unsupported('volume expansion');
    },
    async getReplicaHealth(request) {
      await validate(request, 'storage.replica.health');
      fields(request.payload, ['volumeHandle'], 'replica-health payload');
      return unsupported('replication');
    },
    async rebuildReplica(request) {
      await validate(request, 'storage.replica.rebuild');
      fields(request.payload, ['volumeHandle', 'replicaCount'], 'replica-rebuild payload');
      return unsupported('replication');
    },
    async createBackup(request) {
      await validate(request, 'storage.backup.create');
      fields(request.payload, ['volumeHandle'], 'backup payload');
      return unsupported('backups');
    },
    async stage(request) {
      await validate(request, 'storage.stage');
      fields(request.payload, ['volumeHandle', 'nodeId'], 'stage payload');
      stringField(request.payload.volumeHandle, 'stage volumeHandle');
      stringField(request.payload.nodeId, 'stage nodeId');
      const prior = await previous(request);
      if (prior?.result) {
        const stage = await getState<ManagedVolumeStage>(stageKey(prior.result));
        if (stage) return stage;
      }
      const volume = await options.resolveVolume(request.payload.volumeHandle, request);
      if (!volume) {
        throw new OrchestrationError({
          code: 'NOT_FOUND',
          message: `storage volume '${request.payload.volumeHandle}' was not found`,
          retryable: false,
        });
      }
      if (
        volume.spec.topology?.nodeId &&
        volume.spec.topology.nodeId !== request.payload.nodeId
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: `storage volume cannot be staged on node '${request.payload.nodeId}'`,
          retryable: false,
        });
      }
      const stageHandle = options.stableStageHandleFor?.(request) ??
        `managed-storage-stage:${nextStage++}`;
      const stage: ManagedVolumeStage = {
        stageHandle,
        volumeHandle: request.payload.volumeHandle,
        resourceUid: request.resource.uid,
        nodeId: request.payload.nodeId,
      };
      const collision = await getState<ManagedVolumeStage>(stageKey(stageHandle));
      if (
        collision &&
        canonicalDriverValue(collision) !== canonicalDriverValue(stage)
      ) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: 'storage stage handle collided across resources or volumes',
          retryable: false,
        });
      }
      await putState(stageKey(stageHandle), stage);
      const stages = await getState<string[]>(
        volumeStagesKey(request.payload.volumeHandle),
      ) ?? [];
      if (!stages.includes(stageHandle)) {
        await putState(
          volumeStagesKey(request.payload.volumeHandle),
          [...stages, stageHandle],
        );
      }
      await remember(request, stageHandle);
      return stage;
    },
    async publish(request) {
      await validate(request, 'storage.publish');
      fields(request.payload, [
        'stageHandle',
        'workloadUid',
        'readOnly',
      ], 'publish payload');
      stringField(request.payload.stageHandle, 'publish stageHandle');
      stringField(request.payload.workloadUid, 'publish workloadUid');
      if (typeof request.payload.readOnly !== 'boolean') {
        invalid('storage publish readOnly must be boolean');
      }
      const prior = await previous(request);
      if (prior?.result) {
        const publication = await getState<ManagedVolumePublication>(
          publicationKey(prior.result),
        );
        if (publication) return publication;
      }
      const stage = await getState<ManagedVolumeStage>(
        stageKey(request.payload.stageHandle),
      );
      if (!stage || stage.resourceUid !== request.resource.uid) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'storage stage handle is unavailable or belongs to another resource',
          retryable: false,
        });
      }
      const volume = await options.resolveVolume(stage.volumeHandle, request);
      if (!volume) {
        throw new OrchestrationError({
          code: 'NOT_FOUND',
          message: `storage volume '${stage.volumeHandle}' was not found`,
          retryable: false,
        });
      }
      if (
        volume.spec.accessModes?.length === 1 &&
        volume.spec.accessModes[0] === 'ReadOnlyMany' &&
        !request.payload.readOnly
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'read-only storage volume cannot be published writable',
          retryable: false,
        });
      }
      const published = await driver.publish({
        volume,
        nodeId: stage.nodeId,
        workloadUid: request.payload.workloadUid,
        readOnly: request.payload.readOnly,
      });
      const publication: ManagedVolumePublication = {
        publishHandle: published.publishHandle,
        stageHandle: stage.stageHandle,
        resourceUid: request.resource.uid,
        workloadUid: request.payload.workloadUid,
        readOnly: request.payload.readOnly,
      };
      const collision = await getState<ManagedVolumePublication>(
        publicationKey(publication.publishHandle),
      );
      if (
        collision &&
        canonicalDriverValue(collision) !== canonicalDriverValue(publication)
      ) {
        await driver.unpublish(publication.publishHandle);
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: 'storage publication handle collided across scopes',
          retryable: false,
        });
      }
      await putState(publicationKey(publication.publishHandle), publication);
      await putState(
        activePublicationKey(stage.stageHandle),
        publication.publishHandle,
      );
      await remember(request, publication.publishHandle);
      return publication;
    },
    async unpublish(request) {
      await validate(request, 'storage.unpublish');
      fields(request.payload, ['publishHandle'], 'unpublish payload');
      const handle = stringField(request.payload.publishHandle, 'unpublish publishHandle');
      if (await previous(request)) return;
      const publication = await getState<ManagedVolumePublication>(
        publicationKey(handle),
      );
      if (publication && publication.resourceUid !== request.resource.uid) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'storage publication belongs to another resource',
          retryable: false,
        });
      }
      await driver.unpublish(handle);
      await deleteState(publicationKey(handle));
      if (publication) {
        await deleteState(activePublicationKey(publication.stageHandle));
      }
      await remember(request);
    },
    async unstage(request) {
      await validate(request, 'storage.unstage');
      fields(request.payload, ['stageHandle'], 'unstage payload');
      const handle = stringField(request.payload.stageHandle, 'unstage stageHandle');
      if (await previous(request)) return;
      const stage = await getState<ManagedVolumeStage>(stageKey(handle));
      if (stage && stage.resourceUid !== request.resource.uid) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'storage stage belongs to another resource',
          retryable: false,
        });
      }
      if (await getState<string>(activePublicationKey(handle))) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: 'storage publication must be removed before unstage',
          retryable: false,
        });
      }
      await deleteState(stageKey(handle));
      if (stage) {
        const stages = await getState<string[]>(
          volumeStagesKey(stage.volumeHandle),
        ) ?? [];
        const remaining = stages.filter((item) => item !== handle);
        if (remaining.length > 0) {
          await putState(volumeStagesKey(stage.volumeHandle), remaining);
        } else {
          await deleteState(volumeStagesKey(stage.volumeHandle));
        }
      }
      await remember(request);
    },
    async getStats(request) {
      await validate(request, 'storage.stats');
      fields(request.payload, ['publishHandle'], 'stats payload');
      return unsupported('volume statistics');
    },
  };
}
