import { describe, expect, it, vi } from 'vitest';

import {
  type AttachmentReference,
  canonicalConversationEventBytes,
  type ConversationEvent,
  type ConversationEventCursor,
  type ConversationMessageEvent,
} from '../../conversation/index.js';
import type { ConversationEventPage, GetConversationEventPageOptions, MessageVersionFrontier } from '../../storage/ports.js';
import type { IAgentStorage } from '../../types.js';
import { ChatSyncEngine, type ChatSyncPeer, type SyncIoOptions } from '../chatSyncEngine.js';
import { type ConversationEventSyncPage, type VersionVector, versionVectorKey } from '../protocol.js';

const conversationId = 'conversation-1';

function messageEvent(
  originNodeId: string,
  originSequence: number,
  content = `${originNodeId}-${originSequence}`,
  overrides: Partial<ConversationMessageEvent['message']> = {},
): ConversationMessageEvent {
  const messageId = `${originNodeId}-message-${originSequence}`;
  return {
    eventId: messageId,
    conversationId,
    originNodeId,
    originSequence,
    lamportClock: originSequence,
    timestamp: originSequence,
    kind: 'message',
    message: {
      messageId,
      turnId: overrides.role === 'user' || overrides.role === undefined
        ? messageId
        : `${originNodeId}-turn`,
      role: 'user',
      content,
      ...overrides,
    },
  };
}

function cursor(event: ConversationEvent): ConversationEventCursor {
  return {
    originNodeId: event.originNodeId,
    originSequence: event.originSequence,
    eventId: event.eventId,
  };
}

function compareCursor(left: ConversationEventCursor, right: ConversationEventCursor): number {
  return compareCodeUnits(left.originNodeId, right.originNodeId) ||
    left.originSequence - right.originSequence ||
    compareCodeUnits(left.eventId, right.eventId);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

class MemoryEventStorage {
  public readonly events: ConversationEvent[] = [];
  public readonly blobs = new Map<string, { reference: AttachmentReference; data: Uint8Array }>();
  public eventPageReads = 0;
  public maximumPageItems = 128;
  public frontierOverrides?: MessageVersionFrontier[];

  public asStorage(): IAgentStorage {
    return this as unknown as IAgentStorage;
  }

  public async insertEventsIfAbsent(events: readonly ConversationEvent[]): Promise<void> {
    for (const event of events) {
      const existing = this.events.find(candidate => candidate.eventId === event.eventId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new Error('sync_event_id_conflict');
      }
      const sameSequence = this.events.find(candidate =>
        candidate.conversationId === event.conversationId &&
        candidate.originNodeId === event.originNodeId &&
        candidate.originSequence === event.originSequence
      );
      if (sameSequence && sameSequence.eventId !== event.eventId) {
        throw new Error('sync_origin_sequence_conflict');
      }
    }
    for (const event of events) {
      if (!this.events.some(candidate => candidate.eventId === event.eventId)) this.events.push(event);
    }
  }

  public async calculateFrontiersForTest(
    conversationIds?: readonly string[],
  ): Promise<MessageVersionFrontier[]> {
    if (this.frontierOverrides) {
      return this.frontierOverrides.filter(frontier => conversationIds === undefined || conversationIds.includes(frontier.conversationId));
    }
    const sequences = new Map<string, {
      conversationId: string;
      originNodeId: string;
      values: Set<number>;
    }>();
    for (const event of this.events) {
      if (conversationIds !== undefined && !conversationIds.includes(event.conversationId)) continue;
      const key = versionVectorKey(event.conversationId, event.originNodeId);
      const entry = sequences.get(key) ?? {
        conversationId: event.conversationId,
        originNodeId: event.originNodeId,
        values: new Set<number>(),
      };
      entry.values.add(event.originSequence);
      sequences.set(key, entry);
    }
    return [...sequences.values()].flatMap(entry => {
      let frontier = 0;
      while (entry.values.has(frontier + 1)) frontier += 1;
      return frontier === 0 ? [] : [{
        conversationId: entry.conversationId,
        originNodeId: entry.originNodeId,
        maxContiguousOriginSequence: frontier,
      }];
    });
  }

  public async getEventVersionFrontierPage(options: {
    limit: number;
    after?: { conversationId: string; originNodeId: string };
    conversationIds?: readonly string[];
  }) {
    const rows = (await this.calculateFrontiersForTest(options.conversationIds))
      .filter(frontier =>
        options.after === undefined ||
        frontier.conversationId > options.after.conversationId ||
        frontier.conversationId === options.after.conversationId &&
          frontier.originNodeId > options.after.originNodeId
      )
      .sort((left, right) =>
        left.conversationId.localeCompare(right.conversationId) ||
        left.originNodeId.localeCompare(right.originNodeId)
      );
    const items = rows.slice(0, options.limit);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > items.length && last
        ? {
          nextCursor: { conversationId: last.conversationId, originNodeId: last.originNodeId },
        }
        : {}),
    };
  }

  public async getEventVersionFrontiersForKeys(
    keys: readonly { conversationId: string; originNodeId: string }[],
  ) {
    const selected = new Set(keys.map(key => versionVectorKey(key.conversationId, key.originNodeId)));
    return (await this.calculateFrontiersForTest()).filter(frontier =>
      selected.has(
        versionVectorKey(frontier.conversationId, frontier.originNodeId),
      )
    );
  }

  public async getConversationEventPage(
    selectedConversationId: string,
    options: GetConversationEventPageOptions,
  ): Promise<ConversationEventPage> {
    this.eventPageReads += 1;
    const sorted = this.events.filter(event =>
      event.conversationId === selectedConversationId &&
      (options.after === undefined || compareCursor(cursor(event), options.after) > 0) &&
      (options.ranges === undefined || options.ranges.some(range =>
        event.originNodeId === range.originNodeId &&
        event.originSequence > range.fromExclusive &&
        event.originSequence <= range.toInclusive
      ))
    )
      .sort((left, right) => compareCursor(cursor(left), cursor(right)));
    const limit = Math.min(options.limit, this.maximumPageItems);
    const items = sorted.slice(0, limit);
    return {
      items,
      hasMoreBefore: options.after !== undefined,
      hasMoreAfter: sorted.length > items.length,
      ...(items[0] ? { startCursor: cursor(items[0]) } : {}),
      ...(items.at(-1) ? { endCursor: cursor(items.at(-1)!) } : {}),
    };
  }

  public async getAttachment(contentHash: string): Promise<AttachmentReference | null> {
    return this.blobs.get(contentHash)?.reference ?? null;
  }

  public async readAttachmentData(contentHash: string): Promise<Uint8Array | null> {
    return this.blobs.get(contentHash)?.data ?? null;
  }

  public async readAttachmentRange(contentHash: string, offset: number, maxBytes: number) {
    const data = this.blobs.get(contentHash)?.data;
    return data ? data.slice(offset, offset + maxBytes) : null;
  }

  public async saveAttachment(reference: AttachmentReference, data: Uint8Array): Promise<void> {
    this.blobs.set(reference.contentHash, { reference, data });
  }

  public async stageAttachmentChunk(
    reference: AttachmentReference,
    offset: number,
    data: Uint8Array,
  ): Promise<number> {
    const existing = this.blobs.get(reference.contentHash)?.data ?? new Uint8Array(reference.size);
    existing.set(data, offset);
    this.blobs.set(reference.contentHash, { reference, data: existing });
    return offset + data.byteLength;
  }

  public async commitStagedAttachment(_contentHash: string): Promise<void> {}

  public async verifyAttachment(contentHash: string): Promise<boolean> {
    const blob = this.blobs.get(contentHash);
    if (!blob || blob.reference.size !== blob.data.byteLength) return false;
    const match = /^sha256:([\da-f]{64})$/iu.exec(contentHash);
    if (!match) return false;
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(blob.data).buffer),
    );
    return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('') === match[1];
  }
}

