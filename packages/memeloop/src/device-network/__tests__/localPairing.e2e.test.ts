import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { identify } from '@libp2p/identify';
import type { ConnectionGater, Libp2p, Stream } from '@libp2p/interface';
import { ping } from '@libp2p/ping';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { createLibp2p } from 'libp2p';
import { describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '../../agent/types.js';
import type { AttachmentReference, ChatMessage, DetailReference } from '../../conversation/index.js';
import { createMemeLoopRuntime } from '../../runtime.js';
import type { ConversationMeta, VersionVector } from '../../sync/protocol.js';
import type { AgentFrameworkContext, IAgentStorage, ILLMProvider, IToolRegistry } from '../../types.js';
import { createAgentRuntimeDeviceRpcHandler } from '../agentRuntimeRpcHandler.js';
import { CloudDeviceAuthorizer } from '../cloudDeviceAuthorizer.js';
import {
  buildDeviceConnectionGrantMessage,
  buildDeviceRelayReservationTokenMessage,
  createDeviceIdentity,
  Libp2pDeviceNetworkService,
  verifyDeviceRelayReservationToken,
} from '../libp2pDeviceNetworkService.js';
import type { DeviceAuthorizer, DeviceConnectionGrant, DevicePlatform, DeviceRelayReservationToken, DeviceRpcHandler, DeviceTrustStore, TrustedDeviceRecord } from '../types.js';

const RELAY_ADMISSION_PROTOCOL = '/memeloop/relay-admission/1.0.0';
const RELAY_ADMISSION_REQUEST_TYPE = 'memeloop-relay-admission-request-v1';
const RELAY_ADMISSION_RESPONSE_TYPE = 'memeloop-relay-admission-response-v1';

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
  agentRunLogs: Map<string, ChatMessage[]>;
} {
  const conversations = new Map<string, ConversationMeta>();
  const messages = new Map<string, ChatMessage[]>();
  const attachmentReferences = new Map<string, AttachmentReference>();
  const attachmentData = new Map<string, Uint8Array>();
  const agentRunLogs = new Map<string, ChatMessage[]>();
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
    agentRunLogs,
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
  detailRef?: DetailReference;
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
    detailRef: input.detailRef,
  };
}

