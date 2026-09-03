import type { AttachmentReference, ConversationEvent, ConversationEventCursor } from '../conversation/index.js';
import {
  assertCanonicalConversationEvent,
  assertCanonicalConversationEvents,
  canonicalConversationEventBytes,
  conversationEventAttachmentReferences,
} from '../conversation/index.js';
import { MAX_SYNC_ATTACHMENT_BYTES, MAX_SYNC_ATTACHMENT_CHUNK_BYTES } from '../device-network/libp2pSyncProtocol.js';
import type { ConversationEventPage as StoredConversationEventPage, MessageVersionFrontier, MessageVersionFrontierCursor, MessageVersionFrontierPage } from '../storage/ports.js';
import { type ConversationEventSyncPage, type VersionRange, versionVectorKey } from './protocol.js';

import type { FullAgentStorage } from '../types.js';
import { assertAgentUserMessageWithinLimits, assertConversationMessageWithinPagingLimits } from '../userMessageAdmission.js';

const EVENT_PUSH_PAGE_MAX_BYTES = 12 * 1024 * 1024;
const EVENT_PAGE_MAX_ITEMS = 128;
const FRONTIER_PAGE_MAX_ITEMS = 128;
const MAX_SYNC_ID_LENGTH = 512;
const MAX_SYNC_CONVERSATION_SCOPE = 256;
const MAX_SYNC_WORK_PAGES_PER_PEER_PASS = 64;
/**
 * Frontier discovery is cheap, bounded metadata work rather than body
 * transfer. Keeping a separate ceiling lets a restarted engine rebuild its
 * position from durable frontiers without weakening the 64 transfer-page
 * limit. 2,048 pages cover 262,144 distinct origin frontiers per pass.
 */
const MAX_SYNC_FRONTIER_SCAN_PAGES_PER_PEER_PASS = 2_048;
const MAX_SYNC_EVENTS_PER_PEER_PASS = 4_096;
const MAX_SYNC_BYTES_PER_PEER_PASS = 80 * 1024 * 1024;
const MAX_SYNC_PEERS_PER_PASS = 64;
const utf8Encoder = new TextEncoder();

interface PeerSyncContinuation {
  localAfter?: MessageVersionFrontierCursor;
  remoteAfter?: MessageVersionFrontierCursor;
  localDone: boolean;
  remoteDone: boolean;
}

interface PeerSyncWorkBudget {
  frontierPages: number;
  pages: number;
  events: number;
  bytes: number;
  exhausted: boolean;
  global: SyncPassWorkBudget;
}

interface SyncPassWorkBudget {
  frontierPages: number;
  pages: number;
  events: number;
  bytes: number;
  exhausted: boolean;
  limits: ChatSyncPassLimits;
}

export interface SyncIoOptions {
  signal?: AbortSignal;
}

export interface ChatSyncPassProgress {
  peers: number;
  /** Frontier metadata pages inspected while discovering transfer work. */
  frontierPages: number;
  /** Event/attachment transfer pages; hard-limited independently of discovery. */
  pages: number;
  events: number;
  bytes: number;
}

export interface ChatSyncPassResult {
  complete: boolean;
  progress: ChatSyncPassProgress;
  /** Present only when another bounded pass can make forward progress. */
  continuation?: {
    reason: 'work-budget';
    pendingPeerIds: string[];
  };
}

export interface ChatSyncPassLimits {
  maxPeers: number;
  maxFrontierPages: number;
  maxPages: number;
  maxEvents: number;
  maxBytes: number;
}

export interface ChatSyncPeer {
  nodeId: string;
  exchangeVersionFrontierPage(
    localFrontiers: MessageVersionFrontier[],
    remoteAfter: MessageVersionFrontierCursor | undefined,
    includeRemotePage: boolean,
    conversationIds?: string[],
    options?: SyncIoOptions,
  ): Promise<{
    remotePage: MessageVersionFrontierPage;
    missingForRemote: VersionRange[];
  }>;
  pullMissingEvents?(
    conversationId: string,
    ranges: VersionRange[],
    cursor?: ConversationEventCursor,
    options?: SyncIoOptions,
  ): Promise<ConversationEventSyncPage>;
  pullAttachmentChunk?(
    conversationId: string,
    contentHash: string,
    offset: number,
    maxBytes: number,
    options?: SyncIoOptions,
  ): Promise<
    {
      data: Uint8Array;
      offset: number;
      totalSize: number;
      done: boolean;
      filename: string;
      mimeType: string;
    } | null
  >;
  pushEvents?(events: ConversationEvent[], options?: SyncIoOptions): Promise<void>;
  pushAttachmentChunk?(
    conversationId: string,
    contentHash: string,
    chunk: {
      data: Uint8Array;
      offset: number;
      totalSize: number;
      done: boolean;
      filename: string;
      mimeType: string;
    },
    options?: SyncIoOptions,
  ): Promise<void>;
}

export interface ChatSyncEngineOptions {
  nodeId: string;
  storage: FullAgentStorage;
  peers: () => ChatSyncPeer[];
  /** Surface body-transfer failures to an interactive caller instead of relying on the next pass. */
  failOnMessageSyncError?: boolean;
  signal?: AbortSignal;
  /** Restrict this pass to these conversations; undefined means the full store. */
  conversationIds?: readonly string[];
  /** Optional lower ceilings for one foreground pass; hard protocol ceilings cannot be raised. */
  passLimits?: Partial<ChatSyncPassLimits>;
}

