import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { portableSha256Hex } from '../../storage/atomicAgentRetry.js';
import { sha256HexSync } from '../sha256.js';

const encoder = new TextEncoder();

function nodeSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('portable SHA-256', () => {
  it.each([
    ['NIST empty vector', new Uint8Array(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['NIST abc vector', encoder.encode('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ])('matches the %s', (_name, bytes, expected) => {
    expect(sha256HexSync(bytes)).toBe(expected);
  });

  it.each([
    ['Unicode input', encoder.encode('MemeLoop 长会话 🚀')],
    ['multi-block input', encoder.encode('0123456789abcdef'.repeat(257))],
    ['2 MiB canonical-payload boundary', new Uint8Array(2 * 1_048_576).map((_, index) => index % 251)],
  ])('matches Node and WebCrypto for %s', async (_name, bytes) => {
    const expected = nodeSha256(bytes);
    expect(sha256HexSync(bytes)).toBe(expected);
    await expect(portableSha256Hex(bytes)).resolves.toBe(expected);
  });

  it('copies SharedArrayBuffer-backed input before calling WebCrypto', async () => {
    if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crypto?.subtle) return;
    const bytes = new Uint8Array(new SharedArrayBuffer(96));
    bytes.set(encoder.encode('shared-buffer-digest'));
    await expect(portableSha256Hex(bytes)).resolves.toBe(nodeSha256(bytes));
  });

  it('uses the pure implementation only when WebCrypto subtle is unavailable', async () => {
    const bytes = encoder.encode('fallback-without-subtle');
    vi.stubGlobal('crypto', {});
    try {
      await expect(portableSha256Hex(bytes)).resolves.toBe(sha256HexSync(bytes));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
