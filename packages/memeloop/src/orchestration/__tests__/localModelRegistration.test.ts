import { describe, expect, it } from 'vitest';

import { describeLocalModelEndpoints, type SelectableModelEndpoint, selectModelEndpoint } from '../localModelRegistration.js';
import type { ModelProviderDriver } from '../modelProviderDriver.js';
import { MODEL_CLASS_KIND } from '../resources.js';

function fakeDriver(): ModelProviderDriver {
  return {
    async listModels() {
      return [
        {
          provider: 'ollama',
          model: 'qwen2.5:7b',
          digest: 'sha256:w1',
          modalities: ['text'],
          contextWindow: 32_768,
          capabilities: { streaming: true },
          dataResidency: 'local',
        },
        {
          provider: 'ollama',
          model: 'nomic-embed-text',
          digest: 'sha256:w2',
          modalities: ['embedding'],
        },
      ];
    },
    async getHealth() {
      return { healthy: true, detail: 'ok', checkedAt: '2026-07-16T00:00:00.000Z' };
    },
    async *generate() {
      yield { type: 'done' as const };
    },
  };
}

describe('describeLocalModelEndpoints', () => {
  it('advertises ModelClass and ModelEndpoint manifests with digest, trust, capacity, and data policy', async () => {
    const advertisement = await describeLocalModelEndpoints(fakeDriver(), {
      nodeId: 'node-a',
      trust: 'restricted',
      capacity: { maxConcurrent: 2, tokensPerMinute: 20_000 },
      dataPolicy: { classification: 'internal', retention: 'none' },
    });

    expect(advertisement.health.healthy).toBe(true);
    expect(advertisement.modelClasses).toHaveLength(2);
    expect(advertisement.endpoints).toHaveLength(2);

    const [chatClass] = advertisement.modelClasses;
    expect(chatClass.spec.provider).toBe('ollama');
    expect(chatClass.spec.model).toBe('qwen2.5:7b');
    expect(chatClass.spec.digest).toBe('sha256:w1');
    expect(chatClass.spec.modalities).toEqual(['text']);

    const [chatEndpoint] = advertisement.endpoints;
    expect(chatEndpoint.spec.modelClassRef.kind).toBe(MODEL_CLASS_KIND);
    expect(chatEndpoint.spec.modelClassRef.name).toBe(chatClass.metadata.name);
    expect(chatEndpoint.spec.modelDigest).toBe('sha256:w1');
    expect(chatEndpoint.spec.nodeId).toBe('node-a');
    expect(chatEndpoint.spec.trust).toBe('restricted');
    expect(chatEndpoint.spec.endpoint).toBe('local://node-a/ollama/qwen2.5:7b');
    expect(chatEndpoint.spec.endpoint).not.toContain('api_key');
    expect(chatEndpoint.spec.capacity).toEqual({ maxConcurrent: 2, tokensPerMinute: 20_000 });
    expect(chatEndpoint.spec.dataPolicy).toEqual({ classification: 'internal', retention: 'none' });
  });
});

describe('selectModelEndpoint', () => {
  function endpoint(
    name: string,
    className: string,
    overrides: Partial<SelectableModelEndpoint['manifest']['spec']> = {},
    healthy = true,
  ): SelectableModelEndpoint {
    return {
      manifest: {
        apiVersion: 'models.memeloop.io/v1alpha1',
        kind: 'ModelEndpoint',
        metadata: { name },
        spec: {
          modelClassRef: { apiVersion: 'models.memeloop.io/v1alpha1', kind: 'ModelClass', name: className },
          endpoint: `local://node/${name}`,
          ...overrides,
        },
      },
      status: { healthy },
    };
  }

  it('selects by class name and prefers the highest capacity', () => {
    const selected = selectModelEndpoint([
      endpoint('small', 'chat', { capacity: { maxConcurrent: 1 } }),
      endpoint('large', 'chat', { capacity: { maxConcurrent: 8 } }),
      endpoint('other', 'embed'),
    ], { modelClassName: 'chat' });

    expect(selected?.metadata.name).toBe('large');
  });

  it('requires digest match when specified', () => {
    const selected = selectModelEndpoint([
      endpoint('a', 'chat', { modelDigest: 'sha256:old' }),
      endpoint('b', 'chat', { modelDigest: 'sha256:new' }),
    ], { modelClassName: 'chat', modelDigest: 'sha256:new' });

    expect(selected?.metadata.name).toBe('b');
  });

  it('excludes endpoints below the required trust', () => {
    const selected = selectModelEndpoint([
      endpoint('q', 'chat', { trust: 'quarantine' }),
      endpoint('r', 'chat', { trust: 'restricted' }),
    ], { modelClassName: 'chat', minimumTrust: 'restricted' });

    expect(selected?.metadata.name).toBe('r');
  });

  it('excludes unhealthy endpoints by default and honors minConcurrent', () => {
    const endpoints = [
      endpoint('sick', 'chat', { capacity: { maxConcurrent: 8 } }, false),
      endpoint('healthy-small', 'chat', { capacity: { maxConcurrent: 1 } }),
    ];

    expect(selectModelEndpoint(endpoints, { modelClassName: 'chat' })?.metadata.name).toBe('healthy-small');
    expect(selectModelEndpoint(endpoints, { modelClassName: 'chat', minConcurrent: 4 })).toBeNull();
  });

  it('returns null when nothing qualifies instead of falling back silently', () => {
    expect(selectModelEndpoint([], { modelClassName: 'chat' })).toBeNull();
    expect(selectModelEndpoint([endpoint('a', 'embed')], { modelClassName: 'chat' })).toBeNull();
  });
});
