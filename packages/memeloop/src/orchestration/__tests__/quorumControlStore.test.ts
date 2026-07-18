import { describe, expect, it } from 'vitest';

import { QuorumControlStore } from '../quorumControlStore.js';

describe('QuorumControlStore', () => {
  it('creates instance with default namespace', () => {
    const store = new QuorumControlStore({ endpoints: ['localhost:2379'] });
    expect(store).toBeInstanceOf(QuorumControlStore);
  });

  it('creates instance with custom namespace', () => {
    const store = new QuorumControlStore({
      endpoints: ['localhost:2379'],
      namespace: '/custom',
    });
    expect(store).toBeInstanceOf(QuorumControlStore);
  });

  it('throws not implemented for get', async () => {
    const store = new QuorumControlStore({ endpoints: ['localhost:2379'] });
    await expect(
      store.get({ apiVersion: 'v1', kind: 'Test', name: 'test' }),
    ).rejects.toThrow('QuorumControlStore.get not implemented');
  });

  it('throws not implemented for list', async () => {
    const store = new QuorumControlStore({ endpoints: ['localhost:2379'] });
    await expect(
      store.list({ kind: 'Test' }),
    ).rejects.toThrow('QuorumControlStore.list not implemented');
  });

  it('throws not implemented for create', async () => {
    const store = new QuorumControlStore({ endpoints: ['localhost:2379'] });
    await expect(
      store.create(
        { id: 'admin', kind: 'admin' },
        { apiVersion: 'v1', kind: 'Test', metadata: { name: 'test' }, spec: {} },
      ),
    ).rejects.toThrow('QuorumControlStore.create not implemented');
  });

  it('throws not implemented for acquireLease', async () => {
    const store = new QuorumControlStore({ endpoints: ['localhost:2379'] });
    await expect(
      store.acquireLease(
        { id: 'controller', kind: 'controller' },
        { name: 'test-lease', holder: 'controller', ttlMs: 10000 },
      ),
    ).rejects.toThrow('QuorumControlStore.acquireLease not implemented');
  });

  it('throws not implemented for getTopology', async () => {
    const store = new QuorumControlStore({ endpoints: ['localhost:2379'] });
    await expect(store.getTopology()).rejects.toThrow('QuorumControlStore.getTopology not implemented');
  });

  it('throws not implemented for addVoter', async () => {
    const store = new QuorumControlStore({ endpoints: ['localhost:2379'] });
    await expect(
      store.addVoter({ id: 'member-1', peerUrls: ['http://localhost:2380'], clientUrls: ['http://localhost:2379'], isLearner: false }),
    ).rejects.toThrow('QuorumControlStore.addVoter not implemented');
  });
});
