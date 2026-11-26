import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

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
  /** Injectable transport that must connect to the supplied validated address. */
  transport?: GatewayPinnedTransport;
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

export interface GatewayPinnedRequest {
  url: string;
  address: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

export interface GatewayPinnedTransport {
  execute(request: GatewayPinnedRequest): Promise<Response>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

function defaultPinnedTransport(): GatewayPinnedTransport {
  return {
    execute(request) {
      const url = new URL(request.url);
      return new Promise<Response>((resolve, reject) => {
        const secure = url.protocol === 'https:';
        const send = secure ? httpsRequest : httpRequest;
        const outgoing = send({
          hostname: request.address,
          port: url.port ? Number(url.port) : (secure ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers: { ...request.headers, host: url.host },
          ...(secure ? { servername: url.hostname } : {}),
        }, (incoming) => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              incoming.on('data', (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
              });
              incoming.on('end', () => {
                controller.close();
              });
              incoming.on('error', (error) => {
                controller.error(error);
              });
            },
            cancel() {
              incoming.destroy();
            },
          });
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) headers.append(name, item);
            } else if (value !== undefined) {
              headers.set(name, value);
            }
          }
          resolve(new Response(stream, { status: incoming.statusCode ?? 502, headers }));
        });
        outgoing.on('error', reject);
        if (request.body !== undefined) outgoing.write(request.body);
        outgoing.end();
      });
    },
  };
}

const SENSITIVE_REDIRECT_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

function stripCrossOriginHeaders(headers: Record<string, string>, from: string, to: string): Record<string, string> {
  if (new URL(from).origin === new URL(to).origin) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !SENSITIVE_REDIRECT_HEADERS.has(name.toLowerCase())));
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
  const transport = options.transport ?? defaultPinnedTransport();
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

    let currentUrl = request.url;
    let method = request.method.toUpperCase();
    let body: string | Uint8Array | undefined = request.body;
    let headers = { ...(request.headers ?? {}) };
    let redirectCount = 0;

    for (;;) {
      const bodyBytes = body === undefined ? 0 : typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength;
      const validation = await validateGatewayRequest({ workerId: request.workerId, method, url: currentUrl, bodyBytes }, options.policy, context);
      if (!validation.ok) {
        throw new OrchestrationError(validation.error);
      }

      const address = validation.addresses[0];
      if (!address) {
        throw new OrchestrationError({ code: 'UNAVAILABLE', message: `no validated address for '${validation.hostname}'`, retryable: true });
      }
      const response = await transport.execute({
        url: validation.normalizedUrl,
        address,
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
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
      const nextUrl = new URL(location, validation.normalizedUrl).toString();
      headers = stripCrossOriginHeaders(headers, validation.normalizedUrl, nextUrl);
      currentUrl = nextUrl;
      // 303 switches to GET; 301/302 historically do for non-GET/HEAD.
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
      }
    }
  }

  return { execute };
}
