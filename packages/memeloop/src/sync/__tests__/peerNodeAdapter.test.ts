import { describe, expect, it, vi } from 'vitest';

import { PeerNodeSyncAdapter, type PeerNodeTransport } from '../peerNodeAdapter.js';

describe('PeerNodeSyncAdapter', () => {
  it('delegates calls to transport', async () => {
    const transport: PeerNodeTransport = {
      nodeId: 'A',
      exchangeVersionVector: vi.fn().mockResolvedValue({
        remoteVersion: { A: 1 },
        missingForRemote: [],
        missingForLocal: [],
      }),
      pullMissingMetadata: vi.fn().mockResolvedValue({ items: [] }),
    };

    const adapter = new PeerNodeSyncAdapter('B', transport);

    const res = await adapter.exchangeVersionVector({ B: 2 });
    expect(transport.exchangeVersionVector).toHaveBeenCalledWith('B', { B: 2 });
    expect(res.remoteVersion).toEqual({ A: 1 });

    await adapter.pullMissingMetadata({ B: 2 });
    expect(transport.pullMissingMetadata).toHaveBeenCalledWith('B', { B: 2 }, undefined);
  });
});
