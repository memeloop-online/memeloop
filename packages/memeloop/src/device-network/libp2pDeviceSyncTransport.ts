import type { ChatMessage } from '../conversation/index.js';
import type { ConversationMeta, VersionVector } from '../sync/protocol.js';
import { attachmentBlobFromWire, isLibp2pSyncResponse, LIBP2P_SYNC_REQUEST_TYPE, type Libp2pSyncMethod, type Libp2pSyncRequest } from './libp2pSyncProtocol.js';
import type { AttachmentBlob, Device, DeviceConnectionGrant, DeviceNetworkService, DeviceSyncTransport, ExchangeVersionVectorResult, MemeLoopDuplexStream } from './types.js';

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

  public pullMissingMetadata(peerId: string, sinceVersion: VersionVector): Promise<ConversationMeta[]> {
    return this.request(peerId, 'pullMissingMetadata', { sinceVersion }) as Promise<ConversationMeta[]>;
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
    const stream = await this.deviceNetwork.openStream(peerId, '/memeloop/sync/1.0.0', grant);
    const request: Libp2pSyncRequest = {
      type: LIBP2P_SYNC_REQUEST_TYPE,
      id: crypto.randomUUID(),
      method,
      params: parameters,
      grant,
    };
    await writeJsonToStream(stream, request);
    const response = await readJsonFromStream(stream);
    await stream.close();
    if (!isLibp2pSyncResponse(response)) throw new Error('invalid_sync_response');
    if (response.id !== request.id) throw new Error('sync_response_id_mismatch');
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }
}

async function writeJsonToStream(stream: MemeLoopDuplexStream, message: unknown): Promise<void> {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  await stream.sink(async function*() {
    yield payload;
  }());
}

async function readJsonFromStream(stream: MemeLoopDuplexStream): Promise<unknown> {
  const reader = stream.source[Symbol.asyncIterator]();
  const result = await reader.next();
  if (result.done || !result.value) throw new Error('sync_response_missing');
  return JSON.parse(new TextDecoder().decode(result.value)) as unknown;
}
