import type { DeviceConnectionGrant } from './types.js';

export const LIBP2P_RPC_REQUEST_TYPE = 'memeloop-rpc-request-v1';
export const LIBP2P_RPC_RESPONSE_TYPE = 'memeloop-rpc-response-v1';

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
    error: string;
  };

export function isLibp2pRpcRequest(value: unknown): value is Libp2pRpcRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === LIBP2P_RPC_REQUEST_TYPE &&
    typeof record.id === 'string' &&
    typeof record.method === 'string'
  );
}

export function isLibp2pRpcResponse(value: unknown): value is Libp2pRpcResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== LIBP2P_RPC_RESPONSE_TYPE || typeof record.id !== 'string' || typeof record.ok !== 'boolean') return false;
  if (record.ok) return 'result' in record;
  return typeof record.error === 'string';
}