class ScaleEventStorage extends MemoryEventStorage {
  private readonly fastFrontiers: MessageVersionFrontier[] = [];
  private readonly fastFrontierByKey = new Map<string, MessageVersionFrontier>();
  private readonly fastEventsByKey = new Map<string, ConversationEvent[]>();
  private readonly fastEventById = new Map<string, ConversationEvent>();

  public override async insertEventsIfAbsent(events: readonly ConversationEvent[]): Promise<void> {
    for (const event of events) {
      const existingEvent = this.fastEventById.get(event.eventId);
      if (existingEvent) {
        if (JSON.stringify(existingEvent) !== JSON.stringify(event)) {
          throw new Error('sync_event_id_conflict');
        }
        continue;
      }
      const key = versionVectorKey(event.conversationId, event.originNodeId);
      const originEvents = this.fastEventsByKey.get(key) ?? [];
      const sameSequence = originEvents[event.originSequence - 1];
      if (sameSequence && sameSequence.eventId !== event.eventId) {
        throw new Error('sync_origin_sequence_conflict');
      }
      this.events.push(event);
      originEvents[event.originSequence - 1] = event;
      this.fastEventsByKey.set(key, originEvents);
      this.fastEventById.set(event.eventId, event);
      const existing = this.fastFrontierByKey.get(key);
      if (!existing) {
        const frontier = {
          conversationId: event.conversationId,
          originNodeId: event.originNodeId,
          maxContiguousOriginSequence: event.originSequence,
        };
        this.fastFrontierByKey.set(key, frontier);
        let low = 0;
        let high = this.fastFrontiers.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          const candidate = this.fastFrontiers[middle];
          const comparison = compareCodeUnits(frontier.conversationId, candidate.conversationId) ||
            compareCodeUnits(frontier.originNodeId, candidate.originNodeId);
          if (comparison > 0) low = middle + 1;
          else high = middle;
        }
        this.fastFrontiers.splice(low, 0, frontier);
      } else {
        while (originEvents[existing.maxContiguousOriginSequence]) {
          existing.maxContiguousOriginSequence += 1;
        }
      }
    }
  }

  public override async getConversationEventPage(
    selectedConversationId: string,
    options: GetConversationEventPageOptions,
  ): Promise<ConversationEventPage> {
    if (!options.ranges) return super.getConversationEventPage(selectedConversationId, options);
    this.eventPageReads += 1;
    const sorted = options.ranges.flatMap(range =>
      (this.fastEventsByKey.get(versionVectorKey(selectedConversationId, range.originNodeId)) ?? [])
        .slice(range.fromExclusive, range.toInclusive)
    )
      .filter((event): event is ConversationEvent =>
        event !== undefined &&
        (options.after === undefined || compareCursor(cursor(event), options.after) > 0)
      )
      .sort((left, right) => compareCursor(cursor(left), cursor(right)));
    const limit = Math.min(options.limit, this.maximumPageItems);
    const items = sorted.slice(0, limit);
    return {
      items,
      hasMoreBefore: options.after !== undefined,
      hasMoreAfter: sorted.length > items.length,
      ...(items[0] ? { startCursor: cursor(items[0]) } : {}),
      ...(items.at(-1) ? { endCursor: cursor(items.at(-1)!) } : {}),
    };
  }

  public override async getEventVersionFrontierPage(options: {
    limit: number;
    after?: { conversationId: string; originNodeId: string };
    conversationIds?: readonly string[];
  }) {
    const start = options.after === undefined
      ? 0
      : this.fastFrontiers.findIndex(frontier =>
        frontier.conversationId > options.after!.conversationId ||
        frontier.conversationId === options.after!.conversationId &&
          frontier.originNodeId > options.after!.originNodeId
      );
    const rows = start < 0 ? [] : this.fastFrontiers.slice(start);
    const items = rows.slice(0, options.limit);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > items.length && last
        ? { nextCursor: { conversationId: last.conversationId, originNodeId: last.originNodeId } }
        : {}),
    };
  }

  public override async getEventVersionFrontiersForKeys(
    keys: readonly { conversationId: string; originNodeId: string }[],
  ) {
    return keys.flatMap(key => {
      const frontier = this.fastFrontierByKey.get(versionVectorKey(
        key.conversationId,
        key.originNodeId,
      ));
      return frontier ? [frontier] : [];
    });
  }
}

async function vectorFor(storage: MemoryEventStorage): Promise<VersionVector> {
  return Object.fromEntries((await storage.calculateFrontiersForTest()).map(frontier => [
    versionVectorKey(frontier.conversationId, frontier.originNodeId),
    frontier.maxContiguousOriginSequence,
  ]));
}

