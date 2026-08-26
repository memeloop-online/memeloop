import { hasCanonicalDeviceConnectionGrantClaims } from './deviceGrantMessages.js';
import type { DeviceConnectionGrant } from './types.js';

export const LIBP2P_RPC_REQUEST_TYPE = 'memeloop-rpc-request-v2';
export const LIBP2P_RPC_RESPONSE_TYPE = 'memeloop-rpc-response-v2';

export interface Libp2pRpcRequest {
  type: typeof LIBP2P_RPC_REQUEST_TYPE;
  id: string;
  method: string;
  params: unknown;
  grant?: DeviceConnectionGrant;
}

export type Libp2pRpcResponse =
  | {
    type: typeof LIBP2P_RPC_RESPONSE_TYPE;
    id: string;
    ok: true;
    result: unknown;
  }
  | {
    type: typeof LIBP2P_RPC_RESPONSE_TYPE;
    id: string;
    ok: false;
    error: { code: string };
  };

const MAX_RPC_ID_LENGTH = 128;
const MAX_RPC_METHOD_LENGTH = 256;
const RPC_ERROR_CODE_PATTERN = /^[a-z][a-z\d_]{0,63}$/u;

export function isLibp2pRpcRequest(value: unknown): value is Libp2pRpcRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    hasOnlyKeys(record, ['type', 'id', 'method', 'params', 'grant']) &&
    record.type === LIBP2P_RPC_REQUEST_TYPE &&
    typeof record.id === 'string' &&
    record.id.length > 0 && record.id.length <= MAX_RPC_ID_LENGTH &&
    typeof record.method === 'string' &&
    record.method.length > 0 && record.method.length <= MAX_RPC_METHOD_LENGTH &&
    'params' in record &&
    (record.grant === undefined || hasCanonicalDeviceConnectionGrantClaims(record.grant))
  );
}

export function isLibp2pRpcResponse(value: unknown): value is Libp2pRpcResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.type !== LIBP2P_RPC_RESPONSE_TYPE || typeof record.id !== 'string' ||
    record.id.length === 0 || record.id.length > MAX_RPC_ID_LENGTH ||
    typeof record.ok !== 'boolean'
  ) return false;
  if (record.ok) return hasOnlyKeys(record, ['type', 'id', 'ok', 'result']);
  if (
    !hasOnlyKeys(record, ['type', 'id', 'ok', 'error']) ||
    record.error === null || typeof record.error !== 'object' || Array.isArray(record.error)
  ) return false;
  const error = record.error as Record<string, unknown>;
  return hasOnlyKeys(error, ['code']) && typeof error.code === 'string' &&
    RPC_ERROR_CODE_PATTERN.test(error.code);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every(key => allowedKeys.has(key));
}
