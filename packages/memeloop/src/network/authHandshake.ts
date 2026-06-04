/**
 * WS auth handshake: first message after connect must be memeloop.auth.handshake.
 * Build/parse handshake message; actual credential verification is server-side.
 */

import type { AuthHandshakeParams as AuthHandshakeParameters } from '../protocol/index.js';

const AUTH_METHOD = 'memeloop.auth.handshake';

/**
 * Build the first message to send after WS open: JSON-RPC request for auth handshake.
 * Send this as the first message; server must respond success or close the connection.
 */
export function buildAuthHandshakeMessage(parameters: AuthHandshakeParameters): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: AUTH_METHOD,
    params: {
      nodeId: parameters.nodeId,
      authType: parameters.authType,
      credential: parameters.credential,
    },
  });
}

export interface ParsedHandshake {
  nodeId: string;
  authType: 'pairingToken' | 'jwt' | 'pin';
  credential: string;
}

/**
 * Parse incoming message; if it's an auth handshake request, return params.
 * Returns null if the message is not memeloop.auth.handshake.
 */
export function parseAuthHandshakeMessage(data: string): ParsedHandshake | null {
  let message: { method?: string; params?: AuthHandshakeParameters };
  try {
    message = JSON.parse(data) as typeof message;
  } catch {
    return null;
  }
  if (message.method !== AUTH_METHOD || !message.params) return null;
  const p = message.params;
  if (typeof p.nodeId !== 'string' || typeof p.authType !== 'string' || typeof p.credential !== 'string') {
    return null;
  }
  return { nodeId: p.nodeId, authType: p.authType as ParsedHandshake['authType'], credential: p.credential };
}
