import type { LoopScriptCheckpointStore } from '../loopAPI/types.js';
import type { OrchestrationResource, OrchestrationResourceManifest } from './client.js';
import type { ControlStore, ControlStoreActor } from './controlStore.js';
import { OrchestrationError } from './errors.js';

export const LOOP_CHECKPOINT_API_VERSION = 'loops.memeloop.io/v1alpha1';
export const LOOP_CHECKPOINT_KIND = 'LoopCheckpoint';

export interface LoopCheckpointSpec {
  conversationId: string;
  key: string;
  result: unknown;
  createdAt: string;
}

export type LoopCheckpointResource = OrchestrationResource<LoopCheckpointSpec>;

function checkpointName(key: string): string {
  return encodeURIComponent(key);
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
      const existing = await store.get<LoopCheckpointSpec>(reference);
      if (existing) return;
      const manifest: OrchestrationResourceManifest<LoopCheckpointSpec> = {
        apiVersion: LOOP_CHECKPOINT_API_VERSION,
        kind: LOOP_CHECKPOINT_KIND,
        metadata: { namespace: conversationId, name: checkpointName(key) },
        spec: { conversationId, key, result: structuredClone(result), createdAt: now().toISOString() },
      };
      try {
        await store.create(actor, manifest, { idempotencyKey: `loop-checkpoint:${conversationId}:${key}` });
      } catch (error) {
        if (!(error instanceof OrchestrationError) || error.code !== 'CONFLICT') throw error;
      }
    },

    async loadCheckpoint<T>(conversationId: string, key: string): Promise<T | undefined> {
      const checkpoint = await store.get<LoopCheckpointSpec>({
        apiVersion: LOOP_CHECKPOINT_API_VERSION,
        kind: LOOP_CHECKPOINT_KIND,
        namespace: conversationId,
        name: checkpointName(key),
      });
      return checkpoint ? structuredClone(checkpoint.spec.result) as T : undefined;
    },
  };
}
