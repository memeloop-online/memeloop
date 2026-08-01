import type { ChatMessage } from '../conversation/index.js';
import type { ConversationMetadataPage, VersionVector } from '../sync/protocol.js';
import { createJsonFrameReader, encodeJsonFrames, JsonFrameError } from './jsonFrame.js';
import { attachmentBlobFromWire, isLibp2pSyncResponse, LIBP2P_SYNC_REQUEST_TYPE, type Libp2pSyncMethod, type Libp2pSyncRequest } from './libp2pSyncProtocol.js';
import type { AttachmentBlob, Device, DeviceConnectionGrant, DeviceNetworkService, DeviceSyncTransport, ExchangeVersionVectorResult } from './types.js';

export interface Libp2pDeviceSyncTransportOptions {
  nodeId: string;
  deviceNetwork: Pick<DeviceNetworkService, 'listDevices' | 'openStream'>;
  grantProvider?: (peerId: string) => Promise<DeviceConnectionGrant | undefined>;
}

export class Libp2pDeviceSyncTransport implements DeviceSyncTransport {
  public readonly nodeId: string;
  private readonly deviceNetwork: Pick<DeviceNetworkService, 'listDevices' | 'openStream'>;
  private readonly grantProvider?: (peerId: string) => Promise<DeviceConnectionGrant | undefined>;

  constructor(options: Libp2pDeviceSyncTransportOptions) {
    this.nodeId = options.nodeId;
    this.deviceNetwork = options.deviceNetwork;
    this.grantProvider = options.grantProvider;
  }

  public listPeers(): Promise<Device[]> {
    return this.deviceNetwork.listDevices();
  }

  public exchangeVersionVector(peerId: string, localVersion: VersionVector): Promise<ExchangeVersionVectorResult> {
    return this.request(peerId, 'exchangeVersionVector', { localVersion }) as Promise<ExchangeVersionVectorResult>;
  }

  public pullMissingMetadata(
    peerId: string,
    sinceVersion: VersionVector,
    cursor?: string,
  ): Promise<ConversationMetadataPage> {
    return this.request(peerId, 'pullMissingMetadata', {
      sinceVersion,
      cursor,
    }) as Promise<ConversationMetadataPage>;
  }

  public pullMissingMessages(peerId: string, conversationId: string, knownMessageIds: string[]): Promise<ChatMessage[]> {
    return this.request(peerId, 'pullMissingMessages', { conversationId, knownMessageIds }) as Promise<ChatMessage[]>;
  }

  public async pullAttachmentBlob(peerId: string, contentHash: string): Promise<AttachmentBlob | null> {
    const result = await this.request(peerId, 'pullAttachmentBlob', { contentHash });
    return attachmentBlobFromWire(result);
  }

  private async request(peerId: string, method: Libp2pSyncMethod, parameters: unknown): Promise<unknown> {
    const grant = await this.grantProvider?.(peerId);
    const stream = await this.deviceNetwork.openStream(peerId, '/memeloop/sync/2.0.0', grant);
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
          abort: async (error) => stream.abort(error),
        })
      ) {
        if (response !== undefined) throw new Error('sync_response_multiple');
        response = value;
      }
      if (!isLibp2pSyncResponse(response)) throw new Error('invalid_sync_response');
      if (response.id !== request.id) throw new Error('sync_response_id_mismatch');
      if (!response.ok) throw new Error(response.error);
      return response.result;
    } catch (error) {
      if (error instanceof JsonFrameError) await stream.abort(error);
      throw error;
    } finally {
      await stream.close().catch(() => undefined);
    }
  }
}
