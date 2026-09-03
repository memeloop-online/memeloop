import { hasCanonicalDeviceConnectionGrantClaims } from './deviceGrantMessages.js';
import { isLibp2pRequestEnvelope, isLibp2pResponseEnvelope } from './libp2pEnvelope.js';
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

export function isLibp2pRpcRequest(value: unknown): value is Libp2pRpcRequest {
  return isLibp2pRequestEnvelope(value, {
    type: LIBP2P_RPC_REQUEST_TYPE,
    validateGrant: hasCanonicalDeviceConnectionGrantClaims,
  });
}

export function isLibp2pRpcResponse(value: unknown): value is Libp2pRpcResponse {
  return isLibp2pResponseEnvelope(value, { type: LIBP2P_RPC_RESPONSE_TYPE });
}
