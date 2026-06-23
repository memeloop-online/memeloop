import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { startMockCloud } from '../mockCloud.js';

function jsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe('mockCloud', () => {
  it('registers node, issues token, and validates auth for put/heartbeat', async () => {
    const cloud = await startMockCloud();
    try {
      const reg = await fetch(`${cloud.baseUrl}/api/nodes/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: '123456' }),
      });
      expect(reg.status).toBe(200);
      const regJson = await reg.json();
      expect(regJson.nodeId).toBeTruthy();
      expect(regJson.nodeSecret).toBeTruthy();

      const tok = await fetch(`${cloud.baseUrl}/api/nodes/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: regJson.nodeId, nodeSecret: regJson.nodeSecret }),
      });
      expect(tok.status).toBe(200);
      const tokJson = await tok.json();
      expect(tokJson.accessToken).toBeTruthy();

      // Unauthorized put
      const badPut = await fetch(`${cloud.baseUrl}/api/nodes/${regJson.nodeId}`, { method: 'PUT' });
      expect(badPut.status).toBe(401);
      const badPutJson = jsonParse(await badPut.text());
      expect(badPutJson.error).toBe('unauthorized');

      // Authorized put
      const goodPut = await fetch(`${cloud.baseUrl}/api/nodes/${regJson.nodeId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tokJson.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      });
      expect(goodPut.status).toBe(200);
      const goodPutJson = await goodPut.json();
      expect(goodPutJson.ok).toBe(true);

      // Unauthorized heartbeat
      const badHb = await fetch(`${cloud.baseUrl}/api/nodes/${regJson.nodeId}/heartbeat`, { method: 'POST' });
      expect(badHb.status).toBe(401);

      // Authorized heartbeat
      const goodHb = await fetch(`${cloud.baseUrl}/api/nodes/${regJson.nodeId}/heartbeat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokJson.accessToken}` },
      });
      expect(goodHb.status).toBe(200);
      const goodHbJson = await goodHb.json();
      expect(goodHbJson.ok).toBe(true);

      // 404
      const notFound = await fetch(`${cloud.baseUrl}/unknown`);
      expect(notFound.status).toBe(404);
    } finally {
      await cloud.stop();
    }
  });

  it('supports challenge-response token exchange', async () => {
    const cloud = await startMockCloud();
    try {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const publicKeyB64 = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url');
      const privateKeyObj = privateKey;

      const reg = await fetch(`${cloud.baseUrl}/api/nodes/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: '123456', ed25519PublicKey: publicKeyB64 }),
      });
      const regJson = await reg.json();

      const ch = await fetch(`${cloud.baseUrl}/api/nodes/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: regJson.nodeId }),
      });
      expect(ch.status).toBe(200);
      const chJson = await ch.json();

      const signature = sign(null, Buffer.from(chJson.challenge, 'base64url'), privateKeyObj).toString('base64url');
      const verifyResp = await fetch(`${cloud.baseUrl}/api/nodes/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: regJson.nodeId, signature }),
      });
      expect(verifyResp.status).toBe(200);
      const verifyJson = await verifyResp.json();
      expect(verifyJson.accessToken).toBeTruthy();
    } finally {
      await cloud.stop();
    }
  });
});
