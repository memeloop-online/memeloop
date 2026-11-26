import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { createIndexedDatabaseResourceCache } from '../indexedDatabaseResourceCache.js';

function resource(name: string, revision: string, labels?: Record<string, string>) {
  return {
    apiVersion: 'workload.memeloop.io/v1alpha1',
    kind: 'AgentRun',
    metadata: {
      name,
      namespace: 'games',
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: revision,
      creationTimestamp: '2026-07-23T00:00:00.000Z',
      labels,
    },
    spec: { workloadRef: { kind: 'AgentWorkload', name } },
  };
}

describe('IndexedDB resource cache', () => {
  it('stores isolated snapshots and queries namespace and labels', async () => {
    const cache = createIndexedDatabaseResourceCache({
      indexedDB: new IDBFactory(),
      databaseName: 'query-test',
    });
    const first = resource('one', '7', { suite: 'game' });
    await cache.put(first);
    await cache.put(resource('two', '9', { suite: 'web' }));
    first.spec.workloadRef.name = 'mutated-after-put';

    await expect(cache.get({
      apiVersion: first.apiVersion,
      kind: first.kind,
      namespace: 'games',
      name: 'one',
    })).resolves.toMatchObject({
      spec: { workloadRef: { name: 'one' } },
    });
    await expect(cache.list({
      kind: 'AgentRun',
      namespace: 'games',
      labels: { suite: 'game' },
    })).resolves.toMatchObject({
      resourceVersion: '7',
      items: [{ metadata: { name: 'one' } }],
    });
    cache.close();
  });

  it('removes individual entries, clears the store, and rejects use after close', async () => {
    const cache = createIndexedDatabaseResourceCache({
      indexedDB: new IDBFactory(),
      databaseName: 'lifecycle-test',
    });
    const first = resource('one', '1');
    const reference = {
      apiVersion: first.apiVersion,
      kind: first.kind,
      namespace: 'games',
      name: 'one',
    };
    await cache.put(first);
    await cache.remove(reference);
    await expect(cache.get(reference)).resolves.toBeNull();
    await cache.put(resource('two', '2'));
    await cache.clear();
    await expect(cache.list({ kind: 'AgentRun' })).resolves.toMatchObject({
      items: [],
    });
    cache.close();
    await expect(cache.list({ kind: 'AgentRun' })).rejects.toThrow('closed');
  });
});
