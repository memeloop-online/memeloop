import { describe, expect, it, vi } from 'vitest';

import type { AttachmentReference, ChatMessage } from '../../conversation/index.js';
import type { ConversationMeta, VersionVector } from '../../sync/protocol.js';
import type { IAgentStorage } from '../../types.js';
import { CloudDeviceAuthorizer } from '../cloudDeviceAuthorizer.js';
import { buildDeviceConnectionGrantMessage, createDeviceIdentity, Libp2pDeviceNetworkService } from '../libp2pDeviceNetworkService.js';
import type { DeviceAuthorizer, DeviceConnectionGrant, DevicePlatform, DeviceTrustStore, TrustedDeviceRecord } from '../types.js';

function createMemoryTrustStore(initial: TrustedDeviceRecord[] = []): DeviceTrustStore & {
  records: Map<string, TrustedDeviceRecord>;
  saveTrustedDevice: ReturnType<typeof vi.fn>;
  removeTrustedDevice: ReturnType<typeof vi.fn>;
} {
  const records = new Map(initial.map((record) => [record.peerId, record]));
  return {
    records,
    loadTrustedDevices: async () => [...records.values()],
    saveTrustedDevice: vi.fn(async (record: TrustedDeviceRecord) => {
      records.set(record.peerId, record);
    }),
    removeTrustedDevice: vi.fn(async (peerId: string) => {
      records.delete(peerId);
    }),
  };
}

function createMemorySyncStorage(): IAgentStorage & {
  conversations: Map<string, ConversationMeta>;
  messages: Map<string, ChatMessage[]>;
  attachmentReferences: Map<string, AttachmentReference>;
  attachmentData: Map<string, Uint8Array>;
} {
  const conversations = new Map<string, ConversationMeta>();
  const messages = new Map<string, ChatMessage[]>();
  const attachmentReferences = new Map<string, AttachmentReference>();
  const attachmentData = new Map<string, Uint8Array>();
  return {
    conversations,
    messages,
    attachmentReferences,
    attachmentData,
    listConversations: async () => [...conversations.values()],
    getMessages: async (conversationId: string) => messages.get(conversationId) ?? [],
    appendMessage: async (message: ChatMessage) => {
      const list = messages.get(message.conversationId) ?? [];
      list.push(message);
      messages.set(message.conversationId, list);
    },
    upsertConversationMetadata: async (meta: ConversationMeta) => {
      conversations.set(meta.conversationId, meta);
    },
    insertMessagesIfAbsent: async (incoming: ChatMessage[]) => {
      for (const message of incoming) {
        const list = messages.get(message.conversationId) ?? [];
        if (!list.some((item) => item.messageId === message.messageId)) list.push(message);
        messages.set(message.conversationId, list);
      }
    },
    getAttachment: async (contentHash: string) => attachmentReferences.get(contentHash) ?? null,
    saveAttachment: async (reference: AttachmentReference, data: Buffer | Uint8Array) => {
      attachmentReferences.set(reference.contentHash, reference);
      attachmentData.set(reference.contentHash, data instanceof Uint8Array ? data : new Uint8Array(data));
    },
    readAttachmentData: async (contentHash: string) => attachmentData.get(contentHash) ?? null,
    getAgentDefinition: async () => null,
    saveAgentInstance: async () => {},
    getConversationMeta: async (conversationId: string) => conversations.get(conversationId) ?? null,
  };
}

function createConversation(id: string, originNodeId: string): ConversationMeta {
  return {
    conversationId: id,
    title: id,
    lastMessagePreview: '',
    lastMessageTimestamp: Date.now(),
    messageCount: 1,
    originNodeId,
    definitionId: 'memeloop:test',
    isUserInitiated: true,
  };
}

function createMessage(input: {
  messageId: string;
  conversationId: string;
  originNodeId: string;
  content: string;
  attachments?: AttachmentReference[];
}): ChatMessage {
  return {
    messageId: input.messageId,
    conversationId: input.conversationId,
    originNodeId: input.originNodeId,
    timestamp: Date.now(),
    lamportClock: 1,
    role: 'assistant',
    content: input.content,
    attachments: input.attachments,
  };
}

async function createGrant(input: {
  subjectPeerId: string;
  allowedPeerId: string;
}): Promise<{ grant: DeviceConnectionGrant; publicKeyMultibase: string }> {
  const { generateKeyPairFromSeed, publicKeyToProtobuf } = await import('@libp2p/crypto/keys');
  const { toString } = await import('uint8arrays');
  const privateKey = await generateKeyPairFromSeed('Ed25519', new Uint8Array(32).fill(9));
  const publicKeyMultibase = `libp2p-pub:${toString(publicKeyToProtobuf(privateKey.publicKey), 'base64url')}`;
  const unsignedGrant = {
    issuer: 'memeloop-cloud' as const,
    accountId: 'account-1',
    subjectPeerId: input.subjectPeerId,
    allowedPeerIds: [input.allowedPeerId],
    issuedAt: 1_000,
    expiresAt: 60_000,
  };
  return {
    publicKeyMultibase,
    grant: {
      ...unsignedGrant,
      signature: toString(await privateKey.sign(buildDeviceConnectionGrantMessage(unsignedGrant)), 'base64url'),
    },
  };
}

