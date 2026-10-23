import { describe, expect, it } from 'vitest';

import type { ControlStore } from '../controlStore.js';
import { createModelEndpointRegistrar } from '../drivers/modelEndpointRegistrar.js';
import type { ModelProviderDriver } from '../drivers/modelProviderDriver.js';
import { MODEL_CLASS_API_VERSION, MODEL_CLASS_KIND, MODEL_ENDPOINT_API_VERSION, MODEL_ENDPOINT_KIND, type ModelClassSpec, type ModelEndpointResource } from '../resources.js';
import { QuorumControlStore } from '../stores/quorumControlStore.js';

const ACTOR = { id: 'controller/model-registrar-node-a', kind: 'controller' as const };

function createStore(): ControlStore {
  return new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
}

interface FakeDriverState {
  models: ModelClassSpec[];
  healthy: boolean;
  listError?: Error;
}

function fakeDriver(state: FakeDriverState): ModelProviderDriver {
  return {
    async listModels() {
      if (state.listError) throw state.listError;
      return state.models;
    },
    async getHealth() {
      return { healthy: state.healthy, checkedAt: '2026-07-22T00:00:00.000Z' };
    },
    async *generate() {
      yield { type: 'done' as const };
    },
  };
}

const CHAT_MODEL: ModelClassSpec = { provider: 'ollama', model: 'qwen2.5:7b', digest: 'sha256:w1', modalities: ['text'] };
const EMBED_MODEL: ModelClassSpec = { provider: 'ollama', model: 'nomic-embed-text', digest: 'sha256:w2', modalities: ['embedding'] };

async function listEndpoints(store: ControlStore): Promise<ModelEndpointResource[]> {
  const result = await store.list<ModelEndpointResource['spec']>({
    apiVersion: MODEL_ENDPOINT_API_VERSION,
    kind: MODEL_ENDPOINT_KIND,
  });
  return result.items.map((item) => item as unknown as ModelEndpointResource);
}

describe('createModelEndpointRegistrar', () => {
  it('registers ModelClass and ModelEndpoint resources with healthy status and heartbeat', async () => {
    const store = createStore();
    const registrar = createModelEndpointRegistrar(store, fakeDriver({ models: [CHAT_MODEL], healthy: true }), {
      actor: ACTOR,
      advertisement: { nodeId: 'node-a', trust: 'restricted', capacity: { maxConcurrent: 2 } },
      autoStart: false,
      now: () => new Date('2026-07-22T10:00:00.000Z'),
    });

    await registrar.refresh();

    const classes = await store.list({ apiVersion: MODEL_CLASS_API_VERSION, kind: MODEL_CLASS_KIND });
    expect(classes.items).toHaveLength(1);
    expect(classes.items[0].spec).toMatchObject({ provider: 'ollama', model: 'qwen2.5:7b', digest: 'sha256:w1' });

    const endpoints = await listEndpoints(store);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].spec.nodeId).toBe('node-a');
    expect(endpoints[0].spec.trust).toBe('restricted');
    expect(endpoints[0].status?.healthy).toBe(true);
    expect(endpoints[0].status?.heartbeat).toBe('2026-07-22T10:00:00.000Z');
  });

  it('refreshes heartbeat and health on subsequent ticks', async () => {
    const store = createStore();
    const state: FakeDriverState = { models: [CHAT_MODEL], healthy: true };
    let tick = 0;
    const timestamps = ['2026-07-22T10:00:00.000Z', '2026-07-22T10:00:30.000Z'];
    const registrar = createModelEndpointRegistrar(store, fakeDriver(state), {
      actor: ACTOR,
      advertisement: { nodeId: 'node-a', trust: 'restricted' },
      autoStart: false,
      now: () => new Date(timestamps[Math.min(tick, timestamps.length - 1)]),
    });

    await registrar.refresh();
    tick += 1;
    state.healthy = false;
    await registrar.refresh();

    const endpoints = await listEndpoints(store);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].status?.healthy).toBe(false);
    expect(endpoints[0].status?.heartbeat).toBe('2026-07-22T10:00:30.000Z');
  });

  it('deletes endpoints the driver stops serving', async () => {
    const store = createStore();
    const state: FakeDriverState = { models: [CHAT_MODEL, EMBED_MODEL], healthy: true };
    const registrar = createModelEndpointRegistrar(store, fakeDriver(state), {
      actor: ACTOR,
      advertisement: { nodeId: 'node-a', trust: 'trusted' },
      autoStart: false,
    });

    await registrar.refresh();
    expect(await listEndpoints(store)).toHaveLength(2);

    state.models = [CHAT_MODEL];
    await registrar.refresh();

    const endpoints = await listEndpoints(store);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].spec.modelClassRef.name).toBe('ollama-qwen2.5-7b');
  });

  it('marks owned endpoints unhealthy when the driver cannot be interrogated', async () => {
    const store = createStore();
    const state: FakeDriverState = { models: [CHAT_MODEL], healthy: true };
    const errors: unknown[] = [];
    const registrar = createModelEndpointRegistrar(store, fakeDriver(state), {
      actor: ACTOR,
      advertisement: { nodeId: 'node-a', trust: 'trusted' },
      autoStart: false,
      onError: (error) => errors.push(error),
    });

    await registrar.refresh();
    expect((await listEndpoints(store))[0].status?.healthy).toBe(true);

    state.listError = new Error('driver crashed');
    await registrar.refresh();

    expect(errors).toHaveLength(1);
    const endpoints = await listEndpoints(store);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].status?.healthy).toBe(false);
  });

  it('stop marks owned endpoints unhealthy and prevents further refresh writes', async () => {
    const store = createStore();
    const registrar = createModelEndpointRegistrar(store, fakeDriver({ models: [CHAT_MODEL], healthy: true }), {
      actor: ACTOR,
      advertisement: { nodeId: 'node-a', trust: 'trusted' },
      autoStart: false,
    });

    await registrar.refresh();
    await registrar.stop();

    const endpoints = await listEndpoints(store);
    expect(endpoints[0].status?.healthy).toBe(false);
  });

  it('autoStart performs an initial registration without manual refresh', async () => {
    const store = createStore();
    const registrar = createModelEndpointRegistrar(store, fakeDriver({ models: [CHAT_MODEL], healthy: true }), {
      actor: ACTOR,
      advertisement: { nodeId: 'node-a', trust: 'trusted' },
      // Park the loop after the first tick; stop() must not wait on sleep.
      sleep: () => new Promise<void>(() => {}),
    });

    for (let attempt = 0; attempt < 50 && (await listEndpoints(store)).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const endpoints = await listEndpoints(store);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].status?.healthy).toBe(true);

    await registrar.stop();
    expect((await listEndpoints(store))[0].status?.healthy).toBe(false);
  });
});
