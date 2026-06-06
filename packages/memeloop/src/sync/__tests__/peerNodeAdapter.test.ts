import { describe, expect, it, vi } from 'vitest';

import type { ConversationMeta } from '../../sync/protocol.js';

import { PeerNodeSyncAdapter, type PeerNodeTransport } from '../peerNodeAdapter.js';

describe('PeerNodeSyncAdapter', () => {
  it('delegates calls to transport', async () => {
    const transport: PeerNodeTransport = {
      nodeId: 'A',
      exchangeVersionVector: vi.fn().mockResolvedValue({
        remoteVersion: { A: 1 },
        missingForRemote: [] as ConversationMeta[],
      }),
      pullMissingMetadata: vi.fn().mockResolvedValue([]),
    };

    const adapter = new PeerNodeSyncAdapter('B', transport);

    const res = await adapter.exchangeVersionVector({ B: 2 });
    expect(transport.exchangeVersionVector).toHaveBeenCalledWith('B', { B: 2 });
    expect(res.remoteVersion).toEqual({ A: 1 });

    await adapter.pullMissingMetadata({ B: 2 });
    expect(transport.pullMissingMetadata).toHaveBeenCalledWith('B', { B: 2 });
  });
});
