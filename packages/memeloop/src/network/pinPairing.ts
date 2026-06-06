/**
 * LAN PIN pairing: generate PIN, issue pairing token after verification.
 * Uses HMAC so only the server that generated the PIN can issue a valid token.
 * Uses Web Crypto API for cross-environment compatibility.
 */

import type { PairingToken } from './protocol.js';

const PIN_LENGTH = 6;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Generate a 6-digit numeric PIN for display to the user.
 */
export function generatePin(): string {
  const digits = [];
  for (let index = 0; index < PIN_LENGTH; index++) {
    digits.push(crypto.getRandomValues(new Uint32Array(1))[0] % 10);
  }
  return digits.join('');
}

/**
 * Create a pairing token after the server has verified the client's PIN.
 * Token format: "hmac-v1-<hex>-<issuedAt>"; same secret verifies later.
 */
export async function createPairingToken(secret: string, nodeId: string): Promise<PairingToken> {
  const issuedAt = Date.now();
  const payload = `${nodeId}:${issuedAt}`;
  const token = await hmacSha256Hex(secret, payload, issuedAt);
  return {
    token,
    issuedAt,
    expiresAt: issuedAt + TOKEN_TTL_MS,
  };
}

/**
 * Verify a pairing token (server-side). Returns true if token is valid.
 */
export async function verifyPairingToken(
  token: string,
  secret: string,
  nodeId: string,
): Promise<boolean> {
  if (!token || !secret) return false;
  const parts = token.split('-');
  if (parts[0] !== 'hmac' || parts[1] !== 'v1' || parts.length < 4) return false;
  const issuedAt = parseInt(parts[3], 10) || 0;
  if (Number.isNaN(issuedAt) || issuedAt + TOKEN_TTL_MS < Date.now()) return false;
  const expected = await hmacSha256Hex(secret, `${nodeId}:${issuedAt}`, issuedAt);
  return token === expected;
}

function getSubtle(): SubtleCrypto {
  return crypto.subtle;
}

async function hmacSha256Hex(secret: string, payload: string, issuedAt: number): Promise<string> {
  const enc = new TextEncoder();
  const subtle = getSubtle();
  const keyMaterial = enc.encode(secret).length >= 32 ? enc.encode(secret) : new Uint8Array(await sha256(secret));
  const key = await subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', key, enc.encode(payload));
  const hex = bufferToHex(new Uint8Array(sig));
  return `hmac-v1-${hex}-${issuedAt}`;
}

async function sha256(s: string): Promise<ArrayBuffer> {
  return getSubtle().digest('SHA-256', new TextEncoder().encode(s));
}

function bufferToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