async function createGrant(input: {
  subjectPeerId: string;
  allowedPeerId: string;
  accountId?: string;
  seedByte?: number;
}): Promise<{ grant: DeviceConnectionGrant; publicKeyMultibase: string }> {
  const { generateKeyPairFromSeed, publicKeyToProtobuf } = await import('@libp2p/crypto/keys');
  const { toString } = await import('uint8arrays');
  const privateKey = await generateKeyPairFromSeed('Ed25519', new Uint8Array(32).fill(input.seedByte ?? 9));
  const publicKeyMultibase = `libp2p-pub:${toString(publicKeyToProtobuf(privateKey.publicKey), 'base64url')}`;
  const unsignedGrant = {
    issuer: 'memeloop-cloud' as const,
    accountId: input.accountId ?? 'account-1',
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

async function relayAdmissionPublicKey(seedByte = 17): Promise<string> {
  const { generateKeyPairFromSeed, publicKeyToProtobuf } = await import('@libp2p/crypto/keys');
  const { toString } = await import('uint8arrays');
  const privateKey = await generateKeyPairFromSeed('Ed25519', new Uint8Array(32).fill(seedByte));
  return `libp2p-pub:${toString(publicKeyToProtobuf(privateKey.publicKey), 'base64url')}`;
}

async function createRelayReservationToken(input: {
  peerId: string;
  relayMultiaddrs: string[];
  accountId?: string;
  seedByte?: number;
}): Promise<DeviceRelayReservationToken> {
  const { generateKeyPairFromSeed } = await import('@libp2p/crypto/keys');
  const { toString } = await import('uint8arrays');
  const privateKey = await generateKeyPairFromSeed('Ed25519', new Uint8Array(32).fill(input.seedByte ?? 17));
  const unsigned = {
    issuer: 'memeloop-cloud' as const,
    accountId: input.accountId ?? 'account-1',
    peerId: input.peerId,
    relayMultiaddrs: input.relayMultiaddrs,
    bootstrapMultiaddrs: input.relayMultiaddrs,
    issuedAt: 1_000,
    expiresAt: 60_000,
  };
  return {
    ...unsigned,
    signature: toString(await privateKey.sign(buildDeviceRelayReservationTokenMessage(unsigned)), 'base64url'),
  };
}

async function startAdmittingRelay(verificationPublicKeyMultibase: string): Promise<{
  node: Libp2p;
  multiaddrs: string[];
  stop(): Promise<void>;
}> {
  const admittedPeers = new Map<string, number>();
  const now = () => 2_000;
  const hasAdmission = (peerId: string): boolean => {
    const expiresAt = admittedPeers.get(peerId);
    return expiresAt !== undefined && expiresAt > now();
  };
  const connectionGater: ConnectionGater = {
    denyInboundRelayReservation(source) {
      return !hasAdmission(source.toString());
    },
    denyOutboundRelayedConnection(source, destination) {
      return !hasAdmission(source.toString()) || !hasAdmission(destination.toString());
    },
  };
  const node = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater,
    services: {
      identify: identify(),
      ping: ping(),
      circuitRelay: circuitRelayServer({
        reservations: {
          maxReservations: 4,
          reservationTtl: 60_000,
        },
      }),
    },
    start: false,
  });
  await node.handle(RELAY_ADMISSION_PROTOCOL, async (stream, connection) => {
    try {
      const request = await readRelayAdmissionJson(stream);
      if (!isRelayAdmissionRequest(request)) throw new Error('invalid_relay_admission_request');
      const remotePeerId = connection.remotePeer.toString();
      const verified = await verifyDeviceRelayReservationToken({
        token: request.token,
        verificationPublicKeyMultibase,
        peerId: remotePeerId,
        now: now(),
      });
      if (!verified) throw new Error('invalid_relay_admission_token');
      admittedPeers.set(remotePeerId, request.token.expiresAt);
      writeRelayAdmissionJson(stream, {
        type: RELAY_ADMISSION_RESPONSE_TYPE,
        ok: true,
        peerId: remotePeerId,
        expiresAt: request.token.expiresAt,
      });
    } catch (error) {
      writeRelayAdmissionJson(stream, {
        type: RELAY_ADMISSION_RESPONSE_TYPE,
        ok: false,
        reason: error instanceof Error ? error.message : 'relay_admission_failed',
      });
    } finally {
      await stream.close().catch(() => undefined);
    }
  });
  await node.start();
  return {
    node,
    multiaddrs: node.getMultiaddrs().map((address) => address.toString()),
    stop: async () => {
      await node.stop();
    },
  };
}

async function readRelayAdmissionJson(stream: Stream): Promise<unknown> {
  const reader = stream[Symbol.asyncIterator]();
  const result = await reader.next();
  if (result.done || !result.value) throw new Error('relay_admission_message_missing');
  const chunk = result.value instanceof Uint8Array ? result.value : result.value.subarray();
  return JSON.parse(new TextDecoder().decode(chunk)) as unknown;
}

function writeRelayAdmissionJson(stream: Stream, message: unknown): void {
  stream.send(new TextEncoder().encode(JSON.stringify(message)));
}

function isRelayAdmissionRequest(value: unknown): value is { token: DeviceRelayReservationToken } {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.type === RELAY_ADMISSION_REQUEST_TYPE && isRelayReservationToken(record.token);
}

function isRelayReservationToken(value: unknown): value is DeviceRelayReservationToken {
  if (value === null || typeof value !== 'object') return false;
  const token = value as Record<string, unknown>;
  return typeof token.peerId === 'string' && typeof token.signature === 'string';
}