/** Bidirectional, raw-event anti-entropy for conversation state. */
export class ChatSyncEngine {
  private readonly nodeId: string;
  private readonly storage: FullAgentStorage;
  private readonly getPeers: () => ChatSyncPeer[];
  private readonly failOnMessageSyncError: boolean;
  private readonly defaultSignal?: AbortSignal;
  private activeSignal?: AbortSignal;
  private readonly conversationIds?: string[];
  private readonly passLimits: ChatSyncPassLimits;
  private readonly continuations = new Map<string, PeerSyncContinuation>();
  private readonly pendingAttachmentPushes = new Map<string, Set<string>>();
  private nextPeerAfter?: string;
  private inFlightSync?: Promise<ChatSyncPassResult>;

  constructor(options: ChatSyncEngineOptions) {
    if (!isValidSyncIdentifier(options.nodeId)) throw new Error('invalid_sync_node_id');
    this.nodeId = options.nodeId;
    this.storage = options.storage;
    this.getPeers = options.peers;
    this.failOnMessageSyncError = options.failOnMessageSyncError ?? false;
    this.defaultSignal = options.signal;
    this.passLimits = resolvePassLimits(options.passLimits);
    this.conversationIds = options.conversationIds === undefined
      ? undefined
      : [...new Set(options.conversationIds)].sort(compareCodeUnits);
    if (
      this.conversationIds !== undefined &&
      (this.conversationIds.length > MAX_SYNC_CONVERSATION_SCOPE ||
        this.conversationIds.some(conversationId => !isValidSyncIdentifier(conversationId)))
    ) {
      throw new Error('invalid_sync_conversation_scope');
    }
  }

  public syncOnce(options: SyncIoOptions = {}): Promise<ChatSyncPassResult> {
    if (this.inFlightSync) return this.inFlightSync;
    this.activeSignal = options.signal ?? this.defaultSignal;
    const running = this.runSyncOnce();
    this.inFlightSync = running;
    const release = (): void => {
      if (this.inFlightSync === running) {
        this.inFlightSync = undefined;
        this.activeSignal = undefined;
      }
    };
    void running.then(release, release);
    return running;
  }

  private async runSyncOnce(): Promise<ChatSyncPassResult> {
    this.throwIfAborted();
    const peers = this.collectPeers();
    const activePeerIds = new Set(peers.map(peer => peer.nodeId));
    this.garbageCollectPeerState(activePeerIds);
    if (this.conversationIds?.length === 0) {
      return {
        complete: true,
        progress: { peers: 0, frontierPages: 0, pages: 0, events: 0, bytes: 0 },
      };
    }
    if (!this.storage.getEventVersionFrontierPage || !this.storage.getEventVersionFrontiersForKeys) {
      throw new Error('sync_event_frontier_store_not_configured');
    }
    const orderedPeers = rotatePeers(peers, this.nextPeerAfter);
    const globalBudget = createSyncPassWorkBudget(this.passLimits);
    const progress: ChatSyncPassProgress = {
      peers: 0,
      frontierPages: 0,
      pages: 0,
      events: 0,
      bytes: 0,
    };
    const pendingPeerIds: string[] = [];
    let complete = true;
    let processedPeers = 0;
    const scheduledPeers = orderedPeers.slice(0, this.passLimits.maxPeers);
    for (const peer of scheduledPeers) {
      if (globalBudget.frontierPages >= globalBudget.limits.maxFrontierPages) {
        globalBudget.exhausted = true;
        complete = false;
        break;
      }
      const budget = createPeerSyncWorkBudget(globalBudget);
      try {
        const peerComplete = await this.syncPeerFrontierPages(peer, scheduledPeers, budget);
        if (!peerComplete) {
          complete = false;
          if (budget.exhausted) {
            pendingPeerIds.push(peer.nodeId);
          } else if (this.failOnMessageSyncError) {
            throw new Error(`event_sync_incomplete:${peer.nodeId}`);
          }
        }
      } catch (error) {
        this.throwIfAborted();
        if (this.failOnMessageSyncError) throw error;
        complete = false;
      } finally {
        processedPeers += 1;
        this.nextPeerAfter = peer.nodeId;
        progress.peers += 1;
        progress.frontierPages += budget.frontierPages;
        progress.pages += budget.pages;
        progress.events += budget.events;
        progress.bytes += budget.bytes;
      }
      if (globalBudget.exhausted) break;
    }
    const skippedPeers = orderedPeers.slice(processedPeers);
    if (skippedPeers.length > 0) {
      complete = false;
      for (const peer of skippedPeers.slice(0, this.passLimits.maxPeers)) {
        pendingPeerIds.push(peer.nodeId);
      }
    } else if (complete) {
      this.nextPeerAfter = undefined;
    }
    const boundedPendingPeerIds = [...new Set(pendingPeerIds)].slice(0, this.passLimits.maxPeers);
    return {
      complete,
      progress,
      ...(boundedPendingPeerIds.length > 0
        ? { continuation: { reason: 'work-budget' as const, pendingPeerIds: boundedPendingPeerIds } }
        : {}),
    };
  }

  public antiEntropyOnce(options: SyncIoOptions = {}): Promise<ChatSyncPassResult> {
    return this.syncOnce(options);
  }

