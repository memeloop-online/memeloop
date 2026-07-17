import { describe, expect, it, vi } from 'vitest';

import { createQuarantineGatewayExecutor } from '../orchestration/quarantineGatewayExecutor.js';

function responseOf(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(new TextEncoder().encode(body), { status, headers });
}

const PUBLIC_DNS = async () => ['93.184.216.34'];

describe('createQuarantineGatewayExecutor', () => {
  it('validates then connects to the resolved address', async () => {
    const execute = vi.fn().mockResolvedValue(responseOf(200, 'ok'));
    const executor = createQuarantineGatewayExecutor({
      policy: { allowedHosts: ['api.example.com'] },
      transport: { execute },
      resolveHostname: PUBLIC_DNS,
    });

    const response = await executor.execute({ workerId: 'w1', method: 'GET', url: 'https://api.example.com/v1' });

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe('ok');
    expect(response.redirectCount).toBe(0);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.example.com/v1',
      address: '93.184.216.34',
      method: 'GET',
    }));
  });

  it('never calls transport for a rejected request', async () => {
    const execute = vi.fn();
    const executor = createQuarantineGatewayExecutor({
      policy: {},
      transport: { execute },
      resolveHostname: PUBLIC_DNS,
    });

    await expect(executor.execute({ workerId: 'w1', method: 'GET', url: 'https://169.254.169.254/latest' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('follows redirects only within policy and revalidates each hop', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(responseOf(302, '', { location: 'https://cdn.api.example.com/file' }))
      .mockResolvedValueOnce(responseOf(200, 'payload'));
    const executor = createQuarantineGatewayExecutor({
      policy: { allowedHosts: ['api.example.com'], maxRedirects: 2 },
      transport: { execute },
      resolveHostname: PUBLIC_DNS,
    });

    const response = await executor.execute({ workerId: 'w1', method: 'GET', url: 'https://api.example.com/file' });

    expect(response.redirectCount).toBe(1);
    expect(new TextDecoder().decode(response.body)).toBe('payload');
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: 'https://cdn.api.example.com/file',
        address: '93.184.216.34',
      }),
    );
  });

  it('blocks a redirect to a private address (SSRF via redirect)', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(responseOf(302, '', { location: 'https://169.254.169.254/latest/meta-data' }));
    const executor = createQuarantineGatewayExecutor({
      policy: { maxRedirects: 3 },
      transport: { execute },
      resolveHostname: PUBLIC_DNS,
    });

    await expect(executor.execute({ workerId: 'w1', method: 'GET', url: 'https://example.com/x' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('enforces the redirect limit', async () => {
    const execute = vi.fn()
      .mockResolvedValue(responseOf(302, '', { location: 'https://example.com/loop' }));
    const executor = createQuarantineGatewayExecutor({
      policy: { maxRedirects: 1 },
      transport: { execute },
      resolveHostname: PUBLIC_DNS,
    });

    await expect(executor.execute({ workerId: 'w1', method: 'GET', url: 'https://example.com/loop' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('redirect limit') });
  });

  it('caps the response body size', async () => {
    const execute = vi.fn().mockResolvedValue(responseOf(200, 'x'.repeat(2048)));
    const executor = createQuarantineGatewayExecutor({
      policy: { maxResponseBytes: 1024 },
      transport: { execute },
      resolveHostname: PUBLIC_DNS,
    });

    await expect(executor.execute({ workerId: 'w1', method: 'GET', url: 'https://example.com/big' }))
      .rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining('exceeds limit') });
  });

  it('rejects requests from revoked workers before any transport call', async () => {
    const execute = vi.fn();
    const executor = createQuarantineGatewayExecutor({
      policy: {},
      transport: { execute },
      resolveHostname: PUBLIC_DNS,
      isRevoked: (workerId) => workerId === 'compromised',
    });

    await expect(executor.execute({ workerId: 'compromised', method: 'GET', url: 'https://example.com/' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('revoked') });
    expect(execute).not.toHaveBeenCalled();
  });

  it('switches POST to GET on a 303 redirect', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(responseOf(303, '', { location: 'https://api.example.com/done' }))
      .mockResolvedValueOnce(responseOf(200, 'done'));
    const executor = createQuarantineGatewayExecutor({
      policy: { maxRedirects: 1 },
      transport: { execute },
      resolveHostname: PUBLIC_DNS,
    });

    const response = await executor.execute({ workerId: 'w1', method: 'POST', url: 'https://api.example.com/submit', body: 'x=1' });

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: 'https://api.example.com/done',
        method: 'GET',
        body: undefined,
      }),
    );
  });

  it('ignores a worker-supplied body length and checks the actual bytes', async () => {
    const execute = vi.fn();
    const executor = createQuarantineGatewayExecutor({
      policy: { maxBodyBytes: 3 },
      transport: { execute },
      resolveHostname: PUBLIC_DNS,
    });

    await expect(executor.execute({
      workerId: 'w1',
      method: 'POST',
      url: 'https://api.example.com/submit',
      body: 'too large',
      bodyBytes: 1,
    })).rejects.toMatchObject({ code: 'INVALID' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('strips credentials when a redirect crosses origins', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(responseOf(302, '', { location: 'https://cdn.example.net/file' }))
      .mockResolvedValueOnce(responseOf(200, 'ok'));
    const executor = createQuarantineGatewayExecutor({
      policy: { allowedHosts: ['example.com', 'example.net'], maxRedirects: 1 },
      transport: { execute },
      resolveHostname: PUBLIC_DNS,
    });

    await executor.execute({
      workerId: 'w1',
      method: 'GET',
      url: 'https://api.example.com/file',
      headers: { Authorization: 'Bearer secret', Cookie: 'sid=secret', Accept: 'application/json' },
    });

    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        headers: { Accept: 'application/json' },
      }),
    );
  });
});