async function waitForRelayAddress(service: Libp2pDeviceNetworkService): Promise<string> {
  for (let index = 0; index < 50; index += 1) {
    const address = service.getMultiaddrs().find((multiaddr) => multiaddr.includes('/p2p-circuit'));
    if (address) return address;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('relay_address_not_available');
}

async function startMockPeerServer(
  platform: DevicePlatform,
  deviceName: string,
  options: {
    authorizer?: DeviceAuthorizer;
    syncStorage?: IAgentStorage;
    syncVersionVector?: () => VersionVector;
    rpcHandler?: DeviceRpcHandler;
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
    rpcHandler: options.rpcHandler,
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

  it('syncs message detailRef summaries but does not pull detail contents by default', async () => {
    let remotePeerId = '';
    const remoteStorage = createMemorySyncStorage();
    const mockPeer = await startMockPeerServer('desktop', 'Mock Desktop', {
      syncStorage: remoteStorage,
      syncVersionVector: () => ({ [remotePeerId]: 1 }),
      rpcHandler: async ({ method, parameters }) => {
        if (method !== 'memeloop.chat.pullAgentRunLog') throw new Error(`unexpected_rpc:${method}`);
        const params = parameters as Record<string, unknown>;
        const conversationId = params.conversationId as string;
        const known = new Set((params.knownMessageIds as string[] | undefined) ?? []);
        const logs = remoteStorage.agentRunLogs.get(conversationId) ?? [];
        return { messages: logs.filter((message) => !known.has(message.messageId)) };
      },
    });
    remotePeerId = mockPeer.identity.peerId;

    const detailRef: DetailReference = { type: 'agent-run', conversationId: 'conv-detail', nodeId: remotePeerId };
    const summaryMessage = createMessage({
      messageId: 'msg-detail-summary',
      conversationId: 'conv-detail',
      originNodeId: remotePeerId,
      content: 'agent finished',
      detailRef,
    });
    const detailMessage = createMessage({
      messageId: 'msg-detail-internal',
      conversationId: 'conv-detail',
      originNodeId: remotePeerId,
      content: 'internal tool output',
    });
    remoteStorage.conversations.set('conv-detail', createConversation('conv-detail', remotePeerId));
    remoteStorage.messages.set('conv-detail', [summaryMessage]);
    remoteStorage.agentRunLogs.set(detailRef.conversationId, [detailMessage]);

    const localIdentity = await createDeviceIdentity('mobile', 'Local Mobile');
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

      const localMessages = localStorage.messages.get('conv-detail') ?? [];
      expect(localMessages).toEqual([expect.objectContaining({ messageId: 'msg-detail-summary', detailRef })]);
      expect(localStorage.agentRunLogs.size).toBe(0);

      const pulled = await local.sendRpc(mockPeer.identity.peerId, 'memeloop.chat.pullAgentRunLog', {
        conversationId: 'conv-detail',
        knownMessageIds: ['msg-detail-summary'],
      });
      expect(pulled.messages).toEqual([expect.objectContaining({ messageId: 'msg-detail-internal' })]);
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

  it('rejects sync streams when peers present a grant from a different Cloud account', async () => {
    const localIdentity = await createDeviceIdentity('desktop', 'Account A Desktop');
    const remoteIdentity = await createDeviceIdentity('mobile', 'Account B Mobile');
    const accountAGrant = await createGrant({
      accountId: 'account-a',
      seedByte: 10,
      subjectPeerId: localIdentity.peerId,
      allowedPeerId: remoteIdentity.peerId,
    });
    const accountBGrant = await createGrant({
      accountId: 'account-b',
      seedByte: 11,
      subjectPeerId: remoteIdentity.peerId,
      allowedPeerId: localIdentity.peerId,
    });
    const remoteStorage = createMemorySyncStorage();
    remoteStorage.conversations.set('conv-cross-account', createConversation('conv-cross-account', remoteIdentity.peerId));
    remoteStorage.messages.set('conv-cross-account', [createMessage({
      messageId: 'msg-cross-account',
      conversationId: 'conv-cross-account',
      originNodeId: remoteIdentity.peerId,
      content: 'should not sync across accounts',
    })]);
    const remoteRpcHandler = vi.fn(async () => ({ ok: true }));

    const remote = new Libp2pDeviceNetworkService({
      identity: remoteIdentity,
      trustStore: createMemoryTrustStore(),
      authorizer: new CloudDeviceAuthorizer({
        localPeerId: remoteIdentity.peerId,
        grantVerificationPublicKeyMultibase: accountBGrant.publicKeyMultibase,
        now: () => 2_000,
      }),
      enableMdns: false,
      enableCircuitRelay: false,
      listen: { addresses: ['/ip4/127.0.0.1/tcp/0'] },
      syncStorage: remoteStorage,
      syncVersionVector: () => ({ [remoteIdentity.peerId]: 1 }),
      rpcHandler: remoteRpcHandler,
    });
    const localStorage = createMemorySyncStorage();
    const local = new Libp2pDeviceNetworkService({
      identity: localIdentity,
      trustStore: createMemoryTrustStore(),
      authorizer: new CloudDeviceAuthorizer({
        localPeerId: localIdentity.peerId,
        grantVerificationPublicKeyMultibase: accountAGrant.publicKeyMultibase,
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
        displayName: 'Account B Mobile',
        platform: 'mobile',
        trustMode: 'cloud-account',
        trusted: true,
        reachability: { state: 'online', paths: ['direct'] },
        capabilities: { tools: [], mcpServers: [], hasWiki: false, agentLoop: false, imChannels: [], wikis: [] },
        multiaddrs: remote.getMultiaddrs(),
        lastSeen: Date.now(),
      });

      await expect(local.syncWithDevice(remoteIdentity.peerId, accountAGrant.grant)).rejects.toThrow('device_not_trusted');
      await expect(local.sendRpc(remoteIdentity.peerId, 'memeloop.test.ping', {}, accountAGrant.grant)).rejects.toThrow('device_not_trusted');

      expect(localStorage.conversations.has('conv-cross-account')).toBe(false);
      expect(localStorage.messages.has('conv-cross-account')).toBe(false);
      expect(remoteRpcHandler).not.toHaveBeenCalled();
    } finally {
      await local.stop();
      await remote.stop();
    }
  });

  it('runs an agent turn on a paired mock peer and syncs the conversation stream back', async () => {
    let remotePeerId = '';
    const remoteRpcHandlerRef: { current?: DeviceRpcHandler } = {};
    const remoteStorage = createMemorySyncStorage();
    const mockPeer = await startMockPeerServer('cli', 'Mock CLI', {
      syncStorage: remoteStorage,
      syncVersionVector: () => ({ [remotePeerId]: 2 }),
      rpcHandler: async (input) => {
        if (!remoteRpcHandlerRef.current) throw new Error('remote_rpc_not_ready');
        return remoteRpcHandlerRef.current(input);
      },
    });
    remotePeerId = mockPeer.identity.peerId;
    const definition: AgentDefinition = {
      id: 'memeloop:test-agent',
      name: 'Test Agent',
      description: 'Test remote execution agent',
      systemPrompt: 'Run the test turn.',
      tools: [],
      version: '1.0.0',
    };
    const llmProvider: ILLMProvider = {
      name: 'test',
      async chat() {
        return '';
      },
    };
    const tools: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn(),
      listTools: vi.fn().mockReturnValue([]),
    };
    const context: AgentFrameworkContext = {
      storage: remoteStorage,
      llmProvider,
      tools,
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      runAgentToolLoop: async function*(input) {
        if (input.resumeSession && input.resumeSession.length > 0) {
          await remoteStorage.insertMessagesIfAbsent(input.resumeSession);
        }
        await remoteStorage.insertMessagesIfAbsent([createMessage({
          messageId: `${input.conversationId}:remote-assistant`,
          conversationId: input.conversationId,
          originNodeId: remotePeerId,
          content: `remote:${input.message}`,
        })]);
        yield { type: 'message' as const, data: `remote:${input.message}` };
      },
    };
    const runtime = createMemeLoopRuntime(context);
    remoteRpcHandlerRef.current = createAgentRuntimeDeviceRpcHandler({
      runtime,
      storage: remoteStorage,
      getAgentDefinitions: () => [definition],
      localNodeId: remotePeerId,
    });

    const localIdentity = await createDeviceIdentity('mobile', 'Local Mobile');
    const localStorage = createMemorySyncStorage();
    const local = new Libp2pDeviceNetworkService({
      identity: localIdentity,
      trustStore: createMemoryTrustStore(),
      enableMdns: false,
      enableCircuitRelay: false,
      listen: { addresses: [] },
      syncStorage: localStorage,
      syncVersionVector: () => ({ [localIdentity.peerId]: 1 }),
    });
    await local.start();

    try {
      const outbound = await local.requestLocalPairing(mockPeer.identity.peerId, {
        multiaddrs: mockPeer.multiaddrs,
      });
      const inbound = (await mockPeer.service.listPairingSessions()).find((session) => session.sessionId === outbound.sessionId);
      await mockPeer.service.acceptPairing(inbound!.sessionId);
      await local.acceptPairing(outbound.sessionId);

      const conversation = createConversation('conv-remote-run', localIdentity.peerId);
      conversation.definitionId = definition.id;
      localStorage.conversations.set(conversation.conversationId, conversation);
      const localUserMessage = createMessage({
        messageId: 'conv-remote-run:user-1',
        conversationId: conversation.conversationId,
        originNodeId: localIdentity.peerId,
        content: 'do it remotely',
      });
      localUserMessage.role = 'user';
      localStorage.messages.set(conversation.conversationId, [localUserMessage]);

      await expect(local.sendRpc(mockPeer.identity.peerId, 'memeloop.agent.runTurn', {
        conversation,
        conversationId: conversation.conversationId,
        definitionId: definition.id,
        message: 'do it remotely',
        resumeSession: [localUserMessage],
        userMessage: localUserMessage,
      })).resolves.toMatchObject({ ok: true, conversationId: conversation.conversationId });

      for (let index = 0; index < 50; index += 1) {
        await local.syncWithDevice(mockPeer.identity.peerId);
        const messages = localStorage.messages.get(conversation.conversationId) ?? [];
        if (messages.some((message) => message.messageId.endsWith(':remote-assistant'))) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(remoteStorage.messages.get(conversation.conversationId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ messageId: localUserMessage.messageId, role: 'user' }),
          expect.objectContaining({ content: 'remote:do it remotely', originNodeId: remotePeerId }),
        ]),
      );
      expect(localStorage.messages.get(conversation.conversationId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: 'remote:do it remotely', originNodeId: remotePeerId }),
        ]),
      );
    } finally {
      await local.stop();
      await mockPeer.stop();
    }
  });

  it('opens RPC through a private relay after Cloud relay admission', async () => {
    const relayAdmissionKey = await relayAdmissionPublicKey();
    const relay = await startAdmittingRelay(relayAdmissionKey);
    const localIdentity = await createDeviceIdentity('mobile', 'Relay Mobile');
    const remoteIdentity = await createDeviceIdentity('desktop', 'Relay Desktop');
    const { grant, publicKeyMultibase } = await createGrant({
      subjectPeerId: localIdentity.peerId,
      allowedPeerId: remoteIdentity.peerId,
    });
    const remoteRpcHandler = vi.fn(async () => ({ pong: true, via: 'relay' }));
    const local = new Libp2pDeviceNetworkService({
      identity: localIdentity,
      trustStore: createMemoryTrustStore(),
      authorizer: new CloudDeviceAuthorizer({
        localPeerId: localIdentity.peerId,
        grantVerificationPublicKeyMultibase: publicKeyMultibase,
        now: () => 2_000,
      }),
      enableMdns: false,
      listen: { addresses: [] },
    });
    const remote = new Libp2pDeviceNetworkService({
      identity: remoteIdentity,
      trustStore: createMemoryTrustStore(),
      authorizer: new CloudDeviceAuthorizer({
        localPeerId: remoteIdentity.peerId,
        grantVerificationPublicKeyMultibase: publicKeyMultibase,
        now: () => 2_000,
      }),
      enableMdns: false,
      listen: { addresses: [] },
      rpcHandler: remoteRpcHandler,
    });
    await local.start();
    await remote.start();

    try {
      await remote.configureRelayReservation?.(
        await createRelayReservationToken({
          peerId: remoteIdentity.peerId,
          relayMultiaddrs: relay.multiaddrs,
        }),
      );
      await local.configureRelayReservation?.(
        await createRelayReservationToken({
          peerId: localIdentity.peerId,
          relayMultiaddrs: relay.multiaddrs,
        }),
      );
      const remoteRelayAddress = await waitForRelayAddress(remote);
      local.upsertDiscoveredDevice({
        peerId: remoteIdentity.peerId,
        displayName: 'Relay Desktop',
        platform: 'desktop',
        trustMode: 'cloud-account',
        trusted: true,
        reachability: { state: 'online', paths: ['relay'] },
        capabilities: { tools: [], mcpServers: [], hasWiki: false, agentLoop: true, imChannels: [], wikis: [] },
        multiaddrs: [remoteRelayAddress],
        lastSeen: Date.now(),
      });

      await expect(local.sendRpc(remoteIdentity.peerId, 'memeloop.test.ping', { via: 'relay' }, grant)).resolves.toEqual({
        pong: true,
        via: 'relay',
      });
      expect(remoteRpcHandler).toHaveBeenCalledWith(expect.objectContaining({
        remotePeerId: localIdentity.peerId,
        method: 'memeloop.test.ping',
        parameters: { via: 'relay' },
      }));
    } finally {
      await local.stop();
      await remote.stop();
      await relay.stop();
    }
  });
});
