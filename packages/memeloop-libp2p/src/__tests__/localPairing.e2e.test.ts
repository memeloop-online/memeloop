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

import {
  buildConversationFullContentMessagePage,
  buildConversationMessagePage,
  buildConversationMessageWindowAround,
  buildConversationTimelinePage,
  conversationEventToMessage,
  createAgentRuntimeDeviceRpcHandler,
  createChatMessage,
  createDeviceOrchestrationStreamHandler,
  createDeviceOrchestrationTransport,
  createJsonFrameReader,
  createLocalMessageDraft,
  createMemeLoopRuntime,
  encodeJsonFrame,
  LocalTrustDeviceAuthorizer,
  messageToConversationEvent,
  REMOTE_ORCHESTRATION_PROTOCOL,
} from 'memeloop';
import type {
  AgentDefinition,
  AgentFrameworkContext,
  AgentRuntimeRpcProjectionStore,
  AttachmentReference,
  ChatMessage,
  ConversationEvent,
  ConversationEventDraft,
  ConversationMeta,
  DetailReference,
  DeviceAuthorizer,
  DeviceCloudCommitFence,
  DeviceConnectionGrant,
  DeviceOrchestrationStreamHandler,
  DevicePlatform,
  DeviceRelayReservationToken,
  DeviceRpcHandler,
  DeviceTrustStore,
  FullAgentStorage,
  ILLMProvider,
  IToolRegistry,
  TrustedDeviceRecord,
} from 'memeloop';

import { CloudDeviceAuthorizer } from '../cloudDeviceAuthorizer.js';
import {
  buildDeviceConnectionGrantMessage,
  buildDeviceRelayReservationTokenMessage,
  createDeviceIdentity,
  Libp2pDeviceNetworkService,
  verifyDeviceRelayReservationToken,
} from '../libp2pDeviceNetworkService.js';

const RELAY_ADMISSION_PROTOCOL = '/memeloop/relay-admission/2.0.0';
const RELAY_ADMISSION_REQUEST_TYPE = 'memeloop-relay-admission-request-v2';
const RELAY_ADMISSION_RESPONSE_TYPE = 'memeloop-relay-admission-response-v2';

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

