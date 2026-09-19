import type { ControlLeaseIdentity } from '../orchestration/controlStore.js';
import { OrchestrationError } from '../orchestration/errors.js';
import { scopedLoopCheckpointKey } from './types.js';
import type {
  AgentLoopRuntime,
  LoopCheckpointRecord,
  LoopCheckpointScope,
  LoopCheckpointWriteOptions,
  LoopScriptCheckpoint,
  LoopScriptCheckpointBinding,
  LoopScriptCheckpointIdentity,
} from './types.js';

const SCRIPT_CHECKPOINT_LATEST_PREFIX = '__memeloop_script_checkpoint_latest__:';

export class LoopCheckpointIdentityMismatchError extends Error {
  readonly code = 'CHECKPOINT_IDENTITY_MISMATCH' as const;

  constructor(
    readonly expected: LoopScriptCheckpointIdentity,
    readonly actual: LoopScriptCheckpointIdentity,
  ) {
    super(
      `Checkpoint '${actual.id}' cannot resume '${expected.id}': ` +
        'script/profile version or digest changed without a migration.',
    );
    this.name = 'LoopCheckpointIdentityMismatchError';
  }
}

type LoopCheckpointStore = {
  saveCheckpoint(
    conversationId: string,
    key: string,
    result: unknown,
    options?: LoopCheckpointWriteOptions,
  ): Promise<void>;
  loadCheckpoint<T>(conversationId: string, key: string, options?: { scope?: LoopCheckpointScope }): Promise<T | undefined>;
  loadCheckpointRecord?<T>(
    conversationId: string,
    key: string,
    options?: { scope?: LoopCheckpointScope },
  ): Promise<LoopCheckpointRecord<T> | undefined>;
  compareAndSetCheckpoint?<T>(
    conversationId: string,
    key: string,
    expectedRevision: number | undefined,
    result: T,
    options?: Omit<LoopCheckpointWriteOptions, 'expectedRevision'>,
  ): Promise<LoopCheckpointRecord<T>>;
};

export interface ScriptCheckpointRuntimeOptions {
  conversationId: string;
  store?: LoopCheckpointStore;
  fallbackScope?: LoopCheckpointScope;
  state: Map<string, unknown>;
  locks: Map<string, Promise<unknown>>;
  records: Map<string, LoopCheckpointRecord>;
  /** Durable run-execution fence supplied by the owning runtime. */
  fencingEpoch?: number;
  /** Current atomic checkpoint-store lease for a run-scoped script runtime. */
  leasePrecondition?: () => ControlLeaseIdentity | undefined;
  onAccepted?: (checkpoint: LoopScriptCheckpoint) => void;
}

function checkpointScopeFromIdentity(
  identity: LoopScriptCheckpointIdentity,
  fencingEpoch?: number,
): LoopCheckpointScope {
  return {
    scriptDigest: identity.scriptDigest,
    apiVersion: identity.apiVersion,
    schemaVersion: identity.schemaVersion,
    checkpointId: identity.id,
    scriptVersion: identity.scriptVersion,
    profileId: identity.profileId,
    profileVersion: identity.profileVersion,
    ...(identity.runId ? { runId: identity.runId } : {}),
    ...(fencingEpoch === undefined ? {} : { fencingEpoch }),
  };
}

function latestScriptCheckpointKey(
  identity: Pick<LoopScriptCheckpointIdentity, 'id' | 'profileId' | 'runId'>,
  key: string,
): string {
  return `${SCRIPT_CHECKPOINT_LATEST_PREFIX}${encodeURIComponent(identity.id)}:${encodeURIComponent(identity.profileId)}:${encodeURIComponent(identity.runId ?? '')}:${
    encodeURIComponent(key)
  }`;
}

function sameCheckpointIdentity(left: LoopScriptCheckpointIdentity, right: LoopScriptCheckpointIdentity): boolean {
  return left.id === right.id &&
    left.scriptVersion === right.scriptVersion &&
    left.profileId === right.profileId &&
    left.profileVersion === right.profileVersion &&
    left.scriptDigest === right.scriptDigest &&
    left.apiVersion === right.apiVersion &&
    left.schemaVersion === right.schemaVersion &&
    left.runId === right.runId;
}