  private async syncPeerFrontierPages(
    peer: ChatSyncPeer,
    attachmentPeers: ChatSyncPeer[],
    budget: PeerSyncWorkBudget,
  ): Promise<boolean> {
    const continuation = this.continuations.get(peer.nodeId);
    let localAfter = continuation?.localAfter;
    let remoteAfter = continuation?.remoteAfter;
    let localDone = continuation?.localDone ?? false;
    let remoteDone = continuation?.remoteDone ?? false;
    do {
      this.throwIfAborted();
      if (!consumeFrontierScanPage(budget)) {
        this.saveContinuation(peer.nodeId, { localAfter, remoteAfter, localDone, remoteDone });
        return false;
      }
      const localPage: MessageVersionFrontierPage = localDone
        ? { items: [] }
        : await this.storage.getEventVersionFrontierPage({
          limit: FRONTIER_PAGE_MAX_ITEMS,
          ...(localAfter ? { after: localAfter } : {}),
          ...(this.conversationIds ? { conversationIds: this.conversationIds } : {}),
          signal: this.activeSignal,
        });
      this.assertValidFrontierPage(localPage, localAfter, 'storage');
      const exchange = await peer.exchangeVersionFrontierPage(
        localPage.items,
        remoteAfter,
        !remoteDone,
        this.conversationIds,
        { signal: this.activeSignal },
      );
      this.assertValidFrontierPage(exchange.remotePage, remoteAfter, peer.nodeId, remoteDone);
      if (
        !isValidVersionRanges(exchange.missingForRemote) ||
        !rangesMatchOfferedFrontiers(exchange.missingForRemote, localPage.items)
      ) {
        throw new Error(`inconsistent_sync_exchange:${peer.nodeId}`);
      }
      this.assertScopedRanges(exchange.missingForRemote, peer.nodeId);
      const pushComplete = await this.pushEventsToPeer(peer, exchange.missingForRemote, budget);
      if (!pushComplete) {
        this.saveContinuation(peer.nodeId, { localAfter, remoteAfter, localDone, remoteDone });
        return false;
      }

      const localForRemote = await this.storage.getEventVersionFrontiersForKeys(
        exchange.remotePage.items.map(frontier => ({
          conversationId: frontier.conversationId,
          originNodeId: frontier.originNodeId,
        })),
        { signal: this.activeSignal },
      );
      const localByKey = new Map(localForRemote.map(frontier => [
        versionVectorKey(frontier.conversationId, frontier.originNodeId),
        frontier.maxContiguousOriginSequence,
      ]));
      const missingForLocal = exchange.remotePage.items.flatMap(frontier => {
        const current = localByKey.get(versionVectorKey(
          frontier.conversationId,
          frontier.originNodeId,
        )) ?? 0;
        return frontier.maxContiguousOriginSequence > current
          ? [{
            conversationId: frontier.conversationId,
            originNodeId: frontier.originNodeId,
            fromExclusive: current,
            toInclusive: frontier.maxContiguousOriginSequence,
          }]
          : [];
      });
      this.assertScopedRanges(missingForLocal, peer.nodeId);
      const pullComplete = await this.pullEventsFromPeer(
        peer,
        missingForLocal,
        attachmentPeers,
        budget,
      );
      if (!pullComplete) {
        this.saveContinuation(peer.nodeId, { localAfter, remoteAfter, localDone, remoteDone });
        return false;
      }

      localAfter = localPage.nextCursor;
      remoteAfter = exchange.remotePage.nextCursor;
      localDone = localDone || localAfter === undefined;
      remoteDone = remoteDone || remoteAfter === undefined;
    } while (!localDone || !remoteDone);
    this.continuations.delete(peer.nodeId);
    this.pendingAttachmentPushes.delete(peer.nodeId);
    return true;
  }