function createMemorySyncStorage(): FullAgentStorage & {
  conversations: Map<string, ConversationMeta>;
  messages: Map<string, ChatMessage[]>;
  events: Map<string, ConversationEvent>;
  attachmentReferences: Map<string, AttachmentReference>;
  attachmentData: Map<string, Uint8Array>;
  agentRunLogs: Map<string, ChatMessage[]>;
  getMessageById(conversationId: string, messageId: string): Promise<ChatMessage | null>;
  getMessageIdentity(conversationId: string, messageId: string): Promise<
    {
      messageId: string;
      timestamp: number;
      lamportClock: number;
      originNodeId: string;
    } | null
  >;
  readMessageDetailRange(
    conversationId: string,
    messageId: string,
    offset: number,
    maxBytes: number,
  ): Promise<{ found: false } | { found: true; offset: number; totalBytes: number; bytes: Uint8Array }>;
  readAttachmentRange(contentHash: string, offset: number, maxBytes: number): Promise<Uint8Array | null>;
  insertMessagesIfAbsent(messages: ChatMessage[]): Promise<void>;
} {
  const conversations = new Map<string, ConversationMeta>();
  const messages = new Map<string, ChatMessage[]>();
  const events = new Map<string, ConversationEvent>();
  const attachmentReferences = new Map<string, AttachmentReference>();
  const attachmentData = new Map<string, Uint8Array>();
  const agentRunLogs = new Map<string, ChatMessage[]>();
  const revisionFor = (conversationId: string): string => {
    const rows = messages.get(conversationId) ?? [];
    return `fixture:${rows.length}:${rows.reduce((maximum, row) => Math.max(maximum, row.lamportClock), 0)}`;
  };
  const allEvents = (): ConversationEvent[] => {
    const combined = new Map(events);
    for (const conversationMessages of messages.values()) {
      for (const message of conversationMessages) {
        const event = messageToConversationEvent(message);
        if (!combined.has(event.eventId)) combined.set(event.eventId, event);
      }
    }
    return [...combined.values()];
  };
  const projectEvent = (event: ConversationEvent): void => {
    if (event.kind === 'message') {
      const list = messages.get(event.conversationId) ?? [];
      if (!list.some(message => message.messageId === event.message.messageId)) {
        list.push(conversationEventToMessage(event));
        messages.set(event.conversationId, list);
      }
    } else if (event.kind === 'tombstone') {
      messages.set(
        event.conversationId,
        (messages.get(event.conversationId) ?? []).filter(message => message.turnId !== event.targetTurnId),
      );
    }
    const existing = conversations.get(event.conversationId);
    const projectedMessages = messages.get(event.conversationId) ?? [];
    conversations.set(event.conversationId, {
      conversationId: event.conversationId,
      title: event.kind === 'metadataPatch' && event.patch.title !== undefined
        ? event.patch.title
        : existing?.title ?? event.conversationId,
      lastMessagePreview: projectedMessages.at(-1)?.content ?? '',
      lastMessageTimestamp: Math.max(existing?.lastMessageTimestamp ?? 0, event.timestamp),
      messageCount: projectedMessages.length,
      originNodeId: existing?.originNodeId ?? event.originNodeId,
      originClock: Math.max(existing?.originClock ?? 0, event.lamportClock),
      definitionId: event.kind === 'metadataPatch' && event.patch.definitionId !== undefined
        ? event.patch.definitionId
        : existing?.definitionId ?? 'memeloop:test',
      instanceDelta: event.kind === 'metadataPatch' && event.patch.instanceDelta !== undefined
        ? event.patch.instanceDelta
        : existing?.instanceDelta,
      isUserInitiated: event.kind === 'metadataPatch' && event.patch.isUserInitiated !== undefined
        ? event.patch.isUserInitiated
        : existing?.isUserInitiated ?? true,
      sourceChannel: event.kind === 'metadataPatch'
        ? event.patch.sourceChannel ?? undefined
        : existing?.sourceChannel,
    });
  };
  const insertEventsIfAbsent = async (incoming: readonly ConversationEvent[]): Promise<void> => {
    for (const event of incoming) {
      const existing = events.get(event.eventId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new Error('conversation_event_payload_conflict');
      }
      const occupied = allEvents().find(candidate =>
        candidate.conversationId === event.conversationId &&
        candidate.originNodeId === event.originNodeId &&
        candidate.originSequence === event.originSequence &&
        candidate.eventId !== event.eventId
      );
      if (occupied) throw new Error('conversation_event_sequence_already_occupied');
    }
    for (const event of incoming) {
      if (events.has(event.eventId)) continue;
      events.set(event.eventId, event);
      projectEvent(event);
    }
  };
  const insertMessagesIfAbsent = async (incoming: ChatMessage[]): Promise<void> => {
    await insertEventsIfAbsent(incoming.map(messageToConversationEvent));
  };
  const allocateLocalEvent = (
    draft: ConversationEventDraft,
    pending: readonly ConversationEvent[] = [],
  ): ConversationEvent => {
    const current = [...allEvents(), ...pending];
    const sameOrigin = current.filter(event => event.conversationId === draft.conversationId && event.originNodeId === draft.originNodeId);
    return {
      ...draft,
      originSequence: Math.max(0, ...sameOrigin.map(item => item.originSequence)) + 1,
      lamportClock: Math.max(
        0,
        ...current
          .filter(item => item.conversationId === draft.conversationId)
          .map(item => item.lamportClock),
      ) + 1,
    } as ConversationEvent;
  };
  const appendLocalEvent = async (draft: ConversationEventDraft): Promise<ConversationEvent> => {
    const event = allocateLocalEvent(draft);
    await insertEventsIfAbsent([event]);
    return event;
  };
  return {
    conversations,
    messages,
    events,
    attachmentReferences,
    attachmentData,
    listConversationsPage: async (options) => {
      const ordered = [...conversations.values()].sort((left, right) =>
        right.lastMessageTimestamp - left.lastMessageTimestamp ||
        left.conversationId.localeCompare(right.conversationId)
      );
      const items = ordered.slice(0, options.limit);
      return {
        reset: false,
        items,
        revision: 'fixture-v1',
        total: ordered.length,
        hasMoreBefore: false,
        hasMoreAfter: ordered.length > items.length,
      };
    },
    getMessageById: async (conversationId, messageId) => messages.get(conversationId)?.find(message => message.messageId === messageId) ?? null,
    getMessageIdentity: async (conversationId, messageId) => {
      const message = messages.get(conversationId)?.find(candidate => candidate.messageId === messageId);
      return message
        ? {
          messageId: message.messageId,
          timestamp: message.timestamp,
          lamportClock: message.lamportClock,
          originNodeId: message.originNodeId,
        }
        : null;
    },
    readMessageDetailRange: async (conversationId, messageId, offset, maxBytes) => {
      const message = messages.get(conversationId)?.find(candidate => candidate.messageId === messageId);
      if (!message) return { found: false as const };
      const encoded = new TextEncoder().encode(JSON.stringify(message));
      return {
        found: true as const,
        offset,
        totalBytes: encoded.byteLength,
        bytes: encoded.slice(offset, offset + maxBytes),
      };
    },
    getMessagePage: async (conversationId, options) =>
      buildConversationMessagePage(
        messages.get(conversationId) ?? [],
        conversationId,
        options,
        revisionFor(conversationId),
      ),
    getFullContentMessagePage: async (conversationId, options) =>
      buildConversationFullContentMessagePage(
        messages.get(conversationId) ?? [],
        conversationId,
        options,
        revisionFor(conversationId),
      ),
    getMessageWindowAround: async (conversationId, options) =>
      buildConversationMessageWindowAround(
        allEvents(),
        conversationId,
        options,
        revisionFor(conversationId),
      ),
    getConversationTimelinePage: async (conversationId, options) =>
      buildConversationTimelinePage(
        allEvents(),
        conversationId,
        options,
        revisionFor(conversationId),
      ),
    getConversationEventPage: async (conversationId, options) => {
      const ranges = options.ranges;
      const compare = (left: ConversationEvent, right: ConversationEvent): number =>
        left.originNodeId.localeCompare(right.originNodeId) ||
        left.originSequence - right.originSequence ||
        left.eventId.localeCompare(right.eventId);
      const cursorCompare = (event: ConversationEvent): number => {
        if (!options.after) return 1;
        return event.originNodeId.localeCompare(options.after.originNodeId) ||
          event.originSequence - options.after.originSequence ||
          event.eventId.localeCompare(options.after.eventId);
      };
      const candidates = allEvents()
        .filter(event => event.conversationId === conversationId)
        .filter(event =>
          !ranges || ranges.some(range =>
            event.originNodeId === range.originNodeId &&
            event.originSequence > range.fromExclusive &&
            event.originSequence <= range.toInclusive
          )
        )
        .filter(event => options.after === undefined || cursorCompare(event) > 0)
        .sort(compare);
      const items = candidates.slice(0, options.limit);
      const cursor = items.at(-1);
      return {
        items,
        hasMoreBefore: options.after !== undefined,
        hasMoreAfter: candidates.length > items.length,
        ...(items[0]
          ? {
            startCursor: {
              originNodeId: items[0].originNodeId,
              originSequence: items[0].originSequence,
              eventId: items[0].eventId,
            },
          }
          : {}),
        ...(cursor
          ? {
            endCursor: {
              originNodeId: cursor.originNodeId,
              originSequence: cursor.originSequence,
              eventId: cursor.eventId,
            },
          }
          : {}),
      };
    },
    appendLocalEvent,
    appendLocalEventsAtomic: async (drafts: readonly ConversationEventDraft[]) => {
      const appended: ConversationEvent[] = [];
      for (const draft of drafts) appended.push(allocateLocalEvent(draft, appended));
      await insertEventsIfAbsent(appended);
      return appended;
    },
    insertEventsIfAbsent,
    getEventVersionFrontierPage: async options => {
      const rows = await (async () => {
        const selected = options.conversationIds ? new Set(options.conversationIds) : undefined;
        const sequences = new Map<string, Set<number>>();
        for (const event of allEvents()) {
          if (selected && !selected.has(event.conversationId)) continue;
          const key = JSON.stringify([event.conversationId, event.originNodeId]);
          const values = sequences.get(key) ?? new Set<number>();
          values.add(event.originSequence);
          sequences.set(key, values);
        }
        return [...sequences].flatMap(([key, values]) => {
          const [conversationId, originNodeId] = JSON.parse(key) as [string, string];
          let frontier = 0;
          while (values.has(frontier + 1)) frontier += 1;
          return frontier > 0
            ? [{
              conversationId,
              originNodeId,
              maxContiguousOriginSequence: frontier,
            }]
            : [];
        }).sort((left, right) =>
          left.conversationId.localeCompare(right.conversationId) ||
          left.originNodeId.localeCompare(right.originNodeId)
        );
      })();
      const filtered = rows.filter(frontier =>
        options.after === undefined ||
        frontier.conversationId > options.after.conversationId ||
        frontier.conversationId === options.after.conversationId &&
          frontier.originNodeId > options.after.originNodeId
      );
      const items = filtered.slice(0, options.limit);
      const last = items.at(-1);
      return {
        items,
        ...(filtered.length > items.length && last
          ? {
            nextCursor: { conversationId: last.conversationId, originNodeId: last.originNodeId },
          }
          : {}),
      };
    },
    getEventVersionFrontiersForKeys: async keys => {
      const selected = new Set(keys.map(key =>
        JSON.stringify([
          key.conversationId,
          key.originNodeId,
        ])
      ));
      const frontiers = new Map<string, Set<number>>();
      for (const event of allEvents()) {
        const key = JSON.stringify([event.conversationId, event.originNodeId]);
        if (!selected.has(key)) continue;
        const values = frontiers.get(key) ?? new Set<number>();
        values.add(event.originSequence);
        frontiers.set(key, values);
      }
      return [...frontiers].flatMap(([key, values]) => {
        const [conversationId, originNodeId] = JSON.parse(key) as [string, string];
        let frontier = 0;
        while (values.has(frontier + 1)) frontier += 1;
        return frontier > 0
          ? [{
            conversationId,
            originNodeId,
            maxContiguousOriginSequence: frontier,
          }]
          : [];
      });
    },
    getCompactionCandidatePage: async (_conversationId, options) => ({
      messages: [],
      nextCoveredVersion: { ...options.afterCoveredVersion },
      newlyCoveredMessageCountByOrigin: {},
      newlyCoveredUserTurnCountByOrigin: {},
      hasMore: false,
    }),
    getRetainedCompactionControls: async () => ({
      items: [],
      hasMore: false,
      invalidated: false,
    }),
    upsertConversationMetadata: async (meta: ConversationMeta) => {
      conversations.set(meta.conversationId, meta);
    },
    insertMessagesIfAbsent,
    getAttachment: async (contentHash: string) => attachmentReferences.get(contentHash) ?? null,
    saveAttachment: async (reference: AttachmentReference, data: Buffer | Uint8Array) => {
      attachmentReferences.set(reference.contentHash, reference);
      attachmentData.set(
        reference.contentHash,
        data instanceof Uint8Array ? data : new Uint8Array(data),
      );
    },
    readAttachmentData: async (contentHash: string) => attachmentData.get(contentHash) ?? null,
    readAttachmentRange: async (contentHash: string, offset: number, maxBytes: number) => attachmentData.get(contentHash)?.slice(offset, offset + maxBytes) ?? null,
    stageAttachmentChunk: async (reference, offset, data) => {
      const bytes = attachmentData.get(reference.contentHash) ?? new Uint8Array(reference.size);
      bytes.set(data, offset);
      attachmentReferences.set(reference.contentHash, reference);
      attachmentData.set(reference.contentHash, bytes);
      return offset + data.byteLength;
    },
    commitStagedAttachment: async () => undefined,
    verifyAttachment: async contentHash => {
      const reference = attachmentReferences.get(contentHash);
      const bytes = attachmentData.get(contentHash);
      if (!reference || !bytes || bytes.byteLength !== reference.size) return false;
      const match = /^sha256:([\da-f]{64})$/iu.exec(contentHash);
      if (!match) return false;
      const digestInput = new Uint8Array(bytes);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput.buffer));
      return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('') === match[1];
    },
    conversationReferencesAttachment: async (conversationId: string, contentHash: string) =>
      allEvents().some(event =>
        event.conversationId === conversationId && event.kind === 'message' &&
        (event.message.attachments?.some(reference => reference.contentHash === contentHash) ||
          event.message.parts?.some(part => part.type === 'attachment' && part.attachment.contentHash === contentHash))
      ),
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
    originClock: 1,
    definitionId: 'memeloop:test',
    isUserInitiated: true,
  };
}

