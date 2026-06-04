import { describe, expect, it } from 'vitest';

import { createPairingToken, verifyPairingToken } from '../pinPairing.js';

describe('pinPairing', () => {
  it('createPairingToken and verifyPairingToken roundtrip (uses Web Crypto or node webcrypto)', async () => {
    const secret = 'pair-secret-at-least-32-bytes-long-for-tests!!';
    const nodeId = 'node-a';
    const { token, issuedAt } = await createPairingToken(secret, nodeId);
    expect(token.startsWith('hmac-v1-')).toBe(true);
    expect(issuedAt).toBeGreaterThan(0);
    await expect(verifyPairingToken(token, secret, nodeId)).resolves.toBe(true);
    await expect(verifyPairingToken(token, secret, 'other-node')).resolves.toBe(false);
    await expect(verifyPairingToken('hmac-v1-deadbeef-1', secret, nodeId)).resolves.toBe(false);
  });
});