  private async pushEventsToPeer(
    peer: ChatSyncPeer,
    ranges: VersionRange[],
    budget: PeerSyncWorkBudget,
  ): Promise<boolean> {
    if (ranges.length === 0) return true;
    if (!peer.pushEvents || !this.storage.getConversationEventPage) return false;
    try {
      const rangesByConversation = groupRangesByConversation(ranges);
      const coverage = createCoverageProgress(ranges);
      const pushedHashes = new Set<string>();
      const pendingPushes = this.pendingAttachmentPushes.get(peer.nodeId) ?? new Set<string>();
      this.pendingAttachmentPushes.set(peer.nodeId, pendingPushes);
      let batch: ConversationEvent[] = [];
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const flushed = batch;
        await peer.pushEvents!(flushed, { signal: this.activeSignal });
        for (const event of flushed) {
          for (const attachment of conversationEventAttachmentReferences(event)) {
            pendingPushes.delete(`${event.conversationId}\u0000${attachment.contentHash}`);
          }
        }
        batch = [];
      };

      for (const [conversationId, conversationRanges] of rangesByConversation) {
        let cursor: ConversationEventCursor | undefined;
        do {
          this.throwIfAborted();
          if (!consumeWorkPages(budget, 1)) {
            await flush();
            return false;
          }
          const page = await this.storage.getConversationEventPage(conversationId, {
            limit: EVENT_PAGE_MAX_ITEMS,
            after: cursor,
            direction: 'forward',
            signal: this.activeSignal,
            ranges: conversationRanges.map(range => ({
              originNodeId: range.originNodeId,
              fromExclusive: range.fromExclusive,
              toInclusive: range.toInclusive,
            })),
          });
          this.assertValidStoredEventPage(page, conversationId, cursor);
          for (const event of page.items) {
            if (!consumeWorkEvent(budget, event)) {
              await flush();
              return false;
            }
            const range = conversationRanges.find(candidate => eventInRange(event, candidate));
            if (!range) continue;
            recordObservedSequence(coverage, event);
            for (const attachment of conversationEventAttachmentReferences(event)) {
              const attachmentKey = `${conversationId}\u0000${attachment.contentHash}`;
              if (pushedHashes.has(attachmentKey) || pendingPushes.has(attachmentKey)) continue;
              if (!await this.pushAttachmentToPeer(peer, conversationId, attachment, budget)) {
                await flush();
                return false;
              }
              pushedHashes.add(attachmentKey);
              pendingPushes.add(attachmentKey);
            }

            const candidate = [...batch, event];
            if (candidate.length > EVENT_PAGE_MAX_ITEMS || jsonByteLength(candidate) > EVENT_PUSH_PAGE_MAX_BYTES) {
              if (batch.length === 0) throw new Error('sync_event_too_large');
              await flush();
              batch = [event];
              if (jsonByteLength(batch) > EVENT_PUSH_PAGE_MAX_BYTES) {
                throw new Error('sync_event_too_large');
              }
            } else {
              batch = candidate;
            }
          }
          cursor = page.hasMoreAfter ? page.endCursor : undefined;
        } while (cursor !== undefined);
      }
      await flush();
      return rangesHaveExactCoverage(coverage);
    } catch (error) {
      this.throwIfAborted();
      if (this.failOnMessageSyncError) throw error;
      return false;
    }
  }

  private async pullEventsFromPeer(
    peer: ChatSyncPeer,
    ranges: VersionRange[],
    attachmentPeers: ChatSyncPeer[],
    budget: PeerSyncWorkBudget,
  ): Promise<boolean> {
    if (ranges.length === 0) return true;
    if (!peer.pullMissingEvents || !this.storage.insertEventsIfAbsent) return false;
    try {
      const rangesByConversation = groupRangesByConversation(ranges);
      let coverage = createCoverageProgress(ranges);
      for (const [conversationId, conversationRanges] of rangesByConversation) {
        let cursor: ConversationEventCursor | undefined;
        do {
          this.throwIfAborted();
          if (!consumeWorkPages(budget, 1)) return false;
          const page = await peer.pullMissingEvents(
            conversationId,
            conversationRanges,
            cursor,
            { signal: this.activeSignal },
          );
          this.assertValidEventPage(page, conversationId, conversationRanges, cursor, peer.nodeId);
          assertCanonicalConversationEvents(page.items);
          const candidateCoverage = cloneCoverageProgress(coverage);
          const acceptedEvents: ConversationEvent[] = [];
          for (const event of page.items) {
            if (!consumeWorkEvent(budget, event)) break;
            recordObservedSequence(candidateCoverage, event);
            acceptedEvents.push(event);
          }
          // BLOBs land before their referencing event. A failed or corrupt BLOB
          // therefore cannot leak into the durable frontier on a later retry.
          if (!await this.ensureAttachmentsFromEvents(acceptedEvents, attachmentPeers, budget)) {
            return false;
          }
          if (acceptedEvents.length > 0) {
            await this.storage.insertEventsIfAbsent(acceptedEvents);
          }
          coverage = candidateCoverage;
          if (acceptedEvents.length !== page.items.length) return false;
          cursor = page.nextCursor;
        } while (cursor !== undefined);
      }
      return rangesHaveExactCoverage(coverage);
    } catch (error) {
      this.throwIfAborted();
      if (this.failOnMessageSyncError) throw error;
      return false;
    }
  }

  private async ensureAttachmentsFromEvents(
    events: ConversationEvent[],
    peers: ChatSyncPeer[],
    budget: PeerSyncWorkBudget,
  ): Promise<boolean> {
    const references = new Map<string, { conversationId: string; reference: AttachmentReference }>();
    for (const event of events) {
      for (const reference of conversationEventAttachmentReferences(event)) {
        references.set(`${event.conversationId}\u0000${reference.contentHash}`, {
          conversationId: event.conversationId,
          reference,
        });
      }
    }
    for (const { conversationId, reference } of references.values()) {
      if (await this.hasLocalAttachment(reference)) continue;
      if (
        !this.storage.stageAttachmentChunk || !this.storage.commitStagedAttachment ||
        reference.size > MAX_SYNC_ATTACHMENT_BYTES
      ) return false;
      const capablePeers = peers.filter(peer => peer.pullAttachmentChunk !== undefined);
      if (capablePeers.length === 0) return false;
      if (!reserveAttachmentWork(budget, reference.size)) return false;
      let fetched = false;
      for (const peer of capablePeers) {
        const pull = peer.pullAttachmentChunk?.bind(peer);
        if (!pull) continue;
        try {
          let offset = 0;
          while (offset <= reference.size) {
            this.throwIfAborted();
            const chunk = await pull(
              conversationId,
              reference.contentHash,
              offset,
              MAX_SYNC_ATTACHMENT_CHUNK_BYTES,
              { signal: this.activeSignal },
            );
            if (
              !chunk || chunk.offset !== offset || chunk.totalSize !== reference.size ||
              chunk.filename !== reference.filename || chunk.mimeType !== reference.mimeType ||
              chunk.data.byteLength > MAX_SYNC_ATTACHMENT_CHUNK_BYTES ||
              chunk.done !== (offset + chunk.data.byteLength === reference.size) ||
              (!chunk.done && chunk.data.byteLength === 0)
            ) {
              throw new Error('invalid_sync_attachment_chunk');
            }
            const nextOffset = await this.storage.stageAttachmentChunk(
              reference,
              offset,
              chunk.data,
              { signal: this.activeSignal },
            );
            this.throwIfAborted();
            if (
              !Number.isSafeInteger(nextOffset) || nextOffset !== offset + chunk.data.byteLength ||
              nextOffset > reference.size
            ) {
              throw new Error('sync_attachment_cursor_mismatch');
            }
            offset = nextOffset;
            if (offset === reference.size) {
              await this.storage.commitStagedAttachment(
                reference.contentHash,
                { signal: this.activeSignal },
              );
              this.throwIfAborted();
              fetched = await this.hasLocalAttachment(reference);
              break;
            }
          }
        } catch {
          this.throwIfAborted();
          // Another authorized peer may still have the content-addressed body.
        }
        if (fetched) break;
      }
      if (!fetched) return false;
    }
    return true;
  }

  private async hasLocalAttachment(reference: AttachmentReference): Promise<boolean> {
    const stored = await this.storage.getAttachment(reference.contentHash);
    return stored !== null && stored.size === reference.size && stored.filename === reference.filename &&
      stored.mimeType === reference.mimeType && this.storage.verifyAttachment !== undefined &&
      await this.storage.verifyAttachment(reference.contentHash, { signal: this.activeSignal });
  }

  private async pushAttachmentToPeer(
    peer: ChatSyncPeer,
    conversationId: string,
    reference: AttachmentReference,
    budget: PeerSyncWorkBudget,
  ): Promise<boolean> {
    if (
      !peer.pushAttachmentChunk || !this.storage.readAttachmentRange ||
      reference.size > MAX_SYNC_ATTACHMENT_BYTES || !await this.hasLocalAttachment(reference)
    ) {
      return false;
    }
    if (!reserveAttachmentWork(budget, reference.size)) return false;
    let offset = 0;
    while (offset <= reference.size) {
      this.throwIfAborted();
      const data = await this.storage.readAttachmentRange(
        reference.contentHash,
        offset,
        MAX_SYNC_ATTACHMENT_CHUNK_BYTES,
        { signal: this.activeSignal },
      );
      this.throwIfAborted();
      if (
        !data || data.byteLength > MAX_SYNC_ATTACHMENT_CHUNK_BYTES ||
        offset + data.byteLength > reference.size ||
        (data.byteLength === 0 && offset !== reference.size)
      ) return false;
      const done = offset + data.byteLength === reference.size;
      await peer.pushAttachmentChunk(
        conversationId,
        reference.contentHash,
        {
          data,
          offset,
          totalSize: reference.size,
          done,
          filename: reference.filename,
          mimeType: reference.mimeType,
        },
        { signal: this.activeSignal },
      );
      offset += data.byteLength;
      if (done) return true;
    }
    return false;
  }

  private assertValidEventPage(
    page: ConversationEventSyncPage,
    conversationId: string,
    ranges: VersionRange[],
    previousCursor: ConversationEventCursor | undefined,
    peerId: string,
  ): void {
    if (
      !isPlainRecord(page) || !hasOnlyKeys(page, ['items', 'nextCursor']) ||
      !Array.isArray(page.items) || page.items.length > EVENT_PAGE_MAX_ITEMS
    ) {
      throw new Error(`invalid_event_sync_page:${peerId}`);
    }
    assertBoundedCanonicalEventBytes(page.items, `invalid_event_sync_page:${peerId}`);
    let lastCursor = previousCursor;
    for (const event of page.items) {
      try {
        assertCanonicalConversationEvent(event);
        assertAdmittedConversationMessageEvent(event);
      } catch {
        throw new Error(`invalid_event_sync_item:${peerId}`);
      }
      if (
        event.conversationId !== conversationId ||
        !ranges.some(range => eventInRange(event, range))
      ) {
        throw new Error(`invalid_event_sync_item:${peerId}`);
      }
      const currentCursor = eventCursor(event);
      if (lastCursor && compareEventCursor(currentCursor, lastCursor) <= 0) {
        throw new Error(`invalid_event_sync_order:${peerId}`);
      }
      lastCursor = currentCursor;
    }
    if (page.nextCursor === undefined) return;
    if (!isConversationEventCursor(page.nextCursor)) throw new Error(`invalid_event_sync_cursor:${peerId}`);
    if (previousCursor && compareEventCursor(page.nextCursor, previousCursor) <= 0) {
      throw new Error(`event_sync_cursor_did_not_advance:${peerId}`);
    }
    const lastItem = page.items.at(-1);
    if (!lastItem || compareEventCursor(page.nextCursor, eventCursor(lastItem)) !== 0) {
      throw new Error(`event_sync_cursor_not_last_item:${peerId}`);
    }
  }

  private assertValidStoredEventPage(
    page: StoredConversationEventPage,
    conversationId: string,
    previousCursor: ConversationEventCursor | undefined,
  ): void {
    if (
      !isPlainRecord(page) || !hasOnlyKeys(page, [
        'items',
        'hasMoreBefore',
        'hasMoreAfter',
        'startCursor',
        'endCursor',
      ]) || !Array.isArray(page.items) || page.items.length > EVENT_PAGE_MAX_ITEMS ||
      typeof page.hasMoreBefore !== 'boolean' || typeof page.hasMoreAfter !== 'boolean' ||
      page.items.some(event => {
        try {
          assertCanonicalConversationEvent(event);
          assertAdmittedConversationMessageEvent(event);
          return event.conversationId !== conversationId;
        } catch {
          return true;
        }
      })
    ) {
      throw new Error('invalid_storage_event_page');
    }
    assertBoundedCanonicalEventBytes(page.items, 'invalid_storage_event_page');
    let lastCursor = previousCursor;
    for (const event of page.items) {
      const currentCursor = eventCursor(event);
      if (lastCursor && compareEventCursor(currentCursor, lastCursor) <= 0) {
        throw new Error('invalid_storage_event_order');
      }
      lastCursor = currentCursor;
    }
    if (!page.hasMoreAfter) return;
    if (
      page.items.length === 0 || !page.endCursor || !isConversationEventCursor(page.endCursor) ||
      previousCursor && compareEventCursor(page.endCursor, previousCursor) <= 0 ||
      lastCursor && compareEventCursor(page.endCursor, lastCursor) !== 0
    ) {
      throw new Error('storage_event_cursor_did_not_advance');
    }
  }

  public getStorage(): FullAgentStorage {
    return this.storage;
  }

  private assertScopedRanges(ranges: VersionRange[], peerId: string): void {
    if (this.conversationIds === undefined) return;
    const allowed = new Set(this.conversationIds);
    if (ranges.some(range => !allowed.has(range.conversationId))) {
      throw new Error(`sync_peer_scope_escalation:${peerId}`);
    }
  }

  private assertValidFrontierPage(
    page: MessageVersionFrontierPage,
    previous: MessageVersionFrontierCursor | undefined,
    source: string,
    expectedEmpty = false,
  ): void {
    if (
      !isPlainRecord(page) || !hasOnlyKeys(page, ['items', 'nextCursor']) ||
      !Array.isArray(page.items) || page.items.length > FRONTIER_PAGE_MAX_ITEMS ||
      expectedEmpty && (page.items.length > 0 || page.nextCursor !== undefined)
    ) {
      throw new Error(`invalid_sync_frontier_page:${source}`);
    }
    let last = previous;
    for (const frontier of page.items) {
      if (!isValidFrontier(frontier)) throw new Error(`invalid_sync_frontier:${source}`);
      const cursor = { conversationId: frontier.conversationId, originNodeId: frontier.originNodeId };
      if (last && compareFrontierCursor(cursor, last) <= 0) {
        throw new Error(`invalid_sync_frontier_order:${source}`);
      }
      last = cursor;
    }
    if (page.nextCursor === undefined) return;
    if (
      !last || !isValidFrontierCursor(page.nextCursor) ||
      compareFrontierCursor(page.nextCursor, last) !== 0 ||
      previous && compareFrontierCursor(page.nextCursor, previous) <= 0
    ) {
      throw new Error(`sync_frontier_cursor_did_not_advance:${source}`);
    }
  }

  private saveContinuation(peerId: string, continuation: PeerSyncContinuation): void {
    this.continuations.set(peerId, {
      localDone: continuation.localDone,
      remoteDone: continuation.remoteDone,
      ...(continuation.localAfter ? { localAfter: { ...continuation.localAfter } } : {}),
      ...(continuation.remoteAfter ? { remoteAfter: { ...continuation.remoteAfter } } : {}),
    });
  }

  private collectPeers(): ChatSyncPeer[] {
    const unique = new Map<string, ChatSyncPeer>();
    for (const peer of this.getPeers()) {
      if (!isValidSyncIdentifier(peer.nodeId)) throw new Error('invalid_sync_peer_id');
      if (peer.nodeId === this.nodeId || unique.has(peer.nodeId)) continue;
      unique.set(peer.nodeId, peer);
    }
    return [...unique.values()].sort((left, right) => compareCodeUnits(left.nodeId, right.nodeId));
  }

  private garbageCollectPeerState(activePeerIds: ReadonlySet<string>): void {
    for (const peerId of this.continuations.keys()) {
      if (!activePeerIds.has(peerId)) this.continuations.delete(peerId);
    }
    for (const peerId of this.pendingAttachmentPushes.keys()) {
      if (!activePeerIds.has(peerId)) this.pendingAttachmentPushes.delete(peerId);
    }
    if (this.nextPeerAfter !== undefined && !activePeerIds.has(this.nextPeerAfter)) {
      this.nextPeerAfter = undefined;
    }
  }

  private throwIfAborted(): void {
    if (!this.activeSignal?.aborted) return;
    throw this.activeSignal.reason instanceof Error
      ? this.activeSignal.reason
      : new Error('chat_sync_aborted');
  }
}

