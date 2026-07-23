import { generateKeyPairSync } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CloudClient } from '../cloudClient.js';

describe('CloudClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers an OTP with optional public keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ nodeId: 'node-1', nodeSecret: 'secret-1' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new CloudClient('https://cloud.example.test/');
    await expect(
      client.registerWithOtp('123456', {
        x25519PublicKey: 'x-key',
        ed25519PublicKey: 'e-key',
      }),
    ).resolves.toEqual({ nodeId: 'node-1', nodeSecret: 'secret-1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.example.test/api/nodes/register',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          otp: '123456',
          x25519PublicKey: 'x-key',
          ed25519PublicKey: 'e-key',
        }),
      }),
    );
  });

  it('publishes encoded node IDs with bearer authentication', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new CloudClient('https://cloud.example.test');
    await client.registerNode({ nodeId: 'node/a', port: 5200 }, 'jwt-value');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.example.test/api/nodes/node%2Fa',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          authorization: 'Bearer jwt-value',
        }),
      }),
    );
  });

  it('signs a Cloud challenge with the supplied Ed25519 key', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const encodedPrivateKey = (
      privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
    ).toString('base64url');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          challenge: Buffer.from('challenge').toString('base64url'),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ accessToken: 'signed-jwt' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const client = new CloudClient('https://cloud.example.test');
    await expect(
      client.getJwtByChallenge('node-1', encodedPrivateKey),
    ).resolves.toEqual({ accessToken: 'signed-jwt' });
    const verificationBody = JSON.parse(
      fetchMock.mock.calls[1][1].body as string,
    ) as { signature?: string };
    expect(verificationBody.signature).toEqual(expect.any(String));
    expect(verificationBody.signature).not.toHaveLength(0);
  });

  it('reports bounded HTTP failure details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
      }),
    );

    await expect(
      new CloudClient('https://cloud.example.test').getJwt('node-1', 'bad'),
    ).rejects.toThrow('Cloud API 401: unauthorized');
  });
});