function createMessage(input: {
  messageId: string;
  conversationId: string;
  originNodeId: string;
  content: string;
  role?: ChatMessage['role'];
  attachments?: AttachmentReference[];
  detailRef?: DetailReference;
}): ChatMessage {
  return createChatMessage({
    messageId: input.messageId,
    turnId: input.messageId,
    conversationId: input.conversationId,
    originNodeId: input.originNodeId,
    timestamp: Date.now(),
    originSequence: 1,
    lamportClock: 1,
    role: input.role ?? 'assistant',
    content: input.content,
    attachments: input.attachments,
    detailRef: input.detailRef,
  });
}

async function createGrant(input: {
  subjectPeerId: string;
  allowedPeerId: string;
  accountId?: string;
  seedByte?: number;
}): Promise<{ grant: DeviceConnectionGrant; publicKeyMultibase: string }> {
  const { generateKeyPairFromSeed, publicKeyToProtobuf } = await import('@libp2p/crypto/keys');
  const { toString } = await import('uint8arrays');
  const privateKey = await generateKeyPairFromSeed(
    'Ed25519',
    new Uint8Array(32).fill(input.seedByte ?? 9),
  );
  const publicKeyMultibase = `libp2p-pub:${toString(publicKeyToProtobuf(privateKey.publicKey), 'base64url')}`;
  const unsignedGrant: Omit<DeviceConnectionGrant, 'signature'> = {
    issuer: 'memeloop-cloud' as const,
    accountId: input.accountId ?? 'account-1',
    subjectPeerId: input.subjectPeerId,
    allowedPeerIds: [input.allowedPeerId],
    protocols: ['/memeloop/rpc/2.0.0', '/memeloop/sync/2.0.0'],
    rpcMethodScope: { mode: 'all' as const },
    conversationScope: { mode: 'all' as const },
    definitionScope: { mode: 'all' as const },
    issuedAt: 1_000,
    expiresAt: 60_000,
  };
  return {
    publicKeyMultibase,
    grant: {
      ...unsignedGrant,
      signature: toString(
        await privateKey.sign(buildDeviceConnectionGrantMessage(unsignedGrant)),
        'base64url',
      ),
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
  const privateKey = await generateKeyPairFromSeed(
    'Ed25519',
    new Uint8Array(32).fill(input.seedByte ?? 17),
  );
  const unsigned = {
    issuer: 'memeloop-cloud' as const,
    accountId: input.accountId ?? 'account-1',
    peerId: input.peerId,
    relayMultiaddrs: input.relayMultiaddrs,
    bootstrapMultiaddrs: input.relayMultiaddrs,
    issuedAt: 1_000,
    expiresAt: 70_000,
  };
  return {
    ...unsigned,
    signature: toString(
      await privateKey.sign(buildDeviceRelayReservationTokenMessage(unsigned)),
      'base64url',
    ),
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
  const source = (async function*(): AsyncIterable<Uint8Array> {
    for await (const chunk of stream) {
      yield chunk instanceof Uint8Array ? chunk : chunk.subarray();
    }
  })();
  const reader = createJsonFrameReader(source, {
    maxPayloadBytes: 64 * 1024,
    idleTimeoutMs: 2_000,
    totalTimeoutMs: 10_000,
    abort: () => undefined,
  })[Symbol.asyncIterator]();
  try {
    const result = await reader.next();
    if (result.done) throw new Error('relay_admission_message_missing');
    return result.value;
  } catch (error) {
    stream.abort(
      error instanceof Error ? error : new Error('relay_admission_message_failed', {
        cause: error,
      }),
    );
    throw error;
  } finally {
    void reader.return?.();
  }
}

function writeRelayAdmissionJson(stream: Stream, message: unknown): void {
  stream.send(encodeJsonFrame(message, 64 * 1024));
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

async function withStageTimeout<T>(
  stage: string,
  timeoutMs: number,
  operation: Promise<T>,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`private_relay_stage_timeout:${stage}`));
        }, timeoutMs);
        if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function relayGenerationContext(generation: number): {
  signal: AbortSignal;
  fence: DeviceCloudCommitFence;
} {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    fence: {
      generation,
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
      throwIfStale: () => {
        controller.signal.throwIfAborted();
      },
      commitSynchronous: ((operation: () => unknown) => {
        if (controller.signal.aborted) return false;
        operation();
        return true;
      }) as DeviceCloudCommitFence['commitSynchronous'],
    },
  };
}

