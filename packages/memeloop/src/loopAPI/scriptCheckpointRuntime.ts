import { OrchestrationError } from '../orchestration/errors.js';
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
  onAccepted?: (checkpoint: LoopScriptCheckpoint) => void;
}

function checkpointScopeFromIdentity(identity: LoopScriptCheckpointIdentity): LoopCheckpointScope {
  return {
    scriptDigest: identity.scriptDigest,
    apiVersion: identity.apiVersion,
    schemaVersion: identity.schemaVersion,
    checkpointId: identity.id,
    scriptVersion: identity.scriptVersion,
    profileVersion: identity.profileVersion,
    ...(identity.runId ? { runId: identity.runId } : {}),
  };
}

function latestScriptCheckpointKey(identity: Pick<LoopScriptCheckpointIdentity, 'id' | 'runId'>): string {
  return `${SCRIPT_CHECKPOINT_LATEST_PREFIX}${encodeURIComponent(identity.id)}:${encodeURIComponent(identity.runId ?? '')}`;
}

function sameCheckpointIdentity(left: LoopScriptCheckpointIdentity, right: LoopScriptCheckpointIdentity): boolean {
  return left.id === right.id &&
    left.scriptVersion === right.scriptVersion &&
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
  const stateKey = (key: string): string => `${options.conversationId}:${key}`;
  let binding: LoopScriptCheckpointBinding | undefined;
  const scope = (): LoopCheckpointScope | undefined => binding ? checkpointScopeFromIdentity(binding.identity) : options.fallbackScope;
  const requireStore = (): LoopCheckpointStore => {
    if (options.store) return options.store;
    throw new OrchestrationError({
      code: 'UNSUPPORTED',
      message: 'durable loop checkpoint store is required for script state and checkpoints',
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
  const loadRecord = async <T>(key: string): Promise<LoopCheckpointRecord<T> | undefined> => {
    const store = requireStore();
    const cacheKey = stateKey(key);
    const cached = options.records.get(cacheKey) as LoopCheckpointRecord<T> | undefined;
    if (cached) return cached;
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
    const writeOptions: LoopCheckpointWriteOptions = {
      ...(activeScope ? { scope: activeScope } : {}),
      ...(existing ? { expectedRevision: existing.revision, fencingEpoch: existing.fencingEpoch } : {}),
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
  const loadMigrated = async <T>(key: string): Promise<T | undefined> => {
    const activeBinding = requireAcceptedBinding();
    const latest = await requireStore().loadCheckpoint<unknown>(
      options.conversationId,
      latestScriptCheckpointKey(activeBinding.identity),
    );
    if (!isLoopScriptCheckpoint(latest) || latest.key !== key) return undefined;
    if (sameCheckpointIdentity(activeBinding.identity, latest.identity)) return latest.result as T;
    if (latest.identity.id !== activeBinding.identity.id || !activeBinding.migrate) {
      throw new LoopCheckpointIdentityMismatchError(activeBinding.identity, latest.identity);
    }
    const result = await activeBinding.migrate(latest) as T;
    const accepted = await persist(key, result, await loadRecord<T>(key));
    const checkpoint: LoopScriptCheckpoint<T> = {
      identity: activeBinding.identity,
      key,
      result,
      revision: accepted.revision,
      acceptedAt: Date.now(),
    };
    await requireStore().saveCheckpoint(options.conversationId, latestScriptCheckpointKey(activeBinding.identity), checkpoint);
    options.onAccepted?.(checkpoint);
    return result;
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
        await requireStore().saveCheckpoint(options.conversationId, latestScriptCheckpointKey(activeBinding.identity), checkpoint);
        options.state.set(stateKey(`checkpoint:${key}`), result);
        options.onAccepted?.(checkpoint);
      }),
    loadCheckpoint: async <T>(key: string) => {
      requireAcceptedBinding();
      const memoryKey = stateKey(`checkpoint:${key}`);
      if (options.state.has(memoryKey)) return options.state.get(memoryKey) as T | undefined;
      const result = (await loadRecord<T>(key))?.result ?? await loadMigrated<T>(key);
      options.state.set(memoryKey, result);
      return result;
    },
  };
}
