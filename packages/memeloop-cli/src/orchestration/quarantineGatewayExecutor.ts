import { lookup } from 'node:dns/promises';

import { createGatewayRateLimiter, type GatewayHttpRequest, type GatewayRateLimiter, OrchestrationError, type QuarantineGatewayPolicy, validateGatewayRequest } from 'memeloop';

/**
 * Quarantine gateway executor (plan 24.40).
 *
 * Mediates outbound HTTP on behalf of quarantine workers. Every hop is
 * validated by the trusted-side policy (method/scheme/port/host/SSRF/body/
 * rate limit/revocation); redirects are followed manually with each target
 * re-validated, and DNS resolution is checked so a hostname cannot rebind to
 * a private address between validation and connect. The worker never sees
 * raw sockets, peer topology, or unvalidated responses.
 */

export interface QuarantineGatewayExecutorOptions {
  policy: QuarantineGatewayPolicy;
  /** Injectable fetch (default: globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /** Injectable DNS resolver (default: node:dns lookup, all addresses). */
  resolveHostname?: (hostname: string) => Promise<string[]>;
  /** Trusted revocation check. */
  isRevoked?: (workerId: string) => boolean;
  /** Shared rate limiter; created per executor when omitted. */
  rateLimiter?: GatewayRateLimiter;
  now?: () => number;
}

export interface GatewayExecuteRequest extends GatewayHttpRequest {
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface GatewayExecuteResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  /** Number of validated redirect hops followed. */
  redirectCount: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

async function readBodyWithCap(response: Response, cap: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        throw new OrchestrationError({
          code: 'INVALID',
          message: `response body exceeds limit ${cap} bytes`,
          retryable: false,
        });
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createQuarantineGatewayExecutor(options: QuarantineGatewayExecutorOptions) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const resolveHostname = options.resolveHostname ?? defaultResolveHostname;
  const rateLimiter = options.rateLimiter ?? createGatewayRateLimiter(options.now ?? (() => Date.now()));
  const maxResponseBytes = options.policy.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRedirects = options.policy.maxRedirects ?? 0;

  async function execute(request: GatewayExecuteRequest): Promise<GatewayExecuteResponse> {
    const context = {
      resolveHostname,
      ...(options.isRevoked ? { isRevoked: options.isRevoked } : {}),
      rateLimiter,
      ...(options.now ? { now: options.now } : {}),
    };

    const bodyBytes = request.bodyBytes ??
      (request.body === undefined ? 0 : typeof request.body === 'string' ? new TextEncoder().encode(request.body).byteLength : request.body.byteLength);
    let currentUrl = request.url;
    let method = request.method.toUpperCase();
    let body: string | Uint8Array | undefined = request.body;
    let redirectCount = 0;

    for (;;) {
      const validation = await validateGatewayRequest({ workerId: request.workerId, method, url: currentUrl, bodyBytes }, options.policy, context);
      if (!validation.ok) {
        throw new OrchestrationError(validation.error);
      }

      const response = await fetchImpl(validation.normalizedUrl, {
        method,
        headers: request.headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : (body as BodyInit | undefined),
        redirect: 'manual',
      });

      if (!REDIRECT_STATUSES.has(response.status)) {
        const responseBody = await readBodyWithCap(response, maxResponseBytes);
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return { status: response.status, headers, body: responseBody, redirectCount };
      }

      redirectCount += 1;
      if (redirectCount > maxRedirects) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: `redirect limit ${maxRedirects} exceeded`,
          retryable: false,
        });
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new OrchestrationError({
          code: 'UNAVAILABLE',
          message: `redirect status ${response.status} without a location header`,
          retryable: false,
        });
      }
      currentUrl = new URL(location, validation.normalizedUrl).toString();
      // 303 switches to GET; 301/302 historically do for non-GET/HEAD.
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
      }
    }
  }

  return { execute };
}
