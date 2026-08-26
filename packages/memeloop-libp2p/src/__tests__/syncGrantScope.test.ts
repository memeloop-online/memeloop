import { describe, expect, it, vi } from 'vitest';

import type { AttachmentReference, ConversationEvent, DeviceConnectionGrant, IAgentStorage, Libp2pSyncRequest } from 'memeloop';
import { PortableLibp2pDeviceNetworkService } from '../portableLibp2pDeviceNetworkService.js';

function syncGrant(
  conversationScope: DeviceConnectionGrant['conversationScope'],
): DeviceConnectionGrant {
  return {
    issuer: 'memeloop-cloud',
    accountId: 'account-1',
    subjectPeerId: 'remote-peer',
    allowedPeerIds: ['local-peer'],
    protocols: ['/memeloop/sync/2.0.0'],
    rpcMethodScope: { mode: 'none' },
    conversationScope,
    definitionScope: { mode: 'none' },
    issuedAt: 1_000,
    expiresAt: 10_000,
    signature: 'test-signature',
  };
}

function event(conversationId: string): ConversationEvent {
  return {
    eventId: `${conversationId}:event-1`,
    conversationId,
    originNodeId: 'origin-1',
    originSequence: 1,
    lamportClock: 1,
    timestamp: 1,
    kind: 'tombstone',
    targetTurnId: 'turn-1',
  };
}

const oneByteHash = 'sha256:4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a';

function eventWithAttachment(conversationId: string): ConversationEvent {
  return {
    eventId: `${conversationId}:message-1`,
    conversationId,
    originNodeId: 'origin-1',
    originSequence: 1,
    lamportClock: 1,
    timestamp: 1,
    kind: 'message',
    message: {
      messageId: `${conversationId}:message-1`,
      turnId: `${conversationId}:message-1`,
      role: 'user',
      content: 'attachment',
      attachments: [{
        contentHash: oneByteHash,
        filename: 'attachment.bin',
        mimeType: 'application/octet-stream',
        size: 1,
      }],
    },
  };
}

function storageSpies() {
  return {
    getEventVersionFrontierPage: vi.fn(async () => ({ items: [] })),
    getEventVersionFrontiersForKeys: vi.fn(async () => []),
    getConversationEventPage: vi.fn(async () => ({ items: [], hasMoreAfter: false })),
    insertEventsIfAbsent: vi.fn(async () => undefined),
    conversationReferencesAttachment: vi.fn(async () => true),
    getAttachment: vi.fn(async (): Promise<AttachmentReference | null> => null),
    readAttachmentData: vi.fn(async () => null),
    readAttachmentRange: vi.fn(async () => new Uint8Array([1])),
    stageAttachmentChunk: vi.fn(async (
      _reference: AttachmentReference,
      offset: number,
      data: Uint8Array,
    ) => offset + data.byteLength),
    commitStagedAttachment: vi.fn(async () => undefined),
    verifyAttachment: vi.fn(async () => true),
    saveAttachment: vi.fn(async () => undefined),
  };
}

async function handleSyncRequest(
  storage: ReturnType<typeof storageSpies>,
  request: Omit<Libp2pSyncRequest, 'type' | 'id'>,
): Promise<unknown> {
  const service = new PortableLibp2pDeviceNetworkService({
    identity: {
      peerId: 'local-peer',
      publicKeyMultibase: 'libp2p-pub:test',
      privateKeyRef: 'test',
      privateKeyRawSeedBase64Url: 'test',
      createdAt: 1,
      deviceName: 'local',
      platform: 'cli',
    },
    syncStorage: storage as unknown as IAgentStorage,
    nodeFactory: async () => {
      throw new Error('node factory must not run');
    },
  });
  return (service as unknown as {
    handleSyncRequest(request: Libp2pSyncRequest): Promise<unknown>;
  }).handleSyncRequest({
    type: 'memeloop-sync-request-v2',
    id: 'request-1',
    ...request,
  });
}