function assertAdmittedConversationMessageEvent(event: ConversationEvent): void {
  if (event.kind !== 'message') return;
  const message = {
    ...event.message,
    conversationId: event.conversationId,
    originNodeId: event.originNodeId,
    originSequence: event.originSequence,
    lamportClock: event.lamportClock,
    timestamp: event.timestamp,
  };
  if (event.message.role === 'user') assertAgentUserMessageWithinLimits(message);
  else assertConversationMessageWithinPagingLimits(message);
}

function isValidFrontier(value: unknown): value is MessageVersionFrontier {
  if (
    !isPlainRecord(value) || !hasOnlyKeys(value, [
      'conversationId',
      'originNodeId',
      'maxContiguousOriginSequence',
    ])
  ) return false;
  const frontier = value as Partial<MessageVersionFrontier>;
  return isValidSyncIdentifier(frontier.conversationId) &&
    isValidSyncIdentifier(frontier.originNodeId) &&
    typeof frontier.maxContiguousOriginSequence === 'number' &&
    Number.isSafeInteger(frontier.maxContiguousOriginSequence) &&
    frontier.maxContiguousOriginSequence > 0;
}

function isValidVersionRanges(value: unknown): value is VersionRange[] {
  if (!Array.isArray(value) || value.length > FRONTIER_PAGE_MAX_ITEMS) return false;
  const identities = new Set<string>();
  for (const item of value) {
    if (
      !isPlainRecord(item) || !hasOnlyKeys(item, [
        'conversationId',
        'originNodeId',
        'fromExclusive',
        'toInclusive',
      ])
    ) return false;
    const range = item as Partial<VersionRange>;
    if (
      !isValidSyncIdentifier(range.conversationId) ||
      !isValidSyncIdentifier(range.originNodeId) ||
      typeof range.fromExclusive !== 'number' || !Number.isSafeInteger(range.fromExclusive) ||
      range.fromExclusive < 0 || typeof range.toInclusive !== 'number' ||
      !Number.isSafeInteger(range.toInclusive) || range.toInclusive <= range.fromExclusive
    ) return false;
    const key = versionVectorKey(range.conversationId, range.originNodeId);
    if (identities.has(key)) return false;
    identities.add(key);
  }
  return true;
}

