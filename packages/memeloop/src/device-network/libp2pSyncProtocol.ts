import { decodeBase64, encodeBase64 } from '../encoding/base64.js';
import { hasOnlyKeys, isLibp2pRequestEnvelope, isLibp2pResponseEnvelope } from './libp2pEnvelope.js';
import type { DeviceConnectionGrant } from './types.js';

export const LIBP2P_SYNC_REQUEST_TYPE = 'memeloop-sync-request-v2';
export const LIBP2P_SYNC_RESPONSE_TYPE = 'memeloop-sync-response-v2';

export type Libp2pSyncMethod =
  | 'exchangeVersionFrontierPage'
  | 'pullMissingEvents'
  | 'pullAttachmentChunk'
  | 'pushEvents'
  | 'pushAttachmentChunk';

export interface Libp2pSyncRequest {
  type: typeof LIBP2P_SYNC_REQUEST_TYPE;
  id: string;
  method: Libp2pSyncMethod;
  params: unknown;
  grant?: DeviceConnectionGrant;
}

export type Libp2pSyncResponse =
  | {
    type: typeof LIBP2P_SYNC_RESPONSE_TYPE;
    id: string;
    ok: true;
    result: unknown;
  }
  | {
    type: typeof LIBP2P_SYNC_RESPONSE_TYPE;
    id: string;
    ok: false;
    error: { code: string };
  };

export const MAX_SYNC_ATTACHMENT_CHUNK_BYTES = 3 * 1024 * 1024;
export const MAX_SYNC_ATTACHMENT_BYTES = 64 * 1024 * 1024;

export interface AttachmentChunkWire {
  dataBase64Url: string;
  byteLength: number;
  offset: number;
  totalSize: number;
  done: boolean;
  filename: string;
  mimeType: string;
}

const syncMethods = new Set<Libp2pSyncMethod>([
  'exchangeVersionFrontierPage',
  'pullMissingEvents',
  'pullAttachmentChunk',
  'pushEvents',
  'pushAttachmentChunk',
]);

export function isLibp2pSyncRequest(value: unknown): value is Libp2pSyncRequest {
  return isLibp2pRequestEnvelope(value, {
    type: LIBP2P_SYNC_REQUEST_TYPE,
    validateMethod: method => syncMethods.has(method as Libp2pSyncMethod),
  });
}

export function isLibp2pSyncResponse(value: unknown): value is Libp2pSyncResponse {
  return isLibp2pResponseEnvelope(value, { type: LIBP2P_SYNC_RESPONSE_TYPE });
}
function isAttachmentChunkWire(value: unknown): value is AttachmentChunkWire {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    hasOnlyKeys(record, [
      'dataBase64Url',
      'byteLength',
      'offset',
      'totalSize',
      'done',
      'filename',
      'mimeType',
    ]) &&
    typeof record.dataBase64Url === 'string' &&
    typeof record.byteLength === 'number' &&
    typeof record.offset === 'number' &&
    typeof record.totalSize === 'number' &&
    typeof record.done === 'boolean' &&
    typeof record.filename === 'string' &&
    typeof record.mimeType === 'string'
  );
}

export async function attachmentChunkFromWire(value: unknown): Promise<
  {
    data: Uint8Array;
    offset: number;
    totalSize: number;
    done: boolean;
    filename: string;
    mimeType: string;
  } | null
> {
  if (value === null) return null;
  if (
    !isAttachmentChunkWire(value) ||
    !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 ||
    value.byteLength > MAX_SYNC_ATTACHMENT_CHUNK_BYTES ||
    !Number.isSafeInteger(value.offset) || value.offset < 0 ||
    !Number.isSafeInteger(value.totalSize) || value.totalSize < 0 ||
    value.totalSize > MAX_SYNC_ATTACHMENT_BYTES ||
    value.offset + value.byteLength > value.totalSize ||
    value.done !== (value.offset + value.byteLength === value.totalSize) ||
    (!value.done && value.byteLength === 0) ||
    value.dataBase64Url.length > Math.ceil(MAX_SYNC_ATTACHMENT_CHUNK_BYTES / 3) * 4 + 4 ||
    value.filename.length > 512 || value.mimeType.length > 256
  ) {
    throw new Error('invalid_sync_attachment_chunk');
  }
  let data: Uint8Array;
  try {
    data = decodeBase64(value.dataBase64Url, {
      variant: 'url',
      padding: 'optional',
      maxBytes: MAX_SYNC_ATTACHMENT_CHUNK_BYTES,
    });
  } catch {
    throw new Error('invalid_sync_attachment_chunk');
  }
  if (data.byteLength !== value.byteLength) throw new Error('invalid_sync_attachment_chunk');
  return {
    data,
    offset: value.offset,
    totalSize: value.totalSize,
    done: value.done,
    filename: value.filename,
    mimeType: value.mimeType,
  };
}

export function attachmentChunkToWire(value: {
  data: Uint8Array;
  offset: number;
  totalSize: number;
  done: boolean;
  filename: string;
  mimeType: string;
}): AttachmentChunkWire {
  if (
    value.data.byteLength > MAX_SYNC_ATTACHMENT_CHUNK_BYTES ||
    !Number.isSafeInteger(value.offset) || value.offset < 0 ||
    !Number.isSafeInteger(value.totalSize) || value.totalSize < 0 ||
    value.totalSize > MAX_SYNC_ATTACHMENT_BYTES ||
    value.offset + value.data.byteLength > value.totalSize ||
    value.done !== (value.offset + value.data.byteLength === value.totalSize) ||
    (!value.done && value.data.byteLength === 0)
  ) {
    throw new Error('invalid_sync_attachment_chunk');
  }
  return {
    dataBase64Url: encodeBase64(value.data, 'url'),
    byteLength: value.data.byteLength,
    offset: value.offset,
    totalSize: value.totalSize,
    done: value.done,
    filename: value.filename,
    mimeType: value.mimeType,
  };
}
