import { describe, expect, it } from 'vitest';

import {
  createGatewayRateLimiter,
  createWorkerRevocationList,
  type GatewayHttpRequest,
  isPrivateIp,
  type QuarantineGatewayPolicy,
  validateGatewayRequest,
  validateRedirectTarget,
} from '../quarantineGateway.js';

const POLICY: QuarantineGatewayPolicy = {
  allowedHosts: ['api.example.com', 'safe-mirror.example.org'],
  methodLimits: { POST: { maxBodyBytes: 4096, requestsPerMinute: 5 } },
};

function request(overrides: Partial<GatewayHttpRequest> = {}): GatewayHttpRequest {
  return { workerId: 'worker-1', method: 'GET', url: 'https://api.example.com/v1/assets', ...overrides };
}

describe('isPrivateIp', () => {
  it('flags loopback, private, link-local, CGNAT, and multicast IPv4', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.0.1', '100.64.0.1', '224.0.0.1', '0.0.0.1']) {
      expect(isPrivateIp(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '1.1.1.1']) {
      expect(isPrivateIp(address), address).toBe(false);
    }
  });

  it('flags IPv6 loopback, link-local, ULA, and IPv4-mapped private', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12::1')).toBe(true);
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('validateGatewayRequest', () => {
  it('rejects revoked workers before any other check', async () => {
    const revocation = createWorkerRevocationList();
    revocation.revoke('worker-1');
    const result = await validateGatewayRequest(
      request({ method: 'BREW', url: 'not a url' }),
      POLICY,
      { isRevoked: revocation.isRevoked },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect((result as { error: { message: string } }).error.message).toContain('revoked');
  });

  it('rejects disallowed methods, schemes, ports, and hosts', async () => {
    expect(await validateGatewayRequest(request({ method: 'DELETE' }), POLICY))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await validateGatewayRequest(request({ url: 'http://api.example.com/x' }), POLICY))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await validateGatewayRequest(request({ url: 'https://api.example.com:8443/x' }), POLICY))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(await validateGatewayRequest(request({ url: 'https://evil.example.net/x' }), POLICY))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('allows suffix-matched subdomains of allowlisted hosts', async () => {
    const result = await validateGatewayRequest(request({ url: 'https://v2.api.example.com/x' }), POLICY);
    expect(result.ok).toBe(true);
  });

  it('blocks literal private targets as SSRF', async () => {
    const policy: QuarantineGatewayPolicy = {};
    for (
      const url of [
        'https://127.0.0.1/x',
        'https://10.0.0.5/x',
        'https://192.168.0.1/x',
        'https://169.254.169.254/latest/meta-data',
        'https://[::1]/x',
        'https://[::ffff:10.0.0.1]/x',
      ]
    ) {
      const result = await validateGatewayRequest(request({ url }), policy);
      expect(result, url).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
  });

  it('blocks hostnames that resolve to private addresses', async () => {
    const result = await validateGatewayRequest(
      request({ url: 'https://internal.example.com/x' }),
      {},
      { resolveHostname: async () => ['10.1.2.3'] },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });

    const rebinding = await validateGatewayRequest(
      request({ url: 'https://rebind.example.com/x' }),
      {},
      { resolveHostname: async () => ['8.8.8.8', '127.0.0.1'] },
    );
    expect(rebinding.ok).toBe(false);
  });

  it('enforces per-method body limits before rate limits', async () => {
    const result = await validateGatewayRequest(request({ method: 'POST', bodyBytes: 4097 }), POLICY);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    const withinLimit = await validateGatewayRequest(request({ method: 'POST', bodyBytes: 4096 }), POLICY);
    expect(withinLimit.ok).toBe(true);
  });

  it('rate limits per worker and method with token-bucket refill', async () => {
    let now = 1_000_000;
    const limiter = createGatewayRateLimiter(() => now);
    const context = { rateLimiter: limiter };

    for (let index = 0; index < 5; index += 1) {
      const result = await validateGatewayRequest(request({ method: 'POST' }), POLICY, context);
      expect(result.ok, `request ${index + 1}`).toBe(true);
    }
    const limited = await validateGatewayRequest(request({ method: 'POST' }), POLICY, context);
    expect(limited).toMatchObject({ ok: false, error: { code: 'EXHAUSTED' } });

    // A different worker is not limited by worker-1's bucket.
    const otherWorker = await validateGatewayRequest(request({ method: 'POST', workerId: 'worker-2' }), POLICY, context);
    expect(otherWorker.ok).toBe(true);

    // After a minute the bucket refills.
    now += 60_001;
    const refilled = await validateGatewayRequest(request({ method: 'POST' }), POLICY, context);
    expect(refilled.ok).toBe(true);
  });

  it('honors allowPrivateNetworks for explicitly trusted policies', async () => {
    const result = await validateGatewayRequest(
      request({ url: 'https://10.0.0.5/x' }),
      { allowPrivateNetworks: true },
    );
    expect(result.ok).toBe(true);
  });
});

describe('validateRedirectTarget', () => {
  it('revalidates redirect targets with the same policy', async () => {
    const ok = await validateRedirectTarget(
      { workerId: 'worker-1' },
      'https://cdn.api.example.com/x',
      POLICY,
    );
    expect(ok.ok).toBe(true);

    const ssrf = await validateRedirectTarget(
      { workerId: 'worker-1' },
      'https://169.254.169.254/latest/meta-data',
      POLICY,
    );
    expect(ssrf.ok).toBe(false);
  });
});