function rangesMatchOfferedFrontiers(
  ranges: VersionRange[],
  frontiers: MessageVersionFrontier[],
): boolean {
  const offered = new Map(frontiers.map(frontier => [
    versionVectorKey(frontier.conversationId, frontier.originNodeId),
    frontier.maxContiguousOriginSequence,
  ]));
  return ranges.every(range => offered.get(versionVectorKey(range.conversationId, range.originNodeId)) === range.toInclusive);
}

function isValidFrontierCursor(value: unknown): value is MessageVersionFrontierCursor {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['conversationId', 'originNodeId'])) return false;
  const cursor = value as Partial<MessageVersionFrontierCursor>;
  return isValidSyncIdentifier(cursor.conversationId) &&
    isValidSyncIdentifier(cursor.originNodeId);
}

function compareFrontierCursor(
  left: MessageVersionFrontierCursor,
  right: MessageVersionFrontierCursor,
): number {
  return compareUtf8Bytes(left.conversationId, right.conversationId) ||
    compareUtf8Bytes(left.originNodeId, right.originNodeId);
}

function resolvePassLimits(input: Partial<ChatSyncPassLimits> | undefined): ChatSyncPassLimits {
  const limits: ChatSyncPassLimits = {
    maxPeers: input?.maxPeers ?? MAX_SYNC_PEERS_PER_PASS,
    maxFrontierPages: input?.maxFrontierPages ?? MAX_SYNC_FRONTIER_SCAN_PAGES_PER_PEER_PASS,
    maxPages: input?.maxPages ?? MAX_SYNC_WORK_PAGES_PER_PEER_PASS,
    maxEvents: input?.maxEvents ?? MAX_SYNC_EVENTS_PER_PEER_PASS,
    maxBytes: input?.maxBytes ?? MAX_SYNC_BYTES_PER_PEER_PASS,
  };
  const hardLimits: ChatSyncPassLimits = {
    maxPeers: MAX_SYNC_PEERS_PER_PASS,
    maxFrontierPages: MAX_SYNC_FRONTIER_SCAN_PAGES_PER_PEER_PASS,
    maxPages: MAX_SYNC_WORK_PAGES_PER_PEER_PASS,
    maxEvents: MAX_SYNC_EVENTS_PER_PEER_PASS,
    maxBytes: MAX_SYNC_BYTES_PER_PEER_PASS,
  };
  for (const key of Object.keys(limits) as Array<keyof ChatSyncPassLimits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > hardLimits[key]) {
      throw new Error(`invalid_sync_pass_limit:${key}`);
    }
  }
  return limits;
}

