import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeviceCloudClient, normalizeDeviceCloudConfiguration } from '../cloudClient.js';

describe('DeviceCloudClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes HTTPS and permits loopback HTTP only', () => {
    expect(normalizeDeviceCloudConfiguration({
      baseUrl: ' https://cloud.example.test/ ',
      accessToken: ' token ',
    })).toEqual({ baseUrl: 'https://cloud.example.test', accessToken: 'token' });
    expect(
      normalizeDeviceCloudConfiguration({
        baseUrl: 'http://127.0.0.1:4000',
        accessToken: 'token',
      }).baseUrl,
    ).toBe('http://127.0.0.1:4000');
    expect(() =>
      normalizeDeviceCloudConfiguration({
        baseUrl: 'http://cloud.example.test',
        accessToken: 'token',
      })
    ).toThrow('cloud_url_requires_https');
  });

  it('rejects credentials, paths, query strings, fragments, and empty tokens', () => {
    for (
      const baseUrl of [
        'https://user:password@cloud.example.test',
        'https://cloud.example.test/api',
        'https://cloud.example.test?token=secret',
        'https://cloud.example.test#fragment',
      ]
    ) {
      expect(() => normalizeDeviceCloudConfiguration({ baseUrl, accessToken: 'token' })).toThrow('invalid_cloud_url');
    }
    expect(() =>
      normalizeDeviceCloudConfiguration({
        baseUrl: 'https://cloud.example.test',
        accessToken: ' ',
      })
    ).toThrow('invalid_cloud_access_token');
  });

  it('sends bounded fail-closed requests without following redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ devices: [] }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new DeviceCloudClient('https://cloud.example.test/', 'access-token');
    await expect(client.listDevices()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.example.test/api/devices',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer access-token' }),
        method: 'GET',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('rejects oversized and invalid JSON responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response('{}', {
          headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
        }),
      )
      .mockResolvedValueOnce(new Response('not-json'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new DeviceCloudClient('https://cloud.example.test', 'access-token');

    await expect(client.listDevices()).rejects.toThrow('cloud_response_too_large');
    await expect(client.listDevices()).rejects.toThrow('cloud_response_invalid_json');
  });
});
