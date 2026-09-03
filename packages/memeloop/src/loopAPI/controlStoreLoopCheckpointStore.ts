import { canonicalJsonBytes } from '../encoding/canonicalJson.js';
import type { OrchestrationResource, OrchestrationResourceManifest } from '../orchestration/client.js';
import type { ControlStore, ControlStoreActor } from '../orchestration/controlStore.js';
import { OrchestrationError } from '../orchestration/errors.js';
import {
  LOOP_CHECKPOINT_API_VERSION,
  type LoopCheckpointRecord,
  type LoopCheckpointScope,
  type LoopCheckpointWriteOptions,
  type LoopScriptCheckpointStore,
  scopedLoopCheckpointKey,
} from './types.js';

export const LOOP_CHECKPOINT_KIND = 'LoopCheckpoint';

export interface LoopCheckpointSpec {
  conversationId: string;
  key: string;
  result: unknown;
  /** SHA-256 hex digest of the serialised result. Verified on load. */
  digest: string;
  createdAt: string;
  /** Monotonic value used by typed compare-and-set mutations. */
  revision?: number;
  /** Monotonic writer fence; stale epochs are rejected. */
  fencingEpoch?: number;
}

export type LoopCheckpointResource = OrchestrationResource<LoopCheckpointSpec>;

function checkpointName(key: string): string {
  return encodeURIComponent(key);
}

async function computeDigest(data: unknown): Promise<string> {
  const encoded = canonicalJsonBytes(data, {
    maxBytes: 4 * 1024 * 1024,
    maxDepth: 32,
    maxNodes: 200_000,
    maxStringBytes: 4 * 1024 * 1024,
    maxStringCodeUnits: 4 * 1024 * 1024,
  });
  const digestInput = new Uint8Array(encoded.byteLength);
  digestInput.set(encoded);
  const hash = await crypto.subtle.digest('SHA-256', digestInput);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createControlStoreLoopCheckpointStore(
  store: ControlStore,
  actor: ControlStoreActor,
  now: () => Date = () => new Date(),
): LoopScriptCheckpointStore {
  const loadCheckpointRecord = async <T>(
    conversationId: string,
    key: string,
    options?: { scope?: LoopCheckpointScope },
  ): Promise<LoopCheckpointRecord<T> | undefined> => {
    const namespacedKey = scopedLoopCheckpointKey(key, options?.scope);
    const checkpoint = await store.get<LoopCheckpointSpec>({
      apiVersion: LOOP_CHECKPOINT_API_VERSION,
      kind: LOOP_CHECKPOINT_KIND,
      namespace: conversationId,
      name: checkpointName(namespacedKey),
    });
    if (!checkpoint) return undefined;
    const expectedDigest = checkpoint.spec.digest;
    const actualDigest = await computeDigest(checkpoint.spec.result);
    if (actualDigest !== expectedDigest) return undefined;
    return {
      result: structuredClone(checkpoint.spec.result) as T,
      revision: checkpoint.spec.revision ?? 1,
      fencingEpoch: checkpoint.spec.fencingEpoch ?? 0,
      ...(options?.scope ? { scope: structuredClone(options.scope) } : {}),
    };
  };
  const saveCheckpoint = async (conversationId: string, key: string, result: unknown, options: LoopCheckpointWriteOptions = {}): Promise<void> => {
    const namespacedKey = scopedLoopCheckpointKey(key, options.scope);
    const reference = {
      apiVersion: LOOP_CHECKPOINT_API_VERSION,
      kind: LOOP_CHECKPOINT_KIND,
      namespace: conversationId,
      name: checkpointName(namespacedKey),
    };
    const cloned = structuredClone(result);
    const digest = await computeDigest(cloned);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await store.get<LoopCheckpointSpec>(reference);
      const currentRevision = existing?.spec.revision ?? 0;
      const currentFence = existing?.spec.fencingEpoch ?? 0;
      const requestedFence = options.fencingEpoch ?? currentFence;
      if (requestedFence < currentFence) {
        throw new OrchestrationError({
          code: 'STALE_EPOCH',
          message: `loop checkpoint '${key}' is fenced by a newer writer`,
          retryable: false,
        });
      }
      if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: `loop checkpoint '${key}' revision ${currentRevision} does not match expected ${options.expectedRevision}`,
          retryable: true,
        });
      }
      if (existing?.spec.digest === digest && requestedFence === currentFence) return;
      const manifest: OrchestrationResourceManifest<LoopCheckpointSpec> = {
        apiVersion: LOOP_CHECKPOINT_API_VERSION,
        kind: LOOP_CHECKPOINT_KIND,
        metadata: { namespace: conversationId, name: checkpointName(namespacedKey) },
        spec: {
          conversationId,
          key: namespacedKey,
          result: cloned,
          digest,
          createdAt: existing?.spec.createdAt ?? now().toISOString(),
          revision: currentRevision + 1,
          fencingEpoch: requestedFence,
        },
      };
      try {
        if (existing) {
          await store.apply(actor, manifest, {
            resourceVersion: existing.metadata.resourceVersion,
            idempotencyKey: `loop-checkpoint:${conversationId}:${namespacedKey}:${digest}`,
          });
        } else {
          await store.create(actor, manifest, {
            idempotencyKey: `loop-checkpoint:${conversationId}:${namespacedKey}:${digest}`,
          });
        }
        return;
      } catch (error) {
        if (!(error instanceof OrchestrationError) || error.code !== 'CONFLICT') throw error;
      }
    }
    throw new OrchestrationError({
      code: 'CONFLICT',
      message: `loop checkpoint '${key}' changed too frequently to save`,
      retryable: true,
    });
  };

  return {
    saveCheckpoint,

    async loadCheckpoint<T>(conversationId: string, key: string, options?: { scope?: LoopCheckpointScope }): Promise<T | undefined> {
      const record = await loadCheckpointRecord<T>(conversationId, key, options);
      return record?.result;
    },

    loadCheckpointRecord,

    async compareAndSetCheckpoint<T>(conversationId: string, key: string, expectedRevision: number | undefined, result: T, options = {}): Promise<LoopCheckpointRecord<T>> {
      await saveCheckpoint(conversationId, key, result, { ...options, expectedRevision });
      const record = await loadCheckpointRecord<T>(conversationId, key, options);
      if (!record) {
        throw new OrchestrationError({
          code: 'UNKNOWN_EFFECT',
          message: `loop checkpoint '${key}' was saved but could not be reloaded`,
          retryable: true,
        });
      }
      return record;
    },
  };
}