function createSyncPassWorkBudget(limits: ChatSyncPassLimits): SyncPassWorkBudget {
  return { frontierPages: 0, pages: 0, events: 0, bytes: 0, exhausted: false, limits };
}

function createPeerSyncWorkBudget(global: SyncPassWorkBudget): PeerSyncWorkBudget {
  return { frontierPages: 0, pages: 0, events: 0, bytes: 0, exhausted: false, global };
}

function consumeFrontierScanPage(budget: PeerSyncWorkBudget): boolean {
  if (
    budget.frontierPages + 1 > MAX_SYNC_FRONTIER_SCAN_PAGES_PER_PEER_PASS ||
    budget.global.frontierPages + 1 > budget.global.limits.maxFrontierPages
  ) {
    budget.exhausted = true;
    if (budget.global.frontierPages + 1 > budget.global.limits.maxFrontierPages) {
      budget.global.exhausted = true;
    }
    return false;
  }
  budget.frontierPages += 1;
  budget.global.frontierPages += 1;
  return true;
}

function consumeWorkPages(budget: PeerSyncWorkBudget, count: number): boolean {
  if (
    budget.pages + count > MAX_SYNC_WORK_PAGES_PER_PEER_PASS ||
    budget.global.pages + count > budget.global.limits.maxPages
  ) {
    budget.exhausted = true;
    if (budget.global.pages + count > budget.global.limits.maxPages) budget.global.exhausted = true;
    return false;
  }
  budget.pages += count;
  budget.global.pages += count;
  return true;
}

function consumeWorkEvent(budget: PeerSyncWorkBudget, event: ConversationEvent): boolean {
  const bytes = canonicalConversationEventBytes(event).byteLength;
  if (
    budget.events + 1 > MAX_SYNC_EVENTS_PER_PEER_PASS ||
    budget.bytes + bytes > MAX_SYNC_BYTES_PER_PEER_PASS ||
    budget.global.events + 1 > budget.global.limits.maxEvents ||
    budget.global.bytes + bytes > budget.global.limits.maxBytes
  ) {
    budget.exhausted = true;
    if (
      budget.global.events + 1 > budget.global.limits.maxEvents ||
      budget.global.bytes + bytes > budget.global.limits.maxBytes
    ) budget.global.exhausted = true;
    return false;
  }
  budget.events += 1;
  budget.bytes += bytes;
  budget.global.events += 1;
  budget.global.bytes += bytes;
  return true;
}