async function startMockPeerServer(
  platform: DevicePlatform,
  deviceName: string,
  options: {
    authorizer?: DeviceAuthorizer;
    syncStorage?: FullAgentStorage;
    rpcHandler?: DeviceRpcHandler;
    orchestrationHandler?: DeviceOrchestrationStreamHandler;
  } = {},
) {
  const identity = await createDeviceIdentity(platform, deviceName);
  const trustStore = createMemoryTrustStore();
  const authorizer = options.authorizer ?? new LocalTrustDeviceAuthorizer({
    getTrustedDevice: peerId => trustStore.records.get(peerId),
  });
  const service = new Libp2pDeviceNetworkService({
    identity,
    trustStore,
    authorizer,
    enableMdns: false,
    enableCircuitRelay: false,
    listen: { addresses: ['/ip4/127.0.0.1/tcp/0'] },
    syncStorage: options.syncStorage,
    rpcHandler: options.rpcHandler,
    orchestrationHandler: options.orchestrationHandler,
  });
  await service.start();
  return {
    identity,
    trustStore,
    authorizer,
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
      const inbound = (await mockPeer.service.listPairingSessions()).find(
        (session) => session.sessionId === outbound.sessionId,
      );

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

      await expect(local.syncWithDevice(mockPeer.identity.peerId)).rejects.toThrow(
        'sync_storage_not_configured',
      );
      await expect(mockPeer.service.syncWithDevice(localIdentity.peerId)).rejects.toThrow(
        'sync_storage_not_configured',
      );

      unsubscribe();
    } finally {
      await local.stop();
      await mockPeer.stop();
    }
  });

  it('carries resource requests and watches only after mutual Noise pairing', async () => {
    const remote = await startMockPeerServer('desktop', 'Control Desktop', {
      orchestrationHandler: createDeviceOrchestrationStreamHandler({
        resolveHandler: (remotePeerId) => ({
          async request(request) {
            return {
              protocol: REMOTE_ORCHESTRATION_PROTOCOL,
              requestId: request.requestId,
              ok: true,
              result: { remotePeerId, operation: request.operation },
            };
          },
          async *watch(request) {
            yield {
              protocol: REMOTE_ORCHESTRATION_PROTOCOL,
              requestId: request.requestId,
              ok: true,
              result: { type: 'BOOKMARK', resourceVersion: '9' },
            };
          },
        }),
      }),
    });
    const localIdentity = await createDeviceIdentity('mobile', 'MemeLoop Mobile');
    const local = new Libp2pDeviceNetworkService({
      identity: localIdentity,
      trustStore: createMemoryTrustStore(),
      enableMdns: false,
      listen: { addresses: [] },
      enableCircuitRelay: false,
    });
    await local.start();
    const transport = createDeviceOrchestrationTransport({
      deviceNetwork: local,
      peerId: remote.identity.peerId,
    });
    const request = {
      protocol: REMOTE_ORCHESTRATION_PROTOCOL,
      requestId: 'device-get',
      operation: 'get' as const,
      payload: {
        reference: {
          apiVersion: 'run.memeloop.io/v1alpha1',
          kind: 'AgentRun',
          name: 'run-1',
        },
      },
    };

    try {
      await expect(transport.request(request)).rejects.toThrow('device_not_trusted');

      const outbound = await local.requestLocalPairing(remote.identity.peerId, {
        multiaddrs: remote.multiaddrs,
      });
      const inbound = (await remote.service.listPairingSessions()).find(
        (session) => session.sessionId === outbound.sessionId,
      );
      expect(outbound.confirmCode).toBe(inbound?.confirmCode);
      await remote.service.acceptPairing(inbound!.sessionId);
      await local.acceptPairing(outbound.sessionId);

      await expect(transport.request(request)).resolves.toMatchObject({
        ok: true,
        result: {
          remotePeerId: localIdentity.peerId,
          operation: 'get',
        },
      });

      const events = [];
      for await (
        const event of transport.watch({
          protocol: REMOTE_ORCHESTRATION_PROTOCOL,
          requestId: 'device-watch',
          operation: 'watch',
          payload: { query: { kind: 'AgentRun' } },
        })
      ) {
        events.push(event);
      }
      expect(events).toEqual([
        {
          protocol: REMOTE_ORCHESTRATION_PROTOCOL,
          requestId: 'device-watch',
          ok: true,
          result: { type: 'BOOKMARK', resourceVersion: '9' },
        },
      ]);
    } finally {
      await local.stop();
      await remote.stop();
    }
  });

  it('syncs conversations, messages and attachments with a paired mock peer server', async () => {
    let remotePeerId = '';
    const remoteStorage = createMemorySyncStorage();
    const mockPeer = await startMockPeerServer('mobile', 'Mock Mobile', {
      syncStorage: remoteStorage,
    });
    remotePeerId = mockPeer.identity.peerId;
    const attachment = {
      contentHash: 'sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      filename: 'remote.txt',
      mimeType: 'text/plain',
      size: 11,
    };
    remoteStorage.conversations.set('conv-remote', createConversation('conv-remote', remotePeerId));
    remoteStorage.messages.set('conv-remote', [
      createMessage({
        messageId: 'msg-remote',
        conversationId: 'conv-remote',
        originNodeId: remotePeerId,
        content: 'from remote',
        attachments: [attachment],
      }),
    ]);
    remoteStorage.attachmentReferences.set(attachment.contentHash, attachment);
    remoteStorage.attachmentData.set(
      attachment.contentHash,
      new TextEncoder().encode('hello world'),
    );

    const localIdentity = await createDeviceIdentity('desktop', 'Local Desktop');
    const localTrustStore = createMemoryTrustStore();
    const localStorage = createMemorySyncStorage();
    localStorage.conversations.set(
      'conv-local',
      createConversation('conv-local', localIdentity.peerId),
    );
    localStorage.messages.set('conv-local', [
      createMessage({
        messageId: 'msg-local',
        conversationId: 'conv-local',
        originNodeId: localIdentity.peerId,
        content: 'from local',
      }),
    ]);
    const local = new Libp2pDeviceNetworkService({
      identity: localIdentity,
      trustStore: localTrustStore,
      enableMdns: false,
      enableCircuitRelay: false,
      listen: { addresses: [] },
      syncStorage: localStorage,
    });
    await local.start();

    try {
      const outbound = await local.requestLocalPairing(mockPeer.identity.peerId, {
        multiaddrs: mockPeer.multiaddrs,
      });
      const inbound = (await mockPeer.service.listPairingSessions()).find(
        (session) => session.sessionId === outbound.sessionId,
      );
      await mockPeer.service.acceptPairing(inbound!.sessionId);
      await local.acceptPairing(outbound.sessionId);

      await expect(local.syncWithDevice(mockPeer.identity.peerId)).resolves.toMatchObject({
        ok: true,
      });

      expect(localStorage.conversations.get('conv-remote')).toMatchObject({
        originNodeId: remotePeerId,
      });
      expect(localStorage.messages.get('conv-remote')).toEqual([
        expect.objectContaining({ messageId: 'msg-remote', content: 'from remote' }),
      ]);
      expect(
        new TextDecoder().decode(localStorage.attachmentData.get(attachment.contentHash)),
      ).toBe('hello world');
      expect(remoteStorage.messages.get('conv-local')).toEqual([
        expect.objectContaining({ messageId: 'msg-local', content: 'from local' }),
      ]);
    } finally {
      await local.stop();
      await mockPeer.stop();
    }
  });

  it('uses metadata originClock instead of messageCount as the origin version', async () => {
    let remotePeerId = '';
    const remoteStorage = createMemorySyncStorage();
    const mockPeer = await startMockPeerServer('desktop', 'Clock Remote', {
      syncStorage: remoteStorage,
    });
    remotePeerId = mockPeer.identity.peerId;
    remoteStorage.conversations.set('conv-clock', {
      ...createConversation('conv-clock', remotePeerId),
      messageCount: 999,
      originClock: 1,
    });

    const localIdentity = await createDeviceIdentity('mobile', 'Clock Local');
    const localStorage = createMemorySyncStorage();
    const local = new Libp2pDeviceNetworkService({
      identity: localIdentity,
      trustStore: createMemoryTrustStore(),
      enableMdns: false,
      enableCircuitRelay: false,
      listen: { addresses: [] },
      syncStorage: localStorage,
    });
    await local.start();

    try {
      const outbound = await local.requestLocalPairing(remotePeerId, {
        multiaddrs: mockPeer.multiaddrs,
      });
      const inbound = (await mockPeer.service.listPairingSessions()).find(
        (session) => session.sessionId === outbound.sessionId,
      );
      await mockPeer.service.acceptPairing(inbound!.sessionId);
      await local.acceptPairing(outbound.sessionId);

      await local.syncWithDevice(remotePeerId);

      expect(localStorage.conversations.has('conv-clock')).toBe(false);
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
      rpcHandler: async ({ method, parameters }) => {
        if (method !== 'memeloop.chat.pullAgentRunLog') throw new Error(`unexpected_rpc:${method}`);
        const params = parameters as Record<string, unknown>;
        const conversationId = params.conversationId as string;
        const logs = remoteStorage.agentRunLogs.get(conversationId) ?? [];
        return {
          messages: logs.map(({ messageId, role, content }) => ({ messageId, role, content })),
          hasMoreAfter: false,
          runStatus: null,
        };
      },
    });
    remotePeerId = mockPeer.identity.peerId;

    const detailRef: DetailReference = {
      type: 'agent-run',
      conversationId: 'conv-detail',
      nodeId: remotePeerId,
    };
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
    remoteStorage.agentRunLogs.set('conv-detail', [detailMessage]);

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
    });
    await local.start();

    try {
      const outbound = await local.requestLocalPairing(mockPeer.identity.peerId, {
        multiaddrs: mockPeer.multiaddrs,
      });
      const inbound = (await mockPeer.service.listPairingSessions()).find(
        (session) => session.sessionId === outbound.sessionId,
      );
      await mockPeer.service.acceptPairing(inbound!.sessionId);
      await local.acceptPairing(outbound.sessionId);

      await expect(local.syncWithDevice(mockPeer.identity.peerId)).resolves.toMatchObject({
        ok: true,
      });

      const localMessages = localStorage.messages.get('conv-detail') ?? [];
      expect(localMessages).toEqual([
        expect.objectContaining({ messageId: 'msg-detail-summary', detailRef }),
      ]);
      expect(localStorage.agentRunLogs.size).toBe(0);

      const pulled = await local.sendRpc<{ messages: ChatMessage[] }>(
        mockPeer.identity.peerId,
        'memeloop.chat.pullAgentRunLog',
        {
          conversationId: 'conv-detail',
          runId: 'run-detail',
          limit: 50,
          maxBytes: 256 * 1024,
        },
      );
      expect(pulled.messages).toEqual([
        expect.objectContaining({ messageId: 'msg-detail-internal' }),
      ]);
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
    remoteStorage.conversations.set(
      'conv-cloud',
      createConversation('conv-cloud', remoteIdentity.peerId),
    );
    remoteStorage.messages.set('conv-cloud', [
      createMessage({
        messageId: 'msg-cloud',
        conversationId: 'conv-cloud',
        originNodeId: remoteIdentity.peerId,
        content: 'from cloud peer',
      }),
    ]);

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
      await expect(local.syncWithDevice(remoteIdentity.peerId)).rejects.toThrow(
        'device_not_trusted',
      );

      await expect(local.syncWithDevice(remoteIdentity.peerId, {
        presentedGrant: grant,
      })).resolves.toMatchObject({
        ok: true,
      });

      expect(localStorage.conversations.get('conv-cloud')).toMatchObject({
        originNodeId: remoteIdentity.peerId,
      });
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
    remoteStorage.conversations.set(
      'conv-cross-account',
      createConversation('conv-cross-account', remoteIdentity.peerId),
    );
    remoteStorage.messages.set('conv-cross-account', [
      createMessage({
        messageId: 'msg-cross-account',
        conversationId: 'conv-cross-account',
        originNodeId: remoteIdentity.peerId,
        content: 'should not sync across accounts',
      }),
    ]);
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
        capabilities: {
          tools: [],
          mcpServers: [],
          hasWiki: false,
          agentLoop: false,
          imChannels: [],
          wikis: [],
        },
        multiaddrs: remote.getMultiaddrs(),
        lastSeen: Date.now(),
      });

      await expect(
        local.syncWithDevice(remoteIdentity.peerId, { presentedGrant: accountAGrant.grant }),
      ).rejects.toThrow('device_not_trusted');
      await expect(
        local.sendRpc(remoteIdentity.peerId, 'memeloop.test.ping', {}, {
          presentedGrant: accountAGrant.grant,
        }),
      ).rejects.toThrow('device_not_trusted');

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
      localNodeId: remotePeerId,
      storage: remoteStorage,
      llmProvider,
      tools,
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      runAgentToolLoop: async function*(input) {
        const messageId = `${input.conversationId}:remote-assistant`;
        await remoteStorage.appendLocalEvent(createLocalMessageDraft({
          messageId,
          turnId: messageId,
          conversationId: input.conversationId,
          originNodeId: remotePeerId,
          timestamp: Date.now(),
          role: 'assistant',
          content: `remote:${input.message}`,
        }));
        yield { type: 'message' as const, data: `remote:${input.message}` };
      },
    };
    const runtime = createMemeLoopRuntime(context, { allowEphemeralRunState: true });
    const unusedProjections: AgentRuntimeRpcProjectionStore = {
      listConversations: async () => {
        throw new Error('projection_not_expected');
      },
      listTurns: async () => {
        throw new Error('projection_not_expected');
      },
      getTurnDetail: async () => {
        throw new Error('projection_not_expected');
      },
    };
    remoteRpcHandlerRef.current = createAgentRuntimeDeviceRpcHandler({
      runtime,
      storage: remoteStorage,
      projections: unusedProjections,
      scheduledTaskHandler: async () => {
        throw new Error('scheduled_task_not_expected');
      },
      getAgentDefinitions: () => [definition],
      localNodeId: remotePeerId,
      authorize: request =>
        mockPeer.authorizer.canOpenProtocol({
          remotePeerId: request.remotePeerId,
          protocol: '/memeloop/rpc/2.0.0',
          direction: 'inbound',
          presentedGrant: request.presentedGrant,
        }),
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
    });
    await local.start();

    try {
      const outbound = await local.requestLocalPairing(mockPeer.identity.peerId, {
        multiaddrs: mockPeer.multiaddrs,
      });
      const inbound = (await mockPeer.service.listPairingSessions()).find(
        (session) => session.sessionId === outbound.sessionId,
      );
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
        role: 'user',
      });

      await expect(
        local.sendRpc(mockPeer.identity.peerId, 'memeloop.agent.runTurn', {
          conversation,
          conversationId: conversation.conversationId,
          definitionId: definition.id,
          message: 'do it remotely',
          requestId: 'remote-run-request-1',
          turnId: localUserMessage.messageId,
          userMessage: { content: localUserMessage.content },
        }),
      ).resolves.toMatchObject({ ok: true, conversationId: conversation.conversationId });

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
      relayReservationVerification: {
        getVerificationPublicKeyMultibase: () => relayAdmissionKey,
        reservationTtlMs: 60_000,
        reservationSafetyMarginMs: 1_000,
        now: () => 2_000,
      },
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
      relayReservationVerification: {
        getVerificationPublicKeyMultibase: () => relayAdmissionKey,
        reservationTtlMs: 60_000,
        reservationSafetyMarginMs: 1_000,
        now: () => 2_000,
      },
      enableMdns: false,
      listen: { addresses: [] },
      rpcHandler: remoteRpcHandler,
    });
    const remoteRelayGeneration = relayGenerationContext(1);
    const localRelayGeneration = relayGenerationContext(2);
    try {
      await withStageTimeout('local-start', 10_000, local.start());
      await withStageTimeout('remote-start', 10_000, remote.start());
      await withStageTimeout(
        'remote-relay-reservation',
        20_000,
        remote.configureRelayReservation(
          await createRelayReservationToken({
            peerId: remoteIdentity.peerId,
            relayMultiaddrs: relay.multiaddrs,
          }),
          remoteRelayGeneration.signal,
          remoteRelayGeneration.fence,
        ),
      );
      await withStageTimeout(
        'local-relay-reservation',
        20_000,
        local.configureRelayReservation(
          await createRelayReservationToken({
            peerId: localIdentity.peerId,
            relayMultiaddrs: relay.multiaddrs,
          }),
          localRelayGeneration.signal,
          localRelayGeneration.fence,
        ),
      );
      const remoteRelayAddress = await withStageTimeout(
        'remote-relay-address',
        5_000,
        waitForRelayAddress(remote),
      );
      local.upsertDiscoveredDevice({
        peerId: remoteIdentity.peerId,
        displayName: 'Relay Desktop',
        platform: 'desktop',
        trustMode: 'cloud-account',
        trusted: true,
        reachability: { state: 'online', paths: ['relay'] },
        capabilities: {
          tools: [],
          mcpServers: [],
          hasWiki: false,
          agentLoop: true,
          imChannels: [],
          wikis: [],
        },
        multiaddrs: [remoteRelayAddress],
        lastSeen: Date.now(),
      });

      await expect(
        withStageTimeout(
          'relay-rpc',
          35_000,
          local.sendRpc(
            remoteIdentity.peerId,
            'memeloop.chat.getConversationMeta',
            { conversationId: 'relay-conversation' },
            { presentedGrant: grant },
          ),
        ),
      ).resolves.toEqual({
        pong: true,
        via: 'relay',
      });
      expect(remoteRpcHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          remotePeerId: localIdentity.peerId,
          method: 'memeloop.chat.getConversationMeta',
          parameters: { conversationId: 'relay-conversation' },
        }),
      );
    } finally {
      // Tear down all three ends concurrently. Sequential shutdown can make a
      // relay wait on a peer whose close handshake is itself waiting on the
      // relay, and under a loaded monorepo test run those waits accumulate until
      // the test-level timeout even though the RPC assertion already passed.
      await withStageTimeout(
        'cleanup',
        15_000,
        Promise.allSettled([local.stop(), remote.stop(), relay.stop()]),
      );
    }
    // The assertion uses real TCP, Noise, Yamux and circuit-relay reservation
    // handshakes. Keep the budget above the production RPC total timeout so the
    // monorepo's parallel CI load cannot turn scheduler contention into a false
    // negative; every protocol operation retains its own bounded timeout.
  }, 90_000);
});