function isLoopScriptCheckpoint(value: unknown): value is LoopScriptCheckpoint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const checkpoint = value as Partial<LoopScriptCheckpoint>;
  const identity = checkpoint.identity as Partial<LoopScriptCheckpointIdentity> | undefined;
  return typeof checkpoint.key === 'string' && checkpoint.key.length > 0 &&
    typeof checkpoint.revision === 'number' && Number.isSafeInteger(checkpoint.revision) && checkpoint.revision > 0 &&
    typeof checkpoint.acceptedAt === 'number' && Number.isSafeInteger(checkpoint.acceptedAt) &&
    identity !== undefined &&
    typeof identity.id === 'string' && identity.id.length > 0 &&
    typeof identity.scriptVersion === 'string' && identity.scriptVersion.length > 0 &&
    typeof identity.profileId === 'string' && identity.profileId.length > 0 &&
    typeof identity.profileVersion === 'string' && identity.profileVersion.length > 0 &&
    typeof identity.scriptDigest === 'string' && identity.scriptDigest.length > 0 &&
    typeof identity.apiVersion === 'string' && identity.apiVersion.length > 0 &&
    typeof identity.schemaVersion === 'string' && identity.schemaVersion.length > 0 &&
    (identity.runId === undefined || typeof identity.runId === 'string');
}

/**
 * Keeps the checkpoint protocol independent from the broad runtime factory.
 * It is the only place that knows the stable latest pointer and migration
 * rules; `runtime.ts` only supplies lifecycle/host observation glue.
 */