class MemoryPeer implements ChatSyncPeer {
  public readonly nodeId: string;
  public pulledRanges: Array<{ fromExclusive: number; toInclusive: number }> = [];

  constructor(nodeId: string, public readonly storage: MemoryEventStorage) {
    this.nodeId = nodeId;
  }

  public async exchangeVersionFrontierPage(
    localFrontiers: MessageVersionFrontier[],
    remoteAfter: { conversationId: string; originNodeId: string } | undefined,
    includeRemotePage: boolean,
    conversationIds?: string[],
  ) {
    const remotePage = includeRemotePage
      ? await this.storage.getEventVersionFrontierPage({
        limit: 128,
        ...(remoteAfter ? { after: remoteAfter } : {}),
        ...(conversationIds ? { conversationIds } : {}),
      })
      : { items: [] };
    const remoteForLocal = await this.storage.getEventVersionFrontiersForKeys(localFrontiers);
    const remoteByKey = new Map(remoteForLocal.map(frontier => [
      versionVectorKey(frontier.conversationId, frontier.originNodeId),
      frontier.maxContiguousOriginSequence,
    ]));
    return {
      remotePage,
      missingForRemote: localFrontiers.flatMap(frontier => {
        const current = remoteByKey.get(versionVectorKey(
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
      }),
    };
  }

  public async pullMissingEvents(
    selectedConversationId: string,
    ranges: Array<{ originNodeId: string; fromExclusive: number; toInclusive: number }>,
    after?: ConversationEventCursor,
    _options?: SyncIoOptions,
  ) {
    this.pulledRanges.push(...ranges.map(range => ({
      fromExclusive: range.fromExclusive,
      toInclusive: range.toInclusive,
    })));
    const page = await this.storage.getConversationEventPage(selectedConversationId, {
      limit: 128,
      after,
      direction: 'forward',
      ranges,
    });
    return {
      items: page.items,
      ...(page.hasMoreAfter ? { nextCursor: page.endCursor } : {}),
    };
  }

  public async pushEvents(events: ConversationEvent[]): Promise<void> {
    await this.storage.insertEventsIfAbsent(events);
  }

  public async pullAttachmentChunk(
    _conversationId: string,
    contentHash: string,
    offset: number,
    maxBytes: number,
  ) {
    const blob = this.storage.blobs.get(contentHash);
    if (!blob) return null;
    const data = blob.data.slice(offset, offset + maxBytes);
    return {
      data,
      offset,
      totalSize: blob.reference.size,
      done: offset + data.byteLength === blob.reference.size,
      filename: blob.reference.filename,
      mimeType: blob.reference.mimeType,
    };
  }

  public async pushAttachmentChunk(
    _conversationId: string,
    contentHash: string,
    chunk: {
      data: Uint8Array;
      offset: number;
      totalSize: number;
      filename: string;
      mimeType: string;
    },
  ): Promise<void> {
    const reference = {
      contentHash,
      filename: chunk.filename,
      mimeType: chunk.mimeType,
      size: chunk.totalSize,
    };
    await this.storage.stageAttachmentChunk(reference, chunk.offset, chunk.data);
    await this.storage.commitStagedAttachment(contentHash);
  }
}

function engine(
  storage: MemoryEventStorage,
  peer: ChatSyncPeer,
  options: {
    signal?: AbortSignal;
    conversationIds?: string[];
    strict?: boolean;
  } = {},
): ChatSyncEngine {
  return new ChatSyncEngine({
    nodeId: 'local',
    storage: storage.asStorage(),
    peers: () => [peer],
    signal: options.signal,
    conversationIds: options.conversationIds,
    failOnMessageSyncError: options.strict ?? true,
  });
}

describe('ChatSyncEngine raw event anti-entropy', () => {
  it('pushes and pulls every event kind in one sync, including tombstones and late messages', async () => {
    const local = new MemoryEventStorage();
    const remote = new MemoryEventStorage();
    const turn = 'A-message-1';
    await local.insertEventsIfAbsent([
      messageEvent('A', 1),
      {
        eventId: 'A-event-2',
        conversationId,
        originNodeId: 'A',
        originSequence: 2,
        lamportClock: 2,
        timestamp: 2,
        kind: 'metadataPatch',
        patch: { title: 'renamed' },
      },
      {
        eventId: 'A-event-3',
        conversationId,
        originNodeId: 'A',
        originSequence: 3,
        lamportClock: 3,
        timestamp: 3,
        kind: 'compaction',
        mode: 'summary',
        boundary: {
          version: 2,
          coveredVersion: { A: 1 },
          coveredMessageCountByOrigin: { A: 1 },
          coveredUserTurnCountByOrigin: { A: 1 },
          droppedMessageCount: 1,
          droppedTurnCount: 1,
        },
        summary: { turnId: 'summary-turn', content: 'summary' },
      },
      {
        eventId: 'A-event-4',
        conversationId,
        originNodeId: 'A',
        originSequence: 4,
        lamportClock: 4,
        timestamp: 4,
        kind: 'tombstone',
        targetTurnId: turn,
        reason: 'user-delete',
      },
    ]);
    await remote.insertEventsIfAbsent([
      messageEvent('B', 1, 'late arrival', {
        messageId: 'B-message-1',
        turnId: turn,
        role: 'assistant',
      }),
    ]);

    await engine(local, new MemoryPeer('B', remote)).syncOnce();

    const ids = (storage: MemoryEventStorage) => storage.events.map(event => event.eventId).sort();
    expect(ids(local)).toEqual(ids(remote));
    expect(new Set(local.events.map(event => event.kind))).toEqual(
      new Set(['message', 'metadataPatch', 'compaction', 'tombstone']),
    );
  });

  it('does not land or acknowledge an event until its canonical attachment is verified', async () => {
    const local = new MemoryEventStorage();
    const remote = new MemoryEventStorage();
    const contentHash = 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const reference = { contentHash, filename: 'a.txt', mimeType: 'text/plain', size: 3 };
    await remote.insertEventsIfAbsent([messageEvent('B', 1, 'attachment', {
      attachments: [reference],
    })]);
    remote.blobs.set(contentHash, { reference, data: new TextEncoder().encode('abc') });
    const peer = new MemoryPeer('B', remote);
    const pull = vi.spyOn(peer, 'pullAttachmentChunk')
      .mockResolvedValueOnce(null)
      .mockImplementation(async (_id, hash, offset, maxBytes) => {
        const blob = remote.blobs.get(hash);
        if (!blob) return null;
        const data = blob.data.slice(offset, offset + maxBytes);
        return {
          data,
          offset,
          totalSize: blob.reference.size,
          done: offset + data.byteLength === blob.reference.size,
          filename: blob.reference.filename,
          mimeType: blob.reference.mimeType,
        };
      });
    const sync = engine(local, peer, { strict: false });

    await sync.syncOnce();
    expect(local.events).toEqual([]);
    expect(await vectorFor(local)).toEqual({});

    await sync.syncOnce();
    expect(local.events).toHaveLength(1);
    expect(await vectorFor(local)).toEqual({
      [versionVectorKey(conversationId, 'B')]: 1,
    });
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it('fails closed on the same eventId with a different payload and never acknowledges it', async () => {
    const local = new MemoryEventStorage();
    const remote = new MemoryEventStorage();
    const localBase = messageEvent('A', 1, 'local');
    const remoteBase = messageEvent('B', 1, 'remote');
    const localEvent = {
      ...localBase,
      eventId: 'collision',
      message: { ...localBase.message, messageId: 'collision', turnId: 'collision' },
    };
    const remoteEvent = {
      ...remoteBase,
      eventId: 'collision',
      message: { ...remoteBase.message, messageId: 'collision', turnId: 'collision' },
    };
    await local.insertEventsIfAbsent([localEvent]);
    await remote.insertEventsIfAbsent([remoteEvent]);
    const sync = engine(local, new MemoryPeer('B', remote), { strict: false });

    await sync.syncOnce();

    expect(local.events).toEqual([localEvent]);
    expect(await vectorFor(local)).toEqual({
      [versionVectorKey(conversationId, 'A')]: 1,
    });
  });

  it('restricts frontier paging and treats an empty selection as a no-op', async () => {
    const local = new MemoryEventStorage();
    await local.insertEventsIfAbsent([messageEvent('A', 1)]);
    const peer = new MemoryPeer('B', new MemoryEventStorage());
    const exchange = vi.spyOn(peer, 'exchangeVersionFrontierPage');
    const selected = engine(local, peer, {
      conversationIds: [conversationId],
    });

    await selected.syncOnce();
    expect(await vectorFor(local)).toEqual({
      [versionVectorKey(conversationId, 'A')]: 1,
    });
    expect(exchange.mock.calls[0]?.[0]).toEqual([{
      conversationId,
      originNodeId: 'A',
      maxContiguousOriginSequence: 1,
    }]);

    const emptyExchange = vi.fn();
    const empty = engine(local, {
      nodeId: 'B',
      exchangeVersionFrontierPage: emptyExchange,
    }, { conversationIds: [] });
    await empty.syncOnce();
    expect(emptyExchange).not.toHaveBeenCalled();
    expect(await vectorFor(local)).toEqual({
      [versionVectorKey(conversationId, 'A')]: 1,
    });
  });

  it('rejects a peer cursor that repeats instead of making progress', async () => {
    const local = new MemoryEventStorage();
    const first = messageEvent('B', 1);
    const repeated = cursor(first);
    let calls = 0;
    const peer: ChatSyncPeer = {
      nodeId: 'B',
      async exchangeVersionFrontierPage() {
        return {
          remotePage: {
            items: [{
              conversationId,
              originNodeId: 'B',
              maxContiguousOriginSequence: 2,
            }],
          },
          missingForRemote: [],
        };
      },
      async pullMissingEvents() {
        calls += 1;
        return calls === 1
          ? { items: [first], nextCursor: repeated }
          : { items: [], nextCursor: repeated };
      },
    };
    await expect(engine(local, peer).syncOnce()).rejects.toThrow(
      'event_sync_cursor_did_not_advance:B',
    );
  });

  it('rejects a missing range that was not exactly offered by the local frontier page', async () => {
    const local = new MemoryEventStorage();
    await local.insertEventsIfAbsent([messageEvent('A', 1)]);
    const peer: ChatSyncPeer = {
      nodeId: 'malicious',
      async exchangeVersionFrontierPage() {
        return {
          remotePage: { items: [] },
          missingForRemote: [{
            conversationId,
            originNodeId: 'A',
            fromExclusive: 0,
            toInclusive: 2,
          }],
        };
      },
    };
    await expect(engine(local, peer).syncOnce()).rejects.toThrow(
      'inconsistent_sync_exchange:malicious',
    );
  });

  it('resumes after cancellation from the persisted frontier without requesting completed pages', async () => {
    const local = new MemoryEventStorage();
    const remote = new MemoryEventStorage();
    remote.maximumPageItems = 1;
    await remote.insertEventsIfAbsent([
      messageEvent('B', 1),
      messageEvent('B', 2),
      messageEvent('B', 3),
    ]);
    const controller = new AbortController();
    const interruptedPeer = new MemoryPeer('B', remote);
    const originalPull = interruptedPeer.pullMissingEvents.bind(interruptedPeer);
    let calls = 0;
    interruptedPeer.pullMissingEvents = async (...parameters) => {
      calls += 1;
      if (calls === 2) {
        controller.abort(new Error('cancelled-mid-page'));
        parameters[3]?.signal?.throwIfAborted();
      }
      return originalPull(...parameters);
    };
    await expect(engine(local, interruptedPeer, { signal: controller.signal }).syncOnce())
      .rejects.toThrow('cancelled-mid-page');
    expect(await vectorFor(local)).toEqual({ [versionVectorKey(conversationId, 'B')]: 1 });

    const resumedPeer = new MemoryPeer('B', remote);
    await engine(local, resumedPeer).syncOnce();
    expect(resumedPeer.pulledRanges[0]).toEqual({ fromExclusive: 1, toInclusive: 3 });
    expect(local.events).toHaveLength(3);
  });

  it('converges 10k bidirectional events after budget exhaustion, cancellation, and engine restarts', async () => {
    const eventsPerOrigin = 5_000;
    const local = new ScaleEventStorage();
    const remote = new ScaleEventStorage();
    await local.insertEventsIfAbsent(Array.from(
      { length: eventsPerOrigin },
      (_, index) => messageEvent('A', index + 1),
    ));
    await remote.insertEventsIfAbsent(Array.from(
      { length: eventsPerOrigin },
      (_, index) => messageEvent('B', index + 1),
    ));

    const firstPass = await engine(local, new MemoryPeer('B', remote)).syncOnce();
    expect(firstPass).toMatchObject({
      complete: false,
      continuation: { reason: 'work-budget', pendingPeerIds: ['B'] },
      progress: { events: 4_096, pages: 33 },
    });

    const controller = new AbortController();
    const interruptedPeer = new MemoryPeer('B', remote);
    const originalPull = interruptedPeer.pullMissingEvents.bind(interruptedPeer);
    let pullCalls = 0;
    interruptedPeer.pullMissingEvents = async (...parameters) => {
      pullCalls += 1;
      if (pullCalls === 2) {
        controller.abort(new Error('cancelled-after-restart'));
        parameters[3]?.signal?.throwIfAborted();
      }
      return originalPull(...parameters);
    };
    await expect(engine(local, interruptedPeer, { signal: controller.signal }).syncOnce())
      .rejects.toThrow('cancelled-after-restart');

    let finalPass;
    let restartCount = 0;
    do {
      finalPass = await engine(local, new MemoryPeer('B', remote)).syncOnce();
      restartCount += 1;
      expect(finalPass.progress.pages).toBeLessThanOrEqual(64);
      expect(finalPass.progress.events).toBeLessThanOrEqual(4_096);
      expect(finalPass.progress.frontierPages).toBeLessThanOrEqual(2_048);
    } while (!finalPass.complete && restartCount < 8);

    expect(finalPass.complete).toBe(true);
    expect(local.events).toHaveLength(eventsPerOrigin * 2);
    expect(remote.events).toHaveLength(eventsPerOrigin * 2);
    await expect(vectorFor(local)).resolves.toEqual({
      [versionVectorKey(conversationId, 'A')]: eventsPerOrigin,
      [versionVectorKey(conversationId, 'B')]: eventsPerOrigin,
    });
    await expect(vectorFor(remote)).resolves.toEqual({
      [versionVectorKey(conversationId, 'A')]: eventsPerOrigin,
      [versionVectorKey(conversationId, 'B')]: eventsPerOrigin,
    });
  });

  it('uses an indexed range read for a one-event delta over a 100k frontier', async () => {
    const local = new MemoryEventStorage();
    const last = messageEvent('A', 100_000);
    local.events.push(last);
    local.frontierOverrides = [{
      conversationId,
      originNodeId: 'A',
      maxContiguousOriginSequence: 100_000,
    }];
    const pushed: ConversationEvent[] = [];
    const peer: ChatSyncPeer = {
      nodeId: 'B',
      async exchangeVersionFrontierPage(localFrontiers) {
        return {
          remotePage: { items: [] },
          missingForRemote: localFrontiers.map(frontier => ({
            conversationId: frontier.conversationId,
            originNodeId: frontier.originNodeId,
            fromExclusive: 99_999,
            toInclusive: frontier.maxContiguousOriginSequence,
          })),
        };
      },
      async pushEvents(events) {
        pushed.push(...events);
      },
    };

    await engine(local, peer).syncOnce();

    expect(local.eventPageReads).toBe(1);
    expect(pushed).toEqual([last]);
  });

  it('keyset-pages more than 4096 frontier entries without a full-vector frame', async () => {
    const local = new MemoryEventStorage();
    const remote = new MemoryEventStorage();
    const frontiers = Array.from({ length: 5_000 }, (_, index) => ({
      conversationId: `conversation-${index.toString().padStart(5, '0')}`,
      originNodeId: 'origin',
      maxContiguousOriginSequence: 1,
    }));
    local.frontierOverrides = frontiers;
    remote.frontierOverrides = frontiers;
    const peer = new MemoryPeer('B', remote);
    const exchange = vi.spyOn(peer, 'exchangeVersionFrontierPage');

    await engine(local, peer).syncOnce();

    expect(exchange.mock.calls.length).toBeGreaterThan(32);
    expect(exchange.mock.calls.every(call => call[0].length <= 128)).toBe(true);
    expect(exchange.mock.calls.reduce((count, call) => count + call[0].length, 0)).toBe(5_000);
  });

  it('bounds a hostile MAX_SAFE_INTEGER range and resumes from the durable frontier', async () => {
    const local = new MemoryEventStorage();
    let pullCalls = 0;
    const peer: ChatSyncPeer = {
      nodeId: 'hostile-range',
      async exchangeVersionFrontierPage() {
        return {
          remotePage: {
            items: [{
              conversationId,
              originNodeId: 'hostile',
              maxContiguousOriginSequence: Number.MAX_SAFE_INTEGER,
            }],
          },
          missingForRemote: [],
        };
      },
      async pullMissingEvents(_selectedConversationId, ranges, after) {
        pullCalls += 1;
        const range = ranges[0];
        const start = after?.originSequence ?? range.fromExclusive;
        const items = Array.from({ length: 128 }, (_, index) => messageEvent('hostile', start + index + 1));
        return { items, nextCursor: cursor(items.at(-1)!) };
      },
    };
    const sync = engine(local, peer);

    await expect(sync.syncOnce()).resolves.toMatchObject({
      complete: false,
      continuation: { reason: 'work-budget', pendingPeerIds: ['hostile-range'] },
      progress: { events: 4_096 },
    });
    expect(local.events).toHaveLength(4_096);
    expect(pullCalls).toBeLessThanOrEqual(33);
    await expect(sync.syncOnce()).resolves.toMatchObject({
      complete: false,
      continuation: { reason: 'work-budget', pendingPeerIds: ['hostile-range'] },
      progress: { events: 4_096 },
    });
    expect(local.events).toHaveLength(8_192);
  });

  it('stops an endlessly advancing peer at the page-work budget', async () => {
    const local = new MemoryEventStorage();
    let pullCalls = 0;
    const peer: ChatSyncPeer = {
      nodeId: 'endless-pages',
      async exchangeVersionFrontierPage() {
        return {
          remotePage: {
            items: [{
              conversationId,
              originNodeId: 'endless',
              maxContiguousOriginSequence: Number.MAX_SAFE_INTEGER,
            }],
          },
          missingForRemote: [],
        };
      },
      async pullMissingEvents(_selectedConversationId, ranges, after) {
        pullCalls += 1;
        const sequence = (after?.originSequence ?? ranges[0].fromExclusive) + 1;
        const event = messageEvent('endless', sequence);
        return { items: [event], nextCursor: cursor(event) };
      },
    };

    await expect(engine(local, peer).syncOnce()).resolves.toMatchObject({
      complete: false,
      continuation: { reason: 'work-budget', pendingPeerIds: ['endless-pages'] },
      progress: { pages: 64 },
    });
    expect(pullCalls).toBe(64);
    expect(local.events).toHaveLength(64);
  });

  it('bounds hostile no-op frontier discovery independently of transfer work', async () => {
    const local = new MemoryEventStorage();
    local.getEventVersionFrontiersForKeys = async keys =>
      keys.map(key => ({
        ...key,
        maxContiguousOriginSequence: 1,
      }));
    let exchangeCalls = 0;
    const peer: ChatSyncPeer = {
      nodeId: 'endless-frontiers',
      async exchangeVersionFrontierPage(_localFrontiers, remoteAfter) {
        exchangeCalls += 1;
        const start = remoteAfter === undefined
          ? 0
          : Number(remoteAfter.originNodeId.slice('origin-'.length)) + 1;
        const items = Array.from({ length: 128 }, (_, index) => ({
          conversationId,
          originNodeId: `origin-${(start + index).toString().padStart(9, '0')}`,
          maxContiguousOriginSequence: 1,
        }));
        const last = items.at(-1)!;
        return {
          remotePage: {
            items,
            nextCursor: {
              conversationId: last.conversationId,
              originNodeId: last.originNodeId,
            },
          },
          missingForRemote: [],
        };
      },
    };

    await expect(engine(local, peer).syncOnce()).resolves.toMatchObject({
      complete: false,
      continuation: { reason: 'work-budget', pendingPeerIds: ['endless-frontiers'] },
      progress: { frontierPages: 2_048, pages: 0, events: 0 },
    });
    expect(exchangeCalls).toBe(2_048);
  });

  it('deduplicates hostile peer cardinality and rotates bounded peer work between passes', async () => {
    const calls: string[] = [];
    const uniquePeers = Array.from({ length: 10_000 }, (_, index): ChatSyncPeer => ({
      nodeId: `peer-${index.toString().padStart(5, '0')}`,
      async exchangeVersionFrontierPage() {
        calls.push(`peer-${index.toString().padStart(5, '0')}`);
        return { remotePage: { items: [] }, missingForRemote: [] };
      },
    }));
    const duplicate = {
      nodeId: uniquePeers[0].nodeId,
      exchangeVersionFrontierPage: vi.fn(async () => ({ remotePage: { items: [] }, missingForRemote: [] })),
    } satisfies ChatSyncPeer;
    const sync = new ChatSyncEngine({
      nodeId: 'local',
      storage: new MemoryEventStorage().asStorage(),
      peers: () => [duplicate, ...uniquePeers],
      passLimits: {
        maxPeers: 4,
        maxFrontierPages: 4,
        maxPages: 4,
        maxEvents: 4,
        maxBytes: 1024,
      },
    });

    const first = await sync.syncOnce();
    expect(first).toMatchObject({
      complete: false,
      progress: { peers: 4, frontierPages: 4 },
      continuation: { reason: 'work-budget' },
    });
    expect(first.continuation?.pendingPeerIds.length).toBeLessThanOrEqual(4);
    expect(calls).toEqual(['peer-00001', 'peer-00002', 'peer-00003']);
    expect(duplicate.exchangeVersionFrontierPage).toHaveBeenCalledOnce();

    await sync.syncOnce();
    expect(calls.slice(3)).toEqual(['peer-00004', 'peer-00005', 'peer-00006', 'peer-00007']);
    expect(duplicate.exchangeVersionFrontierPage).toHaveBeenCalledOnce();
  });

  it('enforces global frontier and byte budgets at exact max and rejects max plus one', async () => {
    const exchangeCalls: string[] = [];
    const idlePeers = Array.from({ length: 3 }, (_, index): ChatSyncPeer => ({
      nodeId: `idle-${index}`,
      async exchangeVersionFrontierPage() {
        exchangeCalls.push(`idle-${index}`);
        return { remotePage: { items: [] }, missingForRemote: [] };
      },
    }));
    const metadataBounded = new ChatSyncEngine({
      nodeId: 'local',
      storage: new MemoryEventStorage().asStorage(),
      peers: () => idlePeers,
      passLimits: {
        maxPeers: 3,
        maxFrontierPages: 2,
        maxPages: 2,
        maxEvents: 2,
        maxBytes: 1024,
      },
    });

    await expect(metadataBounded.syncOnce()).resolves.toMatchObject({
      complete: false,
      progress: { frontierPages: 2 },
    });
    expect(exchangeCalls).toEqual(['idle-0', 'idle-1']);

    const local = new MemoryEventStorage();
    const first = messageEvent('remote', 1, 'first');
    const second = messageEvent('remote', 2, 'second');
    const eventBytes = canonicalConversationEventBytes(first).byteLength;
    const peer: ChatSyncPeer = {
      nodeId: 'byte-peer',
      async exchangeVersionFrontierPage() {
        return {
          remotePage: {
            items: [{
              conversationId,
              originNodeId: 'remote',
              maxContiguousOriginSequence: 2,
            }],
          },
          missingForRemote: [],
        };
      },
      async pullMissingEvents() {
        return { items: [first, second] };
      },
    };
    const byteBounded = new ChatSyncEngine({
      nodeId: 'local',
      storage: local.asStorage(),
      peers: () => [peer],
      passLimits: {
        maxPeers: 1,
        maxFrontierPages: 1,
        maxPages: 1,
        maxEvents: 2,
        maxBytes: eventBytes,
      },
      failOnMessageSyncError: true,
    });

    await expect(byteBounded.syncOnce()).resolves.toMatchObject({
      complete: false,
      progress: { pages: 1, events: 1, bytes: eventBytes },
    });
    expect(local.events).toEqual([first]);
  });

  it('garbage-collects continuation and pending-attachment state for disappeared peers', async () => {
    const local = new MemoryEventStorage();
    const endless: ChatSyncPeer = {
      nodeId: 'departed',
      async exchangeVersionFrontierPage() {
        return {
          remotePage: {
            items: [{
              conversationId,
              originNodeId: 'remote',
              maxContiguousOriginSequence: Number.MAX_SAFE_INTEGER,
            }],
          },
          missingForRemote: [],
        };
      },
      async pullMissingEvents(_conversationId, ranges, after) {
        const sequence = (after?.originSequence ?? ranges[0].fromExclusive) + 1;
        const event = messageEvent('remote', sequence);
        return { items: [event], nextCursor: cursor(event) };
      },
    };
    let peers: ChatSyncPeer[] = [endless];
    const sync = new ChatSyncEngine({
      nodeId: 'local',
      storage: local.asStorage(),
      peers: () => peers,
      passLimits: {
        maxPeers: 1,
        maxFrontierPages: 2,
        maxPages: 1,
        maxEvents: 1,
        maxBytes: 1024 * 1024,
      },
    });
    const state = sync as unknown as {
      continuations: Map<string, unknown>;
      pendingAttachmentPushes: Map<string, Set<string>>;
    };

    await sync.syncOnce();
    expect(state.continuations.has('departed')).toBe(true);
    state.pendingAttachmentPushes.set('departed', new Set(['stale']));
    peers = [];
    await sync.syncOnce();

    expect(state.continuations.has('departed')).toBe(false);
    expect(state.pendingAttachmentPushes.has('departed')).toBe(false);
  });

  it('coalesces overlapping passes and releases the slot after completion', async () => {
    let releaseExchange: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      releaseExchange = resolve;
    });
    const exchange = vi.fn(async () => {
      await gate;
      return { remotePage: { items: [] }, missingForRemote: [] };
    });
    const sync = engine(new MemoryEventStorage(), {
      nodeId: 'coalesced',
      exchangeVersionFrontierPage: exchange,
    });

    const first = sync.syncOnce();
    const second = sync.syncOnce();
    expect(second).toBe(first);
    await vi.waitFor(() => {
      expect(exchange).toHaveBeenCalledOnce();
    });
    releaseExchange?.();
    await Promise.all([first, second]);

    await sync.syncOnce();
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it('converges 100k origins across bounded passes even when every pass restarts the engine', async () => {
    const total = 100_000;
    const scaleConversationId = 'scale-conversation';
    const remoteFrontiers = Array.from({ length: total }, (_, index) => ({
      conversationId: scaleConversationId,
      originNodeId: `origin-${index.toString().padStart(6, '0')}`,
      maxContiguousOriginSequence: 1,
    }));
    let exchangeCalls = 0;
    const peer: ChatSyncPeer = {
      nodeId: 'scale-peer',
      async exchangeVersionFrontierPage(
        _localFrontiers,
        remoteAfter,
        includeRemotePage,
      ) {
        exchangeCalls += 1;
        if (!includeRemotePage) return { remotePage: { items: [] }, missingForRemote: [] };
        const start = remoteAfter === undefined
          ? 0
          : Number(remoteAfter.originNodeId.slice('origin-'.length)) + 1;
        const items = remoteFrontiers.slice(start, start + 128);
        const last = items.at(-1);
        return {
          remotePage: {
            items,
            ...(start + items.length < remoteFrontiers.length && last
              ? {
                nextCursor: {
                  conversationId: last.conversationId,
                  originNodeId: last.originNodeId,
                },
              }
              : {}),
          },
          missingForRemote: [],
        };
      },
      async pullMissingEvents(_selectedConversationId, ranges) {
        return {
          items: ranges.map(range => {
            const messageId = `${range.originNodeId}-message`;
            return {
              eventId: messageId,
              conversationId: scaleConversationId,
              originNodeId: range.originNodeId,
              originSequence: 1,
              lamportClock: 1,
              timestamp: 1,
              kind: 'message' as const,
              message: {
                messageId,
                turnId: messageId,
                role: 'user' as const,
                content: 'scale',
              },
            };
          }),
        };
      },
    };
    const local = new ScaleEventStorage();
    let passes = 0;
    let lastComplete = false;
    while (local.events.length < total && passes < 30) {
      const pass = await engine(local, peer).syncOnce();
      expect(pass.progress.pages).toBeLessThanOrEqual(64);
      expect(pass.progress.events).toBeLessThanOrEqual(4_096);
      expect(pass.progress.frontierPages).toBeLessThanOrEqual(2_048);
      if (!pass.complete) expect(pass.continuation?.reason).toBe('work-budget');
      lastComplete = pass.complete;
      passes += 1;
    }

    expect(local.events).toHaveLength(total);
    expect(passes).toBeGreaterThan(1);
    expect(passes).toBeLessThanOrEqual(30);
    expect(exchangeCalls).toBeGreaterThan(64);
    expect(lastComplete).toBe(true);
  });

  it('bounds explicit conversation scope before any peer work', () => {
    const scoped = Array.from({ length: 257 }, (_, index) => `conversation-${index}`);
    expect(() =>
      engine(
        new MemoryEventStorage(),
        new MemoryPeer('B', new MemoryEventStorage()),
        { conversationIds: scoped },
      )
    ).toThrow('invalid_sync_conversation_scope');
  });

  it('rejects huge, oversized, unknown-key, and gapped pages before insertion', async () => {
    const cases: Array<{ name: string; page: ConversationEventSyncPage }> = [
      {
        name: 'huge',
        page: { items: Array.from({ length: 100_000 }, () => messageEvent('B', 1)) },
      },
      {
        name: 'oversized',
        page: {
          items: [
            messageEvent('B', 1, 'x'.repeat(6_400_000)),
            messageEvent('B', 2, 'y'.repeat(6_400_000)),
          ],
        },
      },
      {
        name: 'assistant-paging-oversized',
        page: {
          items: [messageEvent('B', 1, '', {
            role: 'assistant',
            metadata: { padding: 'a'.repeat(248 * 1024) },
          })],
        },
      },
      {
        name: 'tool-paging-oversized',
        page: {
          items: [messageEvent('B', 1, '', {
            role: 'tool',
            metadata: { padding: 't'.repeat(248 * 1024) },
          })],
        },
      },
      {
        name: 'unknown-key',
        page: { items: [messageEvent('B', 1)], unexpected: true } as ConversationEventSyncPage,
      },
      {
        name: 'gap',
        page: { items: [messageEvent('B', 2)] },
      },
    ];
    for (const testCase of cases) {
      const local = new MemoryEventStorage();
      const peer: ChatSyncPeer = {
        nodeId: testCase.name,
        async exchangeVersionFrontierPage() {
          return {
            remotePage: {
              items: [{
                conversationId,
                originNodeId: 'B',
                maxContiguousOriginSequence: 2,
              }],
            },
            missingForRemote: [],
          };
        },
        async pullMissingEvents() {
          return testCase.page;
        },
      };
      await expect(engine(local, peer).syncOnce()).rejects.toThrow();
      expect(local.events, testCase.name).toEqual([]);
    }
  });

  it('does not ask a second peer after the first supplies a verified attachment', async () => {
    const local = new MemoryEventStorage();
    const remote = new MemoryEventStorage();
    const secondStorage = new MemoryEventStorage();
    const contentHash = 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const reference = { contentHash, filename: 'a.txt', mimeType: 'text/plain', size: 3 };
    const attached = messageEvent('B', 1, 'attachment', { attachments: [reference] });
    await remote.insertEventsIfAbsent([attached]);
    await secondStorage.insertEventsIfAbsent([attached]);
    remote.blobs.set(contentHash, { reference, data: new TextEncoder().encode('abc') });
    const first = new MemoryPeer('B', remote);
    const second = new MemoryPeer('C', secondStorage);
    const secondPull = vi.spyOn(second, 'pullAttachmentChunk');
    const sync = new ChatSyncEngine({
      nodeId: 'local',
      storage: local.asStorage(),
      peers: () => [first, second],
    });

    await sync.syncOnce();

    expect(secondPull).not.toHaveBeenCalled();
    expect(local.events).toContainEqual(attached);
  });

  it('rejects empty advancing event pages from peers and storage', async () => {
    const remoteCursor = cursor(messageEvent('B', 1));
    const local = new MemoryEventStorage();
    const peer: ChatSyncPeer = {
      nodeId: 'empty-peer',
      async exchangeVersionFrontierPage() {
        return {
          remotePage: {
            items: [{
              conversationId,
              originNodeId: 'B',
              maxContiguousOriginSequence: 1,
            }],
          },
          missingForRemote: [],
        };
      },
      async pullMissingEvents() {
        return { items: [], nextCursor: remoteCursor };
      },
    };
    await expect(engine(local, peer).syncOnce()).rejects.toThrow(
      'event_sync_cursor_not_last_item:empty-peer',
    );
    expect(local.events).toEqual([]);

    const pushing = new MemoryEventStorage();
    pushing.frontierOverrides = [{
      conversationId,
      originNodeId: 'A',
      maxContiguousOriginSequence: 1,
    }];
    pushing.getConversationEventPage = vi.fn(async () => ({
      items: [],
      hasMoreBefore: false,
      hasMoreAfter: true,
      endCursor: cursor(messageEvent('A', 1)),
    }));
    const destination = new MemoryEventStorage();
    await expect(engine(pushing, new MemoryPeer('destination', destination)).syncOnce())
      .rejects.toThrow('storage_event_cursor_did_not_advance');
  });

  it('passes cancellation to a pending frontier query', async () => {
    const storage = new MemoryEventStorage();
    const controller = new AbortController();
    const frontierQuery = vi.fn(async options =>
      new Promise<Awaited<ReturnType<MemoryEventStorage['getEventVersionFrontierPage']>>>(
        (_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            const reason = options.signal?.reason;
            reject(reason instanceof Error ? reason : new Error('sync_aborted'));
          }, { once: true });
        },
      )
    );
    storage.getEventVersionFrontierPage = frontierQuery;
    const sync = engine(storage, new MemoryPeer('B', new MemoryEventStorage()));
    const pending = sync.syncOnce({ signal: controller.signal });
    await vi.waitFor(() => {
      expect(frontierQuery).toHaveBeenCalledOnce();
    });
    controller.abort(new Error('cancelled_frontier_query'));

    await expect(pending).rejects.toThrow('cancelled_frontier_query');
    storage.getEventVersionFrontierPage = async options => MemoryEventStorage.prototype.getEventVersionFrontierPage.call(storage, options);
    const retried = sync.syncOnce();
    expect(retried).not.toBe(pending);
    await expect(retried).resolves.toMatchObject({ complete: true });
    expect(frontierQuery).toHaveBeenCalledOnce();
  });

  it('skips an offline peer in best-effort mode but fails fast in strict mode', async () => {
    const offline: ChatSyncPeer = {
      nodeId: 'offline',
      async exchangeVersionFrontierPage() {
        throw new Error('peer_offline');
      },
    };
    const remote = new MemoryEventStorage();
    await remote.insertEventsIfAbsent([messageEvent('B', 1)]);
    const healthy = new MemoryPeer('healthy', remote);
    const local = new MemoryEventStorage();
    await new ChatSyncEngine({
      nodeId: 'local',
      storage: local.asStorage(),
      peers: () => [offline, healthy],
      failOnMessageSyncError: false,
    }).syncOnce();
    expect(local.events).toHaveLength(1);

    const strictHealthy = new MemoryPeer('strict-healthy', remote);
    const strictExchange = vi.spyOn(strictHealthy, 'exchangeVersionFrontierPage');
    await expect(new ChatSyncEngine({
      nodeId: 'local',
      storage: new MemoryEventStorage().asStorage(),
      peers: () => [offline, strictHealthy],
      failOnMessageSyncError: true,
    }).syncOnce()).rejects.toThrow('peer_offline');
    expect(strictExchange).not.toHaveBeenCalled();
  });
});
