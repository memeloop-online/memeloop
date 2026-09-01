import { canonicalJsonBytes } from '../encoding/canonicalJson.js';
import type { OrchestrationResource, OrchestrationResourceManifest } from '../orchestration/client.js';
import type { ControlStore, ControlStoreActor } from '../orchestration/controlStore.js';
import { OrchestrationError } from '../orchestration/errors.js';
import type { LoopScriptCheckpointStore } from './types.js';

export const LOOP_CHECKPOINT_API_VERSION = 'loops.memeloop.io/v1alpha1';
export const LOOP_CHECKPOINT_KIND = 'LoopCheckpoint';

export interface LoopCheckpointSpec {
  conversationId: string;
  key: string;
  result: unknown;
  /** SHA-256 hex digest of the serialised result. Verified on load. */
  digest: string;
  createdAt: string;
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
  return {
    async saveCheckpoint(conversationId, key, result) {
      const reference = {
        apiVersion: LOOP_CHECKPOINT_API_VERSION,
        kind: LOOP_CHECKPOINT_KIND,
        namespace: conversationId,
        name: checkpointName(key),
      };
      const cloned = structuredClone(result);
      const digest = await computeDigest(cloned);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const existing = await store.get<LoopCheckpointSpec>(reference);
        if (existing?.spec.digest === digest) return;
        const manifest: OrchestrationResourceManifest<LoopCheckpointSpec> = {
          apiVersion: LOOP_CHECKPOINT_API_VERSION,
          kind: LOOP_CHECKPOINT_KIND,
          metadata: { namespace: conversationId, name: checkpointName(key) },
          spec: {
            conversationId,
            key,
            result: cloned,
            digest,
            createdAt: existing?.spec.createdAt ?? now().toISOString(),
          },
        };
        try {
          if (existing) {
            await store.apply(actor, manifest, {
              resourceVersion: existing.metadata.resourceVersion,
              idempotencyKey: `loop-checkpoint:${conversationId}:${key}:${digest}`,
            });
          } else {
            await store.create(actor, manifest, {
              idempotencyKey: `loop-checkpoint:${conversationId}:${key}:${digest}`,
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
    },

    async loadCheckpoint<T>(conversationId: string, key: string): Promise<T | undefined> {
      const checkpoint = await store.get<LoopCheckpointSpec>({
        apiVersion: LOOP_CHECKPOINT_API_VERSION,
        kind: LOOP_CHECKPOINT_KIND,
        namespace: conversationId,
        name: checkpointName(key),
      });
      if (!checkpoint) return undefined;
      const expectedDigest = checkpoint.spec.digest;
      const actualDigest = await computeDigest(checkpoint.spec.result);
      if (actualDigest !== expectedDigest) return undefined;
      return structuredClone(checkpoint.spec.result) as T;
    },
  };
}
