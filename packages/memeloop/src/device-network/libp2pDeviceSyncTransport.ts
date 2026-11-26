import type { ConversationEvent, ConversationEventCursor } from '../conversation/index.js';
import type { MessageVersionFrontier, MessageVersionFrontierCursor } from '../storage/ports.js';
import type { SyncIoOptions } from '../sync/chatSyncEngine.js';
import type { ConversationEventSyncPage, VersionRange } from '../sync/protocol.js';
import { bindFramedStreamLifecycle } from './framedStreamLifecycle.js';
import { createJsonFrameReader, encodeJsonFrames } from './jsonFrame.js';
import {
  attachmentChunkFromWire,
  attachmentChunkToWire,
  isLibp2pSyncResponse,
  LIBP2P_SYNC_REQUEST_TYPE,
  type Libp2pSyncMethod,
  type Libp2pSyncRequest,
} from './libp2pSyncProtocol.js';
import type { AttachmentChunk, Device, DeviceConnectionGrant, DeviceNetworkService, DeviceSyncTransport, ExchangeVersionFrontierPageResult } from './types.js';

export interface Libp2pDeviceSyncTransportOptions {
  nodeId: string;
  deviceNetwork: Pick<DeviceNetworkService, 'listDevices' | 'openStream'>;
  grantProvider?: (peerId: string, signal?: AbortSignal) => Promise<DeviceConnectionGrant | undefined>;
  signal?: AbortSignal;
}

export class Libp2pDeviceSyncTransport implements DeviceSyncTransport {
  public readonly nodeId: string;
  private readonly deviceNetwork: Pick<DeviceNetworkService, 'listDevices' | 'openStream'>;
  private readonly grantProvider?: (
    peerId: string,
    signal?: AbortSignal,
  ) => Promise<DeviceConnectionGrant | undefined>;
  private readonly signal?: AbortSignal;

  constructor(options: Libp2pDeviceSyncTransportOptions) {
    this.nodeId = options.nodeId;
    this.deviceNetwork = options.deviceNetwork;
    this.grantProvider = options.grantProvider;
    this.signal = options.signal;
  }

  public listPeers(): Promise<Device[]> {
    return this.deviceNetwork.listDevices();
  }

  public exchangeVersionFrontierPage(
    peerId: string,
    localFrontiers: MessageVersionFrontier[],
    remoteAfter: MessageVersionFrontierCursor | undefined,
    includeRemotePage: boolean,
    conversationIds?: string[],
    options?: SyncIoOptions,
  ): Promise<ExchangeVersionFrontierPageResult> {
    return this.request(peerId, 'exchangeVersionFrontierPage', {
      localFrontiers,
      remoteAfter,
      includeRemotePage,
      conversationIds,
    }, options?.signal) as Promise<ExchangeVersionFrontierPageResult>;
  }

  public pullMissingEvents(
    peerId: string,
    conversationId: string,
    ranges: VersionRange[],
    cursor?: ConversationEventCursor,
    options?: SyncIoOptions,
  ): Promise<ConversationEventSyncPage> {
    return this.request(peerId, 'pullMissingEvents', { conversationId, ranges, cursor }, options?.signal) as Promise<ConversationEventSyncPage>;
  }

  public async pullAttachmentChunk(
    peerId: string,
    conversationId: string,
    contentHash: string,
    offset: number,
    maxBytes: number,
    options?: SyncIoOptions,
  ): Promise<AttachmentChunk | null> {
    const result = await this.request(
      peerId,
      'pullAttachmentChunk',
      { conversationId, contentHash, offset, maxBytes },
      options?.signal,
    );
    return attachmentChunkFromWire(result);
  }

  public async pushEvents(
    peerId: string,
    events: ConversationEvent[],
    options?: SyncIoOptions,
  ): Promise<void> {
    await this.request(peerId, 'pushEvents', { events }, options?.signal);
  }

  public async pushAttachmentChunk(
    peerId: string,
    conversationId: string,
    contentHash: string,
    chunk: AttachmentChunk,
    options?: SyncIoOptions,
  ): Promise<void> {
    await this.request(peerId, 'pushAttachmentChunk', {
      conversationId,
      contentHash,
      chunk: attachmentChunkToWire(chunk),
    }, options?.signal);
  }

  private async request(
    peerId: string,
    method: Libp2pSyncMethod,
    parameters: unknown,
    operationSignal?: AbortSignal,
  ): Promise<unknown> {
    const signal = operationSignal ?? this.signal;
    const grant = await this.grantProvider?.(peerId, signal);
    const stream = await this.deviceNetwork.openStream(peerId, '/memeloop/sync/2.0.0', {
      presentedGrant: grant,
      signal,
    });
    const lifecycle = bindFramedStreamLifecycle(stream, signal, new Error('sync transport aborted'));
    const request: Libp2pSyncRequest = {
      type: LIBP2P_SYNC_REQUEST_TYPE,
      id: crypto.randomUUID(),
      method,
      params: parameters,
      grant,
    };
    try {
      await stream.sink(encodeJsonFrames([request], 16 * 1024 * 1024));
      let response: unknown;
      for await (
        const value of createJsonFrameReader(stream.source, {
          maxPayloadBytes: 16 * 1024 * 1024,
          idleTimeoutMs: 15_000,
          totalTimeoutMs: 120_000,
          signal,
          abort: error => lifecycle.abort(error),
        })
      ) {
        if (response !== undefined) throw new Error('sync_response_multiple');
        response = value;
      }
      if (!isLibp2pSyncResponse(response)) throw new Error('invalid_sync_response');
      if (response.id !== request.id) throw new Error('sync_response_id_mismatch');
      if (!response.ok) throw new Error(response.error.code);
      return response.result;
    } catch (error) {
      await lifecycle.abort(error instanceof Error ? error : new Error('sync_transport_failed'));
      if (signal?.aborted) signal.throwIfAborted();
      throw error;
    } finally {
      lifecycle.dispose();
      await stream.close().catch(() => undefined);
    }
  }
}
