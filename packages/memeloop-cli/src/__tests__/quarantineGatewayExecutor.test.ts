import { describe, expect, it, vi } from 'vitest';

import { createQuarantineGatewayExecutor } from '../orchestration/quarantineGatewayExecutor.js';

function responseOf(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(new TextEncoder().encode(body), { status, headers });
}

const PUBLIC_DNS = async () => ['93.184.216.34'];

describe('createQuarantineGatewayExecutor', () => {
  it('validates then fetches with manual redirect handling', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(responseOf(200, 'ok'));
    const executor = createQuarantineGatewayExecutor({
      policy: { allowedHosts: ['api.example.com'] },
      fetchImpl,
      resolveHostname: PUBLIC_DNS,
    });

    const response = await executor.execute({ workerId: 'w1', method: 'GET', url: 'https://api.example.com/v1' });

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe('ok');
    expect(response.redirectCount).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example.com/v1', expect.objectContaining({ redirect: 'manual' }));
  });

  it('never calls fetch for a rejected request', async () => {
    const fetchImpl = vi.fn();
    const executor = createQuarantineGatewayExecutor({
      policy: {},
      fetchImpl,
      resolveHostname: PUBLIC_DNS,
    });

    await expect(executor.execute({ workerId: 'w1', method: 'GET', url: 'https://169.254.169.254/latest' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('follows redirects only within policy and revalidates each hop', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(responseOf(302, '', { location: 'https://cdn.api.example.com/file' }))
      .mockResolvedValueOnce(responseOf(200, 'payload'));
    const executor = createQuarantineGatewayExecutor({
      policy: { allowedHosts: ['api.example.com'], maxRedirects: 2 },
      fetchImpl,
      resolveHostname: PUBLIC_DNS,
    });

    const response = await executor.execute({ workerId: 'w1', method: 'GET', url: 'https://api.example.com/file' });

    expect(response.redirectCount).toBe(1);
    expect(new TextDecoder().decode(response.body)).toBe('payload');
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://cdn.api.example.com/file', expect.objectContaining({ redirect: 'manual' }));
  });

  it('blocks a redirect to a private address (SSRF via redirect)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(responseOf(302, '', { location: 'https://169.254.169.254/latest/meta-data' }));
    const executor = createQuarantineGatewayExecutor({
      policy: { maxRedirects: 3 },
      fetchImpl,
      resolveHostname: PUBLIC_DNS,
    });

    await expect(executor.execute({ workerId: 'w1', method: 'GET', url: 'https://example.com/x' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces the redirect limit', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValue(responseOf(302, '', { location: 'https://example.com/loop' }));
    const executor = createQuarantineGatewayExecutor({
      policy: { maxRedirects: 1 },
      fetchImpl,
      resolveHostname: PUBLIC_DNS,
    });

    await expect(executor.execute({ workerId: 'w1', method: 'GET', url: 'https://example.com/loop' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('redirect limit') });
  });

  it('caps the response body size', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(responseOf(200, 'x'.repeat(2048)));
    const executor = createQuarantineGatewayExecutor({
      policy: { maxResponseBytes: 1024 },
      fetchImpl,
      resolveHostname: PUBLIC_DNS,
    });

    await expect(executor.execute({ workerId: 'w1', method: 'GET', url: 'https://example.com/big' }))
      .rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining('exceeds limit') });
  });

  it('rejects requests from revoked workers before any fetch', async () => {
    const fetchImpl = vi.fn();
    const executor = createQuarantineGatewayExecutor({
      policy: {},
      fetchImpl,
      resolveHostname: PUBLIC_DNS,
      isRevoked: (workerId) => workerId === 'compromised',
    });

    await expect(executor.execute({ workerId: 'compromised', method: 'GET', url: 'https://example.com/' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('revoked') });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('switches POST to GET on a 303 redirect', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(responseOf(303, '', { location: 'https://api.example.com/done' }))
      .mockResolvedValueOnce(responseOf(200, 'done'));
    const executor = createQuarantineGatewayExecutor({
      policy: { maxRedirects: 1 },
      fetchImpl,
      resolveHostname: PUBLIC_DNS,
    });

    const response = await executor.execute({ workerId: 'w1', method: 'POST', url: 'https://api.example.com/submit', body: 'x=1' });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://api.example.com/done', expect.objectContaining({ method: 'GET', body: undefined }));
  });
});
