import { describe, expect, it, vi } from 'vitest';

import type { ConversationEvent } from '../../conversation/index.js';
import { PeerNodeSyncAdapter, type PeerNodeTransport } from '../peerNodeAdapter.js';

describe('PeerNodeSyncAdapter', () => {
  it('delegates raw event and attachment calls with cancellation', async () => {
    const exchangeVersionFrontierPage = vi.fn().mockResolvedValue({
      remotePage: { items: [] },
      missingForRemote: [],
    });
    const pullMissingEvents = vi.fn().mockResolvedValue({ items: [] });
    const pushEvents = vi.fn().mockResolvedValue(undefined);
    const pullAttachmentChunk = vi.fn().mockResolvedValue(null);
    const pushAttachmentChunk = vi.fn().mockResolvedValue(undefined);
    const transport: PeerNodeTransport = {
      nodeId: 'A',
      exchangeVersionFrontierPage,
      pullMissingEvents,
      pushEvents,
      pullAttachmentChunk,
      pushAttachmentChunk,
    };
    const signal = new AbortController().signal;
    const adapter = new PeerNodeSyncAdapter('B', transport);
    const frontiers = [{
      conversationId: 'conversation',
      originNodeId: 'A',
      maxContiguousOriginSequence: 1,
    }];
    const ranges = [{
      conversationId: 'conversation',
      originNodeId: 'A',
      fromExclusive: 0,
      toInclusive: 1,
    }];
    const events: ConversationEvent[] = [];

    await adapter.exchangeVersionFrontierPage(
      frontiers,
      undefined,
      true,
      ['conversation'],
      { signal },
    );
    await adapter.pullMissingEvents('conversation', ranges, undefined, { signal });
    await adapter.pushEvents(events, { signal });
    await adapter.pullAttachmentChunk('conversation', 'hash', 0, 1024, { signal });
    await adapter.pushAttachmentChunk('conversation', 'hash', {
      data: new Uint8Array(),
      offset: 0,
      totalSize: 0,
      done: true,
      filename: 'a',
      mimeType: 'text/plain',
    }, { signal });

    expect(exchangeVersionFrontierPage).toHaveBeenCalledWith(
      'B',
      frontiers,
      undefined,
      true,
      ['conversation'],
      { signal },
    );
    expect(pullMissingEvents).toHaveBeenCalledWith(
      'B',
      'conversation',
      ranges,
      undefined,
      { signal },
    );
    expect(pushEvents).toHaveBeenCalledWith('B', events, { signal });
    expect(pullAttachmentChunk).toHaveBeenCalledWith(
      'B',
      'conversation',
      'hash',
      0,
      1024,
      { signal },
    );
    expect(pushAttachmentChunk).toHaveBeenCalledWith(
      'B',
      'conversation',
      'hash',
      expect.anything(),
      { signal },
    );
  });

  it('fails clearly when event paging is unavailable', async () => {
    const adapter = new PeerNodeSyncAdapter('B', {
      nodeId: 'A',
      exchangeVersionFrontierPage: vi.fn(),
    });
    await expect(adapter.pullMissingEvents('conversation', [{
      conversationId: 'conversation',
      originNodeId: 'A',
      fromExclusive: 0,
      toInclusive: 1,
    }])).rejects.toThrow('does not support event synchronization');
  });
});