function reserveAttachmentWork(budget: PeerSyncWorkBudget, bytes: number): boolean {
  const chunks = Math.max(1, Math.ceil(bytes / MAX_SYNC_ATTACHMENT_CHUNK_BYTES));
  if (
    budget.pages + chunks > MAX_SYNC_WORK_PAGES_PER_PEER_PASS ||
    budget.bytes + bytes > MAX_SYNC_BYTES_PER_PEER_PASS ||
    budget.global.pages + chunks > budget.global.limits.maxPages ||
    budget.global.bytes + bytes > budget.global.limits.maxBytes
  ) {
    budget.exhausted = true;
    if (
      budget.global.pages + chunks > budget.global.limits.maxPages ||
      budget.global.bytes + bytes > budget.global.limits.maxBytes
    ) budget.global.exhausted = true;
    return false;
  }
  budget.pages += chunks;
  budget.bytes += bytes;
  budget.global.pages += chunks;
  budget.global.bytes += bytes;
  return true;
}

function rotatePeers(peers: ChatSyncPeer[], after: string | undefined): ChatSyncPeer[] {
  if (peers.length === 0 || after === undefined) return peers;
  const start = peers.findIndex(peer => compareCodeUnits(peer.nodeId, after) > 0);
  if (start < 0) return peers;
  return [...peers.slice(start), ...peers.slice(0, start)];
}

function groupRangesByConversation(ranges: VersionRange[]): Map<string, VersionRange[]> {
  const grouped = new Map<string, VersionRange[]>();
  for (const range of ranges) {
    const values = grouped.get(range.conversationId) ?? [];
    values.push(range);
    grouped.set(range.conversationId, values);
  }
  return grouped;
}

function eventInRange(event: ConversationEvent, range: VersionRange): boolean {
  return event.conversationId === range.conversationId &&
    event.originNodeId === range.originNodeId &&
    event.originSequence > range.fromExclusive &&
    event.originSequence <= range.toInclusive;
}

interface CoverageProgress {
  nextExpected: number;
  toInclusive: number;
}

function createCoverageProgress(ranges: VersionRange[]): Map<string, CoverageProgress> {
  const coverage = new Map<string, CoverageProgress>();
  for (const range of ranges) {
    const key = versionVectorKey(range.conversationId, range.originNodeId);
    if (coverage.has(key)) throw new Error('sync_duplicate_version_range');
    coverage.set(key, {
      nextExpected: range.fromExclusive + 1,
      toInclusive: range.toInclusive,
    });
  }
  return coverage;
}

function cloneCoverageProgress(
  coverage: Map<string, CoverageProgress>,
): Map<string, CoverageProgress> {
  return new Map([...coverage].map(([key, value]) => [key, { ...value }]));
}

function recordObservedSequence(
  coverage: Map<string, CoverageProgress>,
  event: ConversationEvent,
): void {
  const key = versionVectorKey(event.conversationId, event.originNodeId);
  const progress = coverage.get(key);
  if (!progress || event.originSequence !== progress.nextExpected) {
    throw new Error('sync_non_contiguous_origin_sequence');
  }
  progress.nextExpected += 1;
}

function rangesHaveExactCoverage(
  coverage: Map<string, CoverageProgress>,
): boolean {
  return [...coverage.values()].every(progress => progress.nextExpected === progress.toInclusive + 1);
}

function isConversationEventCursor(value: unknown): value is ConversationEventCursor {
  if (
    !isPlainRecord(value) || !hasOnlyKeys(value, [
      'originNodeId',
      'originSequence',
      'eventId',
    ])
  ) return false;
  const cursor = value as Partial<ConversationEventCursor>;
  return isValidSyncIdentifier(cursor.originNodeId) &&
    typeof cursor.originSequence === 'number' && Number.isSafeInteger(cursor.originSequence) &&
    cursor.originSequence > 0 && isValidSyncIdentifier(cursor.eventId);
}

function eventCursor(event: ConversationEvent): ConversationEventCursor {
  return {
    originNodeId: event.originNodeId,
    originSequence: event.originSequence,
    eventId: event.eventId,
  };
}

function compareEventCursor(left: ConversationEventCursor, right: ConversationEventCursor): number {
  return compareUtf8Bytes(left.originNodeId, right.originNodeId) ||
    left.originSequence - right.originSequence ||
    compareUtf8Bytes(left.eventId, right.eventId);
}

/** Matches SQLite's default BINARY ordering used by the production event index. */
function compareUtf8Bytes(left: string, right: string): number {
  if (left === right) return 0;
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function jsonByteLength(events: readonly ConversationEvent[]): number {
  return canonicalEventArrayBytes(events);
}

function canonicalEventArrayBytes(events: readonly ConversationEvent[]): number {
  let bytes = 2 + Math.max(0, events.length - 1);
  for (const event of events) bytes += canonicalConversationEventBytes(event).byteLength;
  return bytes;
}

function assertBoundedCanonicalEventBytes(
  events: readonly ConversationEvent[],
  errorCode: string,
): void {
  if (canonicalEventArrayBytes(events) > EVENT_PUSH_PAGE_MAX_BYTES) throw new Error(errorCode);
}

function isValidSyncIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    utf8Encoder.encode(value).byteLength <= MAX_SYNC_ID_LENGTH &&
    !Array.from(value).some(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every(key => keys.has(key));
}
