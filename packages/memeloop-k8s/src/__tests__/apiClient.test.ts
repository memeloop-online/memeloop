import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KubernetesApiClient } from '../apiClient.js';

describe('KubernetesApiClient', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/version?detail=full') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ gitVersion: 'v1.31.0' }));
        return;
      }
      if (request.url === '/limited') {
        response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '3' });
        response.end(JSON.stringify({ reason: 'TooManyRequests', message: 'slow down' }));
        return;
      }
      if (request.url === '/unavailable') {
        response.statusMessage = 'Backend Down';
        response.writeHead(503);
        response.end();
        return;
      }
      if (request.url === '/auth') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ authorization: request.headers.authorization }));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ reason: 'NotFound', message: 'missing' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  it('parses JSON responses and encodes query parameters', async () => {
    const client = new KubernetesApiClient({ baseUrl });

    await expect(client.request('GET', '/version', { query: { detail: 'full' } })).resolves.toEqual({
      gitVersion: 'v1.31.0',
    });
  });

  it('maps Kubernetes Status errors and Retry-After metadata', async () => {
    const client = new KubernetesApiClient({ baseUrl });

    await expect(client.request('GET', '/limited')).rejects.toMatchObject({
      code: 'EXHAUSTED',
      retryable: true,
      retryAfterMs: 3000,
      message: expect.stringContaining('TooManyRequests: slow down'),
      details: { statusCode: 429 },
    });
  });

  it('uses the HTTP status message when an error body is empty', async () => {
    const client = new KubernetesApiClient({ baseUrl });

    await expect(client.request('GET', '/unavailable')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      retryable: true,
      message: expect.stringContaining('Backend Down'),
      details: { statusCode: 503 },
    });
  });

  it('loads bearer credentials from a file without embedding them in driver config', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'memeloop-k8s-auth-'));
    try {
      const tokenPath = path.join(directory, 'token');
      await writeFile(tokenPath, 'file-token\n', { mode: 0o600 });
      const client = new KubernetesApiClient({ baseUrl, bearerTokenFile: tokenPath });
      await expect(client.request('GET', '/auth')).resolves.toEqual({ authorization: 'Bearer file-token' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous inline and file credential configuration', () => {
    expect(() =>
      new KubernetesApiClient({
        baseUrl,
        bearerToken: 'inline',
        bearerTokenFile: '/not-read',
      })
    ).toThrow(/only one/);
  });
});