export function createScriptCheckpointRuntime(
  options: ScriptCheckpointRuntimeOptions,
): Pick<AgentLoopRuntime, 'bindScriptCheckpoint' | 'state' | 'checkpoint' | 'loadCheckpoint'> {
  let binding: LoopScriptCheckpointBinding | undefined;
  const scope = (): LoopCheckpointScope | undefined =>
    binding
      ? checkpointScopeFromIdentity(binding.identity, options.fencingEpoch)
      : options.fallbackScope;
  // State, locks, and cached records are process-local, but can be shared by
  // parent/child runners. Mirror the durable namespace exactly so a child
  // profile cannot observe its parent's values in the same conversation.
  const stateKey = (key: string): string => `${options.conversationId}:${scopedLoopCheckpointKey(key, scope())}`;
  const requireStore = (): LoopCheckpointStore => {
    if (options.store) return options.store;
    throw new OrchestrationError({
      code: 'UNSUPPORTED',
      message: 'durable loop checkpoint store is required for script state and checkpoints',
      retryable: false,
    });
  };
  const leasePrecondition = (): ControlLeaseIdentity | undefined => {
    if (!options.leasePrecondition) return undefined;
    const lease = options.leasePrecondition();
    if (lease) return lease;
    throw new OrchestrationError({
      code: 'STALE_EPOCH',
      message: 'run execution lease is no longer current for checkpoint write',
      retryable: false,
    });
  };
  const withLock = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = options.locks.get(key);
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    options.locks.set(key, current);
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (options.locks.get(key) === current) options.locks.delete(key);
    }
  };
  const loadRecord = async <T>(
    key: string,
    readOptions: { refresh?: boolean } = {},
  ): Promise<LoopCheckpointRecord<T> | undefined> => {
    const store = requireStore();
    const cacheKey = stateKey(key);
    const cached = options.records.get(cacheKey) as LoopCheckpointRecord<T> | undefined;
    if (cached && !readOptions.refresh) return cached;
    if (readOptions.refresh) options.records.delete(cacheKey);
    const activeScope = scope();
    if (store.loadCheckpointRecord) {
      const loaded = await store.loadCheckpointRecord<T>(options.conversationId, key, { scope: activeScope });
      if (loaded) options.records.set(cacheKey, loaded as LoopCheckpointRecord);
      return loaded;
    }
    const result = await store.loadCheckpoint<T>(options.conversationId, key, { scope: activeScope });
    if (result === undefined) return undefined;
    const loaded: LoopCheckpointRecord<T> = {
      result,
      revision: 1,
      fencingEpoch: 0,
      ...(activeScope ? { scope: activeScope } : {}),
    };
    options.records.set(cacheKey, loaded as LoopCheckpointRecord);
    return loaded;
  };
  const persist = async <T>(key: string, result: T, existing?: LoopCheckpointRecord<T>): Promise<LoopCheckpointRecord<T>> => {
    const store = requireStore();
    const activeScope = scope();
    const currentLease = leasePrecondition();
    const writeOptions: LoopCheckpointWriteOptions = {
      ...(activeScope ? { scope: activeScope } : {}),
      ...(existing ? { expectedRevision: existing.revision } : {}),
      ...(activeScope?.fencingEpoch === undefined
        ? (existing ? { fencingEpoch: existing.fencingEpoch } : {})
        : { fencingEpoch: activeScope.fencingEpoch }),
      ...(currentLease ? { leasePrecondition: currentLease } : {}),
    };
    const cacheKey = stateKey(key);
    if (store.compareAndSetCheckpoint) {
      const saved = await store.compareAndSetCheckpoint(options.conversationId, key, existing?.revision, result, writeOptions);
      options.records.set(cacheKey, saved as LoopCheckpointRecord);
      return saved;
    }
    await store.saveCheckpoint(options.conversationId, key, result, writeOptions);
    const saved = store.loadCheckpointRecord
      ? await store.loadCheckpointRecord<T>(options.conversationId, key, { scope: activeScope })
      : undefined;
    const fallback: LoopCheckpointRecord<T> = saved ?? {
      result,
      revision: (existing?.revision ?? 0) + 1,
      fencingEpoch: existing?.fencingEpoch ?? 0,
      ...(activeScope ? { scope: activeScope } : {}),
    };
    options.records.set(cacheKey, fallback as LoopCheckpointRecord);
    return fallback;
  };
  const requireAcceptedBinding = (): LoopScriptCheckpointBinding => {
    if (!binding) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'ctx.checkpoint requires the script to export checkpoint { id, version }',
        retryable: false,
      });
    }
    if (!binding.accepted) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `script checkpoint '${binding.identity.id}' was not accepted by script admission`,
        retryable: false,
      });
    }
    return binding;
  };
  const saveLatest = async (checkpoint: LoopScriptCheckpoint): Promise<void> => {
    const store = requireStore();
    const pointerKey = latestScriptCheckpointKey(checkpoint.identity, checkpoint.key);
    const activeScope = scope();
    const currentLease = leasePrecondition();
    const writeOptions: LoopCheckpointWriteOptions = {
      ...(activeScope?.fencingEpoch === undefined ? {} : { fencingEpoch: activeScope.fencingEpoch }),
      ...(currentLease ? { leasePrecondition: currentLease } : {}),
    };
    if (!store.compareAndSetCheckpoint || !store.loadCheckpointRecord) {
      await store.saveCheckpoint(options.conversationId, pointerKey, checkpoint, writeOptions);
      return;
    }
    // The pointer is a complete recovery record, not an authority over the
    // scoped value.  Saving the scoped value first makes an interrupted
    // pointer write recoverable; CAS makes concurrent pointer updates safe.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await store.loadCheckpointRecord<LoopScriptCheckpoint>(
        options.conversationId,
        pointerKey,
      );
      try {
        await store.compareAndSetCheckpoint(
          options.conversationId,
          pointerKey,
          existing?.revision,
          checkpoint,
          writeOptions,
        );
        return;
      } catch (error) {
        if (attempt === 7) throw error;
      }
    }
  };
  const repairLatest = async <T>(key: string, record: LoopCheckpointRecord<T>): Promise<void> => {
    const activeBinding = requireAcceptedBinding();
    const pointerKey = latestScriptCheckpointKey(activeBinding.identity, key);
    const latest = await requireStore().loadCheckpoint<unknown>(options.conversationId, pointerKey);
    // A durable current-scope record is the authority. A crash after it was
    // committed but before the pointer was acknowledged must be repaired
    // before a later script version considers migration. For this identity,
    // do not replace an equal-or-newer pointer revision.
    if (
      isLoopScriptCheckpoint(latest) && latest.key === key &&
      sameCheckpointIdentity(activeBinding.identity, latest.identity) && latest.revision >= record.revision
    ) {
      return;
    }
    await saveLatest({
      identity: activeBinding.identity,
      key,
      result: record.result,
      revision: record.revision,
      acceptedAt: Date.now(),
    });
  };
  const loadMigrated = async <T>(key: string): Promise<T | undefined> => {
    const activeBinding = requireAcceptedBinding();
    const latest = await requireStore().loadCheckpoint<unknown>(
      options.conversationId,
      latestScriptCheckpointKey(activeBinding.identity, key),
    );
    if (!isLoopScriptCheckpoint(latest) || latest.key !== key) return undefined;
    if (sameCheckpointIdentity(activeBinding.identity, latest.identity)) return latest.result as T;
    if (latest.identity.id !== activeBinding.identity.id || !activeBinding.migrate) {
      throw new LoopCheckpointIdentityMismatchError(activeBinding.identity, latest.identity);
    }
    const result = await activeBinding.migrate(latest) as T;
    let accepted: LoopCheckpointRecord<T>;
    try {
      accepted = await persist(key, result, await loadRecord<T>(key));
    } catch (error) {
      // Another recovery owner may have completed this exact migration after
      // our read. Its scoped record is authoritative; never replay a stale
      // conversion solely because the pointer update raced.
      const recovered = await loadRecord<T>(key, { refresh: true });
      if (!recovered) throw error;
      accepted = recovered;
    }
    const checkpoint: LoopScriptCheckpoint<T> = {
      identity: activeBinding.identity,
      key,
      // CAS may have lost to another recovery owner. The store's accepted
      // record is the sole source of truth; returning our local conversion
      // here would let two resumed processes observe different state.
      result: accepted.result,
      revision: accepted.revision,
      acceptedAt: Date.now(),
    };
    await saveLatest(checkpoint);
    options.onAccepted?.(checkpoint);
    return accepted.result;
  };

  return {
    bindScriptCheckpoint(nextBinding) {
      if (binding && !sameCheckpointIdentity(binding.identity, nextBinding.identity)) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: 'one loop runtime cannot bind two different script checkpoint identities',
          retryable: false,
        });
      }
      binding = nextBinding;
    },
    state: {
      get: async <T>(key: string) => {
        requireAcceptedBinding();
        const fullKey = stateKey(key);
        if (options.state.has(fullKey)) return options.state.get(fullKey) as T | undefined;
        const record = await loadRecord<T>(`state:${key}`);
        options.state.set(fullKey, record?.result);
        return record?.result;
      },
      set: async (key, value) =>
        withLock(stateKey(key), async () => {
          requireAcceptedBinding();
          await persist(`state:${key}`, value, await loadRecord(`state:${key}`));
          options.state.set(stateKey(key), value);
        }),
      update: async (key, updater) =>
        withLock(stateKey(key), async () => {
          requireAcceptedBinding();
          const record = await loadRecord(`state:${key}`);
          const result = updater(record?.result);
          await persist(`state:${key}`, result, record);
          options.state.set(stateKey(key), result);
        }),
    },
    checkpoint: async (key, result) =>
      withLock(stateKey(`checkpoint:${key}`), async () => {
        const activeBinding = requireAcceptedBinding();
        const accepted = await persist(key, result, await loadRecord(key));
        const checkpoint: LoopScriptCheckpoint = {
          identity: activeBinding.identity,
          key,
          result,
          revision: accepted.revision,
          acceptedAt: Date.now(),
        };
        await saveLatest(checkpoint);
        options.state.set(stateKey(`checkpoint:${key}`), result);
        options.onAccepted?.(checkpoint);
      }),
    loadCheckpoint: async <T>(key: string) =>
      // Migration is stateful per durable business key. Serializing it with
      // ordinary checkpoint writes prevents sibling runners in this process
      // from invoking a converter twice between the read and its CAS.
      withLock(stateKey(`checkpoint:${key}`), async () => {
        requireAcceptedBinding();
        const memoryKey = stateKey(`checkpoint:${key}`);
        if (options.state.has(memoryKey)) return options.state.get(memoryKey) as T | undefined;
        const current = await loadRecord<T>(key);
        if (current) await repairLatest(key, current);
        const result = current?.result ?? await loadMigrated<T>(key);
        options.state.set(memoryKey, result);
        return result;
      }),
  };
}