describe('portable inbound sync grant scopes', () => {
  it('rejects none scope before reading version frontiers', async () => {
    const storage = storageSpies();

    await expect(handleSyncRequest(storage, {
      method: 'exchangeVersionFrontierPage',
      params: { localFrontiers: [], includeRemotePage: true },
      grant: syncGrant({ mode: 'none' }),
    })).rejects.toThrow('device_grant_conversation_scope_required');

    expect(storage.getEventVersionFrontierPage).not.toHaveBeenCalled();
  });

  it('preserves all scope and narrows an omitted request to ids scope', async () => {
    const allStorage = storageSpies();
    const idsStorage = storageSpies();

    await handleSyncRequest(allStorage, {
      method: 'exchangeVersionFrontierPage',
      params: { localFrontiers: [], includeRemotePage: true, conversationIds: ['conversation-2'] },
      grant: syncGrant({ mode: 'all' }),
    });
    await handleSyncRequest(idsStorage, {
      method: 'exchangeVersionFrontierPage',
      params: { localFrontiers: [], includeRemotePage: true },
      grant: syncGrant({ mode: 'ids', ids: ['conversation-1'] }),
    });

    expect(allStorage.getEventVersionFrontierPage).toHaveBeenCalledWith({
      limit: 128,
      conversationIds: ['conversation-2'],
    });
    expect(idsStorage.getEventVersionFrontierPage).toHaveBeenCalledWith({
      limit: 128,
      conversationIds: ['conversation-1'],
    });
  });

  it('rejects requested version-vector scope escalation before reading storage', async () => {
    const storage = storageSpies();

    await expect(handleSyncRequest(storage, {
      method: 'exchangeVersionFrontierPage',
      params: {
        localFrontiers: [],
        includeRemotePage: true,
        conversationIds: ['conversation-denied'],
      },
      grant: syncGrant({ mode: 'ids', ids: ['conversation-allowed'] }),
    })).rejects.toThrow('device_grant_conversation_scope_violation');

    expect(storage.getEventVersionFrontierPage).not.toHaveBeenCalled();
  });

  it('rejects pull resource and range escalation before event-page reads', async () => {
    const storage = storageSpies();
    const grant = syncGrant({ mode: 'ids', ids: ['conversation-allowed'] });

    await expect(handleSyncRequest(storage, {
      method: 'pullMissingEvents',
      params: {
        conversationId: 'conversation-denied',
        ranges: [],
      },
      grant,
    })).rejects.toThrow('device_grant_conversation_scope_violation');
    await expect(handleSyncRequest(storage, {
      method: 'pullMissingEvents',
      params: {
        conversationId: 'conversation-allowed',
        ranges: [{
          conversationId: 'conversation-denied',
          originNodeId: 'origin-1',
          fromExclusive: 0,
          toInclusive: 1,
        }],
      },
      grant,
    })).rejects.toThrow('invalid_sync_range_conversation');

    expect(storage.getConversationEventPage).not.toHaveBeenCalled();
  });

  it('rejects event and attachment escalation before mutating or reading blobs', async () => {
    const storage = storageSpies();
    const grant = syncGrant({ mode: 'ids', ids: ['conversation-allowed'] });

    await expect(handleSyncRequest(storage, {
      method: 'pushEvents',
      params: { events: [event('conversation-denied')] },
      grant,
    })).rejects.toThrow('device_grant_conversation_scope_violation');
    await expect(handleSyncRequest(storage, {
      method: 'pullAttachmentChunk',
      params: {
        conversationId: 'conversation-denied',
        contentHash: 'attachment-1',
        offset: 0,
        maxBytes: 1,
      },
      grant,
    })).rejects.toThrow('device_grant_conversation_scope_violation');
    await expect(handleSyncRequest(storage, {
      method: 'pushAttachmentChunk',
      params: {
        conversationId: 'conversation-denied',
        contentHash: 'attachment-1',
        chunk: {
          dataBase64Url: 'AQ',
          byteLength: 1,
          offset: 0,
          totalSize: 1,
          done: true,
          filename: 'attachment.bin',
          mimeType: 'application/octet-stream',
        },
      },
      grant,
    })).rejects.toThrow('device_grant_conversation_scope_violation');

    expect(storage.insertEventsIfAbsent).not.toHaveBeenCalled();
    expect(storage.conversationReferencesAttachment).not.toHaveBeenCalled();
    expect(storage.getAttachment).not.toHaveBeenCalled();
    expect(storage.readAttachmentData).not.toHaveBeenCalled();
    expect(storage.readAttachmentRange).not.toHaveBeenCalled();
    expect(storage.saveAttachment).not.toHaveBeenCalled();
  });

  it('allows ids-scoped event and attachment operations for the bound conversation', async () => {
    const storage = storageSpies();
    storage.getAttachment.mockResolvedValue({
      contentHash: oneByteHash,
      filename: 'attachment.bin',
      mimeType: 'application/octet-stream',
      size: 1,
    });
    const grant = syncGrant({ mode: 'ids', ids: ['conversation-allowed'] });

    await handleSyncRequest(storage, {
      method: 'pullMissingEvents',
      params: { conversationId: 'conversation-allowed', ranges: [] },
      grant,
    });
    await handleSyncRequest(storage, {
      method: 'pushEvents',
      params: { events: [event('conversation-allowed')] },
      grant,
    });
    await handleSyncRequest(storage, {
      method: 'pullAttachmentChunk',
      params: {
        conversationId: 'conversation-allowed',
        contentHash: oneByteHash,
        offset: 0,
        maxBytes: 1,
      },
      grant,
    });
    await handleSyncRequest(storage, {
      method: 'pushAttachmentChunk',
      params: {
        conversationId: 'conversation-allowed',
        contentHash: oneByteHash,
        chunk: {
          dataBase64Url: 'AQ',
          byteLength: 1,
          offset: 0,
          totalSize: 1,
          done: true,
          filename: 'attachment.bin',
          mimeType: 'application/octet-stream',
        },
      },
      grant,
    });

    expect(storage.getConversationEventPage).toHaveBeenCalledOnce();
    expect(storage.insertEventsIfAbsent).toHaveBeenCalledOnce();
    expect(storage.conversationReferencesAttachment).toHaveBeenCalledWith(
      'conversation-allowed',
      oneByteHash,
    );
    expect(storage.getAttachment).toHaveBeenCalledOnce();
    expect(storage.readAttachmentRange).toHaveBeenCalledOnce();
    expect(storage.stageAttachmentChunk).toHaveBeenCalledOnce();
    expect(storage.commitStagedAttachment).toHaveBeenCalledOnce();
  });

  it('rejects unreferenced blob reads before touching the global blob store', async () => {
    const storage = storageSpies();
    storage.conversationReferencesAttachment.mockResolvedValue(false);

    await expect(handleSyncRequest(storage, {
      method: 'pullAttachmentChunk',
      params: {
        conversationId: 'conversation-allowed',
        contentHash: oneByteHash,
        offset: 0,
        maxBytes: 1,
      },
      grant: syncGrant({ mode: 'ids', ids: ['conversation-allowed'] }),
    })).rejects.toThrow('sync_attachment_not_referenced');

    expect(storage.getAttachment).not.toHaveBeenCalled();
    expect(storage.readAttachmentData).not.toHaveBeenCalled();
  });

  it('rejects an attachment event before insertion when its verified blob is absent', async () => {
    const storage = storageSpies();

    await expect(handleSyncRequest(storage, {
      method: 'pushEvents',
      params: { events: [eventWithAttachment('conversation-allowed')] },
      grant: syncGrant({ mode: 'ids', ids: ['conversation-allowed'] }),
    })).rejects.toThrow('sync_attachment_missing');

    expect(storage.insertEventsIfAbsent).not.toHaveBeenCalled();
  });

  it('prevalidates the complete event batch before its atomic insert', async () => {
    const storage = storageSpies();
    const invalid = { ...event('conversation-allowed'), unknown: true };

    await expect(handleSyncRequest(storage, {
      method: 'pushEvents',
      params: { events: [event('conversation-allowed'), invalid] },
      grant: syncGrant({ mode: 'ids', ids: ['conversation-allowed'] }),
    })).rejects.toThrow('invalid canonical conversation event schema');

    expect(storage.insertEventsIfAbsent).not.toHaveBeenCalled();
  });

  it('rejects an inconsistent attachment chunk before staging it', async () => {
    const storage = storageSpies();

    await expect(handleSyncRequest(storage, {
      method: 'pushAttachmentChunk',
      params: {
        conversationId: 'conversation-allowed',
        contentHash: oneByteHash,
        chunk: {
          dataBase64Url: 'Ag',
          byteLength: 1,
          offset: 0,
          totalSize: 2,
          done: true,
          filename: 'attachment.bin',
          mimeType: 'application/octet-stream',
        },
      },
      grant: syncGrant({ mode: 'ids', ids: ['conversation-allowed'] }),
    })).rejects.toThrow('invalid_sync_attachment_chunk');

    expect(storage.stageAttachmentChunk).not.toHaveBeenCalled();
  });
});
