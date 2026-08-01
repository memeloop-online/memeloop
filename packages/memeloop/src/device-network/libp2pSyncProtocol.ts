import type { DeviceConnectionGrant } from './types.js';

export const LIBP2P_SYNC_REQUEST_TYPE = 'memeloop-sync-request-v2';
export const LIBP2P_SYNC_RESPONSE_TYPE = 'memeloop-sync-response-v2';

export type Libp2pSyncMethod =
  | 'exchangeVersionVector'
  | 'pullMissingMetadata'
  | 'pullMissingMessages'
  | 'pullAttachmentBlob';

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
    error: string;
  };

export interface AttachmentBlobWire {
  dataBase64Url: string;
  filename: string;
  mimeType: string;
  size: number;
}

const syncMethods = new Set<Libp2pSyncMethod>([
  'exchangeVersionVector',
  'pullMissingMetadata',
  'pullMissingMessages',
  'pullAttachmentBlob',
]);

export function isLibp2pSyncRequest(value: unknown): value is Libp2pSyncRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === LIBP2P_SYNC_REQUEST_TYPE &&
    typeof record.id === 'string' &&
    typeof record.method === 'string' &&
    syncMethods.has(record.method as Libp2pSyncMethod)
  );
}

export function isLibp2pSyncResponse(value: unknown): value is Libp2pSyncResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== LIBP2P_SYNC_RESPONSE_TYPE || typeof record.id !== 'string' || typeof record.ok !== 'boolean') return false;
  if (record.ok) return 'result' in record;
  return typeof record.error === 'string';
}

function isAttachmentBlobWire(value: unknown): value is AttachmentBlobWire {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.dataBase64Url === 'string' &&
    typeof record.filename === 'string' &&
    typeof record.mimeType === 'string' &&
    typeof record.size === 'number'
  );
}

export async function attachmentBlobFromWire(value: unknown): Promise<
  {
    data: Uint8Array;
    filename: string;
    mimeType: string;
    size: number;
  } | null
> {
  if (value === null) return null;
  if (!isAttachmentBlobWire(value)) throw new Error('invalid_sync_response');
  let data: Uint8Array;
  try {
    const base64 = value.dataBase64Url.replace(/-/g, '+').replace(/_/g, '/');
    const paddedBase64 = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = atob(paddedBase64);
    data = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error('invalid_sync_response');
  }
  return {
    data,
    filename: value.filename,
    mimeType: value.mimeType,
    size: value.size,
  };
}