async function startMockPeerServer(
  platform: DevicePlatform,
  deviceName: string,
  options: {
    authorizer?: DeviceAuthorizer;
    syncStorage?: IAgentStorage;
    syncVersionVector?: () => VersionVector;
  } = {},
) {
  const identity = await createDeviceIdentity(platform, deviceName);
  const trustStore = createMemoryTrustStore();
  const service = new Libp2pDeviceNetworkService({
    identity,
    trustStore,
    authorizer: options.authorizer,
    enableMdns: false,
    enableCircuitRelay: false,
    listen: { addresses: ['/ip4/127.0.0.1/tcp/0'] },
    syncStorage: options.syncStorage,
    syncVersionVector: options.syncVersionVector,
  });
  await service.start();
  return {
    identity,
    trustStore,
    service,
    multiaddrs: service.getMultiaddrs(),
    async stop() {
      await service.stop();
    },
  };
}

describe('local pairing e2e', () => {
  it('pairs with a mock peer server and persists trust on both devices', async () => {
    const mockPeer = await startMockPeerServer('mobile', 'Mock Mobile');
    const localIdentity = await createDeviceIdentity('desktop', 'Local Desktop');
    const localTrustStore = createMemoryTrustStore();
    const local = new Libp2pDeviceNetworkService({
      identity: localIdentity,
      trustStore: localTrustStore,
      enableMdns: false,
      listen: { addresses: [] },
      enableCircuitRelay: false,
    });
    await local.start();

    try {
      const observedInboundSessions: number[] = [];
      const unsubscribe = mockPeer.service.observePairingSessions((sessions) => {
        observedInboundSessions.push(sessions.length);
      });

      const outbound = await local.requestLocalPairing(mockPeer.identity.peerId, {
        multiaddrs: mockPeer.multiaddrs,
      });
      const inbound = (await mockPeer.service.listPairingSessions()).find((session) => session.sessionId === outbound.sessionId);

      expect(inbound).toBeDefined();
      expect(outbound.direction).toBe('outbound');
      expect(inbound?.direction).toBe('inbound');
      expect(outbound.status).toBe('pending');
      expect(inbound?.status).toBe('pending');
      expect(outbound.confirmCode).toBe(inbound?.confirmCode);
      expect(outbound.remotePublicKeyMultibase).toBe(mockPeer.identity.publicKeyMultibase);
      expect(inbound?.remotePublicKeyMultibase).toBe(localIdentity.publicKeyMultibase);
      expect(observedInboundSessions.some((count) => count > 0)).toBe(true);

      await mockPeer.service.acceptPairing(inbound!.sessionId);
      await local.acceptPairing(outbound.sessionId);

      expect(localTrustStore.records.get(mockPeer.identity.peerId)).toMatchObject({
        peerId: mockPeer.identity.peerId,
        publicKeyMultibase: mockPeer.identity.publicKeyMultibase,
        deviceName: 'Mock Mobile',
        platform: 'mobile',
        trustMode: 'local-pairing',
      });
      expect(mockPeer.trustStore.records.get(localIdentity.peerId)).toMatchObject({
        peerId: localIdentity.peerId,
        publicKeyMultibase: localIdentity.publicKeyMultibase,
        deviceName: 'Local Desktop',
        platform: 'desktop',
        trustMode: 'local-pairing',
      });

      await expect(local.syncWithDevice(mockPeer.identity.peerId)).resolves.toMatchObject({ ok: true });
      await expect(mockPeer.service.syncWithDevice(localIdentity.peerId)).resolves.toMatchObject({ ok: true });

      unsubscribe();
    } finally {
      await local.stop();
      await mockPeer.stop();
    }
  });

  it('syncs conversations, messages and attachments with a paired mock peer server', async () => {
    let remotePeerId = '';
    const remoteStorage = createMemorySyncStorage();
    const mockPeer = await startMockPeerServer('mobile', 'Mock Mobile', {
      syncStorage: remoteStorage,
      syncVersionVector: () => ({ [remotePeerId]: 1 }),
    });
    remotePeerId = mockPeer.identity.peerId;
    const attachment = {
      contentHash: 'hash-remote-attachment',
      filename: 'remote.txt',
      mimeType: 'text/plain',
      size: 11,
    };
    remoteStorage.conversations.set('conv-remote', createConversation('conv-remote', remotePeerId));
    remoteStorage.messages.set('conv-remote', [createMessage({
      messageId: 'msg-remote',
      conversationId: 'conv-remote',
      originNodeId: remotePeerId,
      content: 'from remote',
      attachments: [attachment],
    })]);
    remoteStorage.attachmentReferences.set(attachment.contentHash, attachment);
    remoteStorage.attachmentData.set(attachment.contentHash, new TextEncoder().encode('hello world'));

    const localIdentity = await createDeviceIdentity('desktop', 'Local Desktop');
    const localTrustStore = createMemoryTrustStore();
    const localStorage = createMemorySyncStorage();
    const local = new Libp2pDeviceNetworkService({
      identity: localIdentity,
      trustStore: localTrustStore,
      enableMdns: false,
      enableCircuitRelay: false,
      listen: { addresses: [] },
      syncStorage: localStorage,
      syncVersionVector: () => ({ [localIdentity.peerId]: 0 }),
    });
    await local.start();

    try {
      const outbound = await local.requestLocalPairing(mockPeer.identity.peerId, {
        multiaddrs: mockPeer.multiaddrs,
      });
      const inbound = (await mockPeer.service.listPairingSessions()).find((session) => session.sessionId === outbound.sessionId);
      await mockPeer.service.acceptPairing(inbound!.sessionId);
      await local.acceptPairing(outbound.sessionId);

      await expect(local.syncWithDevice(mockPeer.identity.peerId)).resolves.toMatchObject({ ok: true });

      expect(localStorage.conversations.get('conv-remote')).toMatchObject({ originNodeId: remotePeerId });
      expect(localStorage.messages.get('conv-remote')).toEqual([
        expect.objectContaining({ messageId: 'msg-remote', content: 'from remote' }),
      ]);
      expect(new TextDecoder().decode(localStorage.attachmentData.get(attachment.contentHash))).toBe('hello world');
    } finally {
      await local.stop();
      await mockPeer.stop();
    }
  });

  it('syncs with a mock peer server using a Cloud grant without local pairing', async () => {
    const localIdentity = await createDeviceIdentity('desktop', 'Cloud Desktop');
    const remoteIdentity = await createDeviceIdentity('mobile', 'Cloud Mobile');
    const { grant, publicKeyMultibase } = await createGrant({
      subjectPeerId: localIdentity.peerId,
      allowedPeerId: remoteIdentity.peerId,
    });
    const remoteStorage = createMemorySyncStorage();
    remoteStorage.conversations.set('conv-cloud', createConversation('conv-cloud', remoteIdentity.peerId));
    remoteStorage.messages.set('conv-cloud', [createMessage({
      messageId: 'msg-cloud',
      conversationId: 'conv-cloud',
      originNodeId: remoteIdentity.peerId,
      content: 'from cloud peer',
    })]);

    const remote = new Libp2pDeviceNetworkService({
      identity: remoteIdentity,
      trustStore: createMemoryTrustStore(),
      authorizer: new CloudDeviceAuthorizer({
        localPeerId: remoteIdentity.peerId,
        grantVerificationPublicKeyMultibase: publicKeyMultibase,
        now: () => 2_000,
      }),
      enableMdns: false,
      enableCircuitRelay: false,
      listen: { addresses: ['/ip4/127.0.0.1/tcp/0'] },
      syncStorage: remoteStorage,
      syncVersionVector: () => ({ [remoteIdentity.peerId]: 1 }),
    });
    const localStorage = createMemorySyncStorage();
    const local = new Libp2pDeviceNetworkService({
      identity: localIdentity,
      trustStore: createMemoryTrustStore(),
      authorizer: new CloudDeviceAuthorizer({
        localPeerId: localIdentity.peerId,
        grantVerificationPublicKeyMultibase: publicKeyMultibase,
        now: () => 2_000,
      }),
      enableMdns: false,
      enableCircuitRelay: false,
      listen: { addresses: [] },
      syncStorage: localStorage,
      syncVersionVector: () => ({ [localIdentity.peerId]: 0 }),
    });
    await remote.start();
    await local.start();

    try {
      local.upsertDiscoveredDevice({
        peerId: remoteIdentity.peerId,
        displayName: 'Cloud Mobile',
        platform: 'mobile',
        trustMode: 'cloud-account',
        trusted: true,
        reachability: { state: 'online', paths: ['direct'] },
        capabilities: { tools: [], mcpServers: [], hasWiki: false, imChannels: [], wikis: [] },
        multiaddrs: remote.getMultiaddrs(),
        lastSeen: Date.now(),
      });
      await expect(local.syncWithDevice(remoteIdentity.peerId)).rejects.toThrow('device_not_trusted');

      await expect(local.syncWithDevice(remoteIdentity.peerId, grant)).resolves.toMatchObject({ ok: true });

      expect(localStorage.conversations.get('conv-cloud')).toMatchObject({ originNodeId: remoteIdentity.peerId });
      expect(localStorage.messages.get('conv-cloud')).toEqual([
        expect.objectContaining({ messageId: 'msg-cloud', content: 'from cloud peer' }),
      ]);
    } finally {
      await local.stop();
      await remote.stop();
    }
  });
});
