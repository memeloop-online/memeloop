import type { FullAgentStorage, Libp2pSyncRequest } from 'memeloop/device-network/portable';
import {
  attachmentChunkFromWire,
  attachmentChunkToWire,
  conversationEventAttachmentReferences,
  MAX_SYNC_ATTACHMENT_BYTES,
  MAX_SYNC_ATTACHMENT_CHUNK_BYTES,
  versionVectorKey,
} from 'memeloop/device-network/portable';
import { assertOnlyParameterKeys, objectParameter } from './requestParameters.js';
import {
  assertValidStoredFrontierPage,
  booleanParameter,
  boundedEventSyncPage,
  canonicalEventBatchParameter,
  conversationIdsForGrant,
  conversationIdsParameter,
  eventCursorParameter,
  nonNegativeIntegerParameter,
  positiveIntegerParameter,
  stringParameter,
  versionFrontierArrayParameter,
  versionFrontierCursorParameter,
  versionRangeArrayParameter,
} from './syncParameters.js';

export async function handleSyncRequest(storage: FullAgentStorage | undefined, request: Libp2pSyncRequest, signal?: AbortSignal): Promise<unknown> {
  const requestSignal = signal ?? new AbortController().signal;
  requestSignal.throwIfAborted();
  if (!storage) throw new Error('sync_storage_not_configured');
  switch (request.method) {
    case 'exchangeVersionFrontierPage': {
      const parameters = objectParameter(request.params);
      assertOnlyParameterKeys(parameters, [
        'localFrontiers',
        'remoteAfter',
        'includeRemotePage',
        'conversationIds',
      ]);
      const conversationIds = conversationIdsForGrant(
        request.grant,
        conversationIdsParameter(request.params),
      );
      const localFrontiers = versionFrontierArrayParameter(parameters, 'localFrontiers');
      if (conversationIds && localFrontiers.some(frontier => !conversationIds.has(frontier.conversationId))) {
        throw new Error('device_grant_conversation_scope_violation');
      }
      const remoteAfter = versionFrontierCursorParameter(parameters, 'remoteAfter');
      const includeRemotePage = booleanParameter(parameters, 'includeRemotePage');
      if (!storage.getEventVersionFrontierPage || !storage.getEventVersionFrontiersForKeys) {
        throw new Error('sync_event_frontier_store_not_configured');
      }
      const remoteForLocal = signal
        ? await storage.getEventVersionFrontiersForKeys(localFrontiers, { signal })
        : await storage.getEventVersionFrontiersForKeys(localFrontiers);
      requestSignal.throwIfAborted();
      const remoteByKey = new Map(remoteForLocal.map(frontier => [
        versionVectorKey(frontier.conversationId, frontier.originNodeId),
        frontier.maxContiguousOriginSequence,
      ]));
      const missingForRemote = localFrontiers.flatMap(frontier => {
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
      });
      const remotePage = includeRemotePage
        ? await storage.getEventVersionFrontierPage({
          limit: 128,
          ...(remoteAfter ? { after: remoteAfter } : {}),
          ...(conversationIds ? { conversationIds: [...conversationIds] } : {}),
          ...(signal ? { signal } : {}),
        })
        : { items: [] };
      assertValidStoredFrontierPage(remotePage, remoteAfter, includeRemotePage);
      return {
        remotePage,
        missingForRemote,
      };
    }
    case 'pullMissingEvents': {
      const parameters = objectParameter(request.params);
      assertOnlyParameterKeys(parameters, ['conversationId', 'ranges', 'cursor']);
      const conversationId = stringParameter(parameters, 'conversationId');
      conversationIdsForGrant(request.grant, new Set([conversationId]));
      const ranges = versionRangeArrayParameter(parameters, 'ranges');
      if (ranges.some(range => range.conversationId !== conversationId)) {
        throw new Error('invalid_sync_range_conversation');
      }
      const cursor = eventCursorParameter(parameters, 'cursor');
      if (!storage.getConversationEventPage) throw new Error('sync_event_store_not_configured');
      const page = await storage.getConversationEventPage(conversationId, {
        limit: 128,
        after: cursor,
        direction: 'forward',
        ranges,
        ...(signal ? { signal } : {}),
      });
      requestSignal.throwIfAborted();
      return boundedEventSyncPage(page, ranges, cursor);
    }
    case 'pullAttachmentChunk': {
      const parameters = objectParameter(request.params);
      assertOnlyParameterKeys(parameters, [
        'conversationId',
        'contentHash',
        'offset',
        'maxBytes',
      ]);
      const conversationId = stringParameter(parameters, 'conversationId');
      conversationIdsForGrant(request.grant, new Set([conversationId]));
      const contentHash = stringParameter(parameters, 'contentHash');
      const offset = nonNegativeIntegerParameter(parameters, 'offset');
      const maxBytes = positiveIntegerParameter(parameters, 'maxBytes');
      if (maxBytes > MAX_SYNC_ATTACHMENT_CHUNK_BYTES) {
        throw new Error('invalid_sync_attachment_chunk');
      }
      const referenced = signal
        ? await storage.conversationReferencesAttachment(conversationId, contentHash, { signal })
        : await storage.conversationReferencesAttachment(conversationId, contentHash);
      if (!referenced) {
        throw new Error('sync_attachment_not_referenced');
      }
      const reference = signal
        ? await storage.getAttachment(contentHash, { signal })
        : await storage.getAttachment(contentHash);
      if (
        !reference || reference.size > MAX_SYNC_ATTACHMENT_BYTES || offset > reference.size ||
        !storage.readAttachmentRange || !storage.verifyAttachment
      ) {
        throw new Error('sync_attachment_unavailable');
      }
      const verified = offset !== 0 || (signal
        ? await storage.verifyAttachment(contentHash, { signal })
        : await storage.verifyAttachment(contentHash));
      if (!verified) {
        throw new Error('sync_attachment_corrupt');
      }
      const data = signal
        ? await storage.readAttachmentRange(contentHash, offset, maxBytes, { signal })
        : await storage.readAttachmentRange(contentHash, offset, maxBytes);
      if (
        !data || data.byteLength > maxBytes ||
        (data.byteLength === 0 && offset !== reference.size)
      ) {
        throw new Error('sync_attachment_read_failed');
      }
      return attachmentChunkToWire({
        data,
        offset,
        totalSize: reference.size,
        done: offset + data.byteLength === reference.size,
        filename: reference.filename,
        mimeType: reference.mimeType,
      });
    }
    case 'pushAttachmentChunk': {
      const parameters = objectParameter(request.params);
      assertOnlyParameterKeys(parameters, ['conversationId', 'contentHash', 'chunk']);
      const conversationId = stringParameter(parameters, 'conversationId');
      conversationIdsForGrant(request.grant, new Set([conversationId]));
      const contentHash = stringParameter(parameters, 'contentHash');
      const chunk = await attachmentChunkFromWire(parameters.chunk);
      if (
        !chunk || !/^sha256:[\da-f]{64}$/iu.test(contentHash) ||
        !storage.stageAttachmentChunk || !storage.commitStagedAttachment
      ) {
        throw new Error('invalid_sync_attachment_chunk');
      }
      const reference = {
        contentHash,
        filename: chunk.filename,
        mimeType: chunk.mimeType,
        size: chunk.totalSize,
      };
      const nextOffset = signal
        ? await storage.stageAttachmentChunk(reference, chunk.offset, chunk.data, { signal })
        : await storage.stageAttachmentChunk(reference, chunk.offset, chunk.data);
      if (
        !Number.isSafeInteger(nextOffset) || nextOffset < chunk.offset + chunk.data.byteLength ||
        nextOffset > chunk.totalSize
      ) {
        throw new Error('sync_attachment_cursor_mismatch');
      }
      if (chunk.done) {
        if (signal) await storage.commitStagedAttachment(contentHash, { signal });
        else await storage.commitStagedAttachment(contentHash);
      }
      return { nextOffset, complete: chunk.done };
    }
    case 'pushEvents': {
      const parameters = objectParameter(request.params);
      assertOnlyParameterKeys(parameters, ['events']);
      const events = canonicalEventBatchParameter(parameters.events);
      conversationIdsForGrant(
        request.grant,
        new Set(events.map(event => event.conversationId)),
      );
      for (const event of events) {
        for (const attachment of conversationEventAttachmentReferences(event)) {
          const reference = signal
            ? await storage.getAttachment(attachment.contentHash, { signal })
            : await storage.getAttachment(attachment.contentHash);
          if (
            !reference ||
            reference.size !== attachment.size ||
            !storage.verifyAttachment
          ) {
            throw new Error('sync_attachment_missing');
          }
          const verified = signal
            ? await storage.verifyAttachment(attachment.contentHash, { signal })
            : await storage.verifyAttachment(attachment.contentHash);
          if (!verified) throw new Error('sync_attachment_missing');
        }
      }
      if (!storage.insertEventsIfAbsent) throw new Error('sync_event_store_not_configured');
      requestSignal.throwIfAborted();
      await storage.insertEventsIfAbsent(events);
      requestSignal.throwIfAborted();
      return { accepted: events.length };
    }
  }
  throw new Error('unsupported_sync_method');
}
