import type { OrchestrationErrorData } from '../errors.js';

/**
 * Quarantine gateway request mediation (plan 24.40).
 *
 * All checks run on the trusted gateway side, outside worker control. The
 * gateway is the worker's only network endpoint — it never receives ordinary
 * peer topology, sync, or device-directory access through this channel. Every
 * outbound request is validated for method, scheme, port, host allowlist,
 * SSRF (literal and DNS-resolved private addresses), redirect targets, body
 * size, per-method limits, and per-worker rate limits; revoked workers are
 * rejected before any validation.
 */

export interface QuarantineGatewayPolicy {
  /** Allowed HTTP methods (default GET/HEAD/POST). */
  allowedMethods?: string[];
  /** Allowed URL schemes (default ['https']). */
  allowedSchemes?: string[];
  /** Allowed ports (default [443]). */
  allowedPorts?: number[];
  /** Hostname suffix allowlist; when set, only matching hosts pass. */
  allowedHosts?: string[];
  /** Allow private/loopback/link-local targets (default false — SSRF blocked). */
  allowPrivateNetworks?: boolean;
  /** Maximum followed redirects, each re-validated (default 0). */
  maxRedirects?: number;
  /** Global request body cap in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  /** Per-method overrides. */
  methodLimits?: Record<string, {
    maxBodyBytes?: number;
    requestsPerMinute?: number;
  }>;
  /** Default per-worker+method rate limit (default 60/minute). */
  defaultRateLimitPerMinute?: number;
  /** Response body cap in bytes for the executor (default 8 MiB). */
  maxResponseBytes?: number;
}

export interface GatewayHttpRequest {
  workerId: string;
  method: string;
  url: string;
  /** Declared request body size in bytes (0/undefined for bodyless). */
  bodyBytes?: number;
}

export interface GatewayValidationContext {
  /** Injected DNS resolver returning IP literals for a hostname. */
  resolveHostname?: (hostname: string) => Promise<string[]>;
  /** Trusted revocation check for worker sessions. */
  isRevoked?: (workerId: string) => boolean;
  /** Rate limiter state; one shared limiter per gateway. */
  rateLimiter?: GatewayRateLimiter;
  now?: () => number;
}

export type GatewayValidationResult =
  | { ok: true; normalizedUrl: string; hostname: string; addresses: string[] }
  | { ok: false; error: OrchestrationErrorData };

function denied(code: OrchestrationErrorData['code'], message: string, details?: Record<string, unknown>): GatewayValidationResult {
  return { ok: false, error: { code, message, retryable: code === 'EXHAUSTED' || code === 'UNAVAILABLE', ...(details ? { details } : {}) } };
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True when the IP literal is loopback, private, link-local, or otherwise non-public. */
export function isPrivateIp(address: string): boolean {
  const v4 = IPV4_PATTERN.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a > 255 || b > 255) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast/reserved/broadcast
    return false;
  }
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('::ffff:')) {
    // IPv4-mapped IPv6; URL parsers may normalize the dotted quad to hex.
    const rest = normalized.slice('::ffff:'.length);
    if (IPV4_PATTERN.test(rest)) return isPrivateIp(rest);
    const groups = rest.split(':');
    if (groups.length === 2) {
      const hi = Number.parseInt(groups[0], 16);
      const lo = Number.parseInt(groups[1], 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        return isPrivateIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
      }
    }
    // Unparseable mapped form — fail closed.
    return true;
  }
  return false;
}

function isIpLiteral(hostname: string): boolean {
  return IPV4_PATTERN.test(hostname) || hostname.includes(':');
}

function hostMatchesAllowlist(hostname: string, allowlist: string[]): boolean {
  const lower = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const suffix = entry.toLowerCase();
    return lower === suffix || lower.endsWith(`.${suffix}`);
  });
}

export interface GatewayRateLimiter {
  /** True when the request is within budget; false when limited. */
  consume(key: string, perMinute: number): boolean;
}

/** Token-bucket rate limiter with an injectable clock (trusted-side state). */
export function createGatewayRateLimiter(now: () => number = () => Date.now()): GatewayRateLimiter {
  const buckets = new Map<string, { tokens: number; refilledAt: number }>();
  return {
    consume(key, perMinute) {
      if (perMinute <= 0) return false;
      const at = now();
      const bucket = buckets.get(key) ?? { tokens: perMinute, refilledAt: at };
      const elapsedMinutes = Math.max(0, (at - bucket.refilledAt) / 60_000);
      const tokens = Math.min(perMinute, bucket.tokens + elapsedMinutes * perMinute);
      if (tokens < 1) {
        buckets.set(key, { tokens, refilledAt: at });
        return false;
      }
      buckets.set(key, { tokens: tokens - 1, refilledAt: at });
      return true;
    },
  };
}

/** Revocation list for quarantine worker sessions (trusted-side state). */
export function createWorkerRevocationList(): { revoke(workerId: string): void; isRevoked(workerId: string): boolean } {
  const revoked = new Set<string>();
  return {
    revoke(workerId) {
      revoked.add(workerId);
    },
    isRevoked(workerId) {
      return revoked.has(workerId);
    },
  };
}

const DEFAULT_METHODS = ['GET', 'HEAD', 'POST'];
const DEFAULT_SCHEMES = ['https'];
const DEFAULT_PORTS = [443];
const DEFAULT_MAX_BODY = 1024 * 1024;
const DEFAULT_RATE_PER_MINUTE = 60;

/**
 * Validate one gateway request. Order matters: revocation first, then cheap
 * syntactic checks, then SSRF (literal before DNS), then rate limits, so a
 * revoked or malformed request never costs a DNS lookup.
 */
export async function validateGatewayRequest(
  request: GatewayHttpRequest,
  policy: QuarantineGatewayPolicy,
  context: GatewayValidationContext = {},
): Promise<GatewayValidationResult> {
  if (context.isRevoked?.(request.workerId)) {
    return denied('FORBIDDEN', `worker '${request.workerId}' is revoked`);
  }

  const method = request.method.toUpperCase();
  const allowedMethods = policy.allowedMethods ?? DEFAULT_METHODS;
  if (!allowedMethods.includes(method)) {
    return denied('FORBIDDEN', `method '${method}' is not allowed`, { allowedMethods });
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return denied('INVALID', `url '${request.url}' cannot be parsed`);
  }

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const allowedSchemes = policy.allowedSchemes ?? DEFAULT_SCHEMES;
  if (!allowedSchemes.includes(scheme)) {
    return denied('FORBIDDEN', `scheme '${scheme}' is not allowed`, { allowedSchemes });
  }

  const port = url.port ? Number(url.port) : (scheme === 'https' ? 443 : 80);
  const allowedPorts = policy.allowedPorts ?? DEFAULT_PORTS;
  if (!allowedPorts.includes(port)) {
    return denied('FORBIDDEN', `port ${port} is not allowed`, { allowedPorts });
  }

  const hostname = url.hostname.toLowerCase();
  if (policy.allowedHosts && !hostMatchesAllowlist(hostname, policy.allowedHosts)) {
    return denied('FORBIDDEN', `host '${hostname}' is not in the allowlist`);
  }

  let addresses: string[] = [];
  if (isIpLiteral(hostname)) {
    addresses = [hostname.replace(/^\[|\]$/g, '')];
    if (!policy.allowPrivateNetworks && isPrivateIp(hostname)) {
      return denied('FORBIDDEN', `target '${hostname}' is a private or non-public address`);
    }
  } else if (context.resolveHostname) {
    try {
      addresses = await context.resolveHostname(hostname);
    } catch {
      return denied('UNAVAILABLE', `hostname '${hostname}' could not be resolved`);
    }
    if (addresses.length === 0) {
      return denied('UNAVAILABLE', `hostname '${hostname}' resolved to no addresses`);
    }
    if (!policy.allowPrivateNetworks) {
      const privateAddress = addresses.find((address) => isPrivateIp(address));
      if (privateAddress) {
        return denied('FORBIDDEN', `hostname '${hostname}' resolves to private address ${privateAddress}`);
      }
    }
  }

  const methodLimit = policy.methodLimits?.[method];
  const maxBody = methodLimit?.maxBodyBytes ?? policy.maxBodyBytes ?? DEFAULT_MAX_BODY;
  if ((request.bodyBytes ?? 0) > maxBody) {
    return denied('INVALID', `request body ${request.bodyBytes} bytes exceeds limit ${maxBody}`, { maxBodyBytes: maxBody });
  }

  const perMinute = methodLimit?.requestsPerMinute ?? policy.defaultRateLimitPerMinute ?? DEFAULT_RATE_PER_MINUTE;
  const limiter = context.rateLimiter;
  if (limiter && !limiter.consume(`${request.workerId}:${method}`, perMinute)) {
    return denied('EXHAUSTED', `rate limit exceeded for worker '${request.workerId}' method '${method}'`, { requestsPerMinute: perMinute });
  }

  return { ok: true, normalizedUrl: url.toString(), hostname, addresses };
}

/** Validate a redirect target with the same policy; redirect chains are bounded by the caller. */
export async function validateRedirectTarget(
  request: Omit<GatewayHttpRequest, 'method' | 'bodyBytes'> & { method?: string },
  location: string,
  policy: QuarantineGatewayPolicy,
  context: GatewayValidationContext = {},
): Promise<GatewayValidationResult> {
  return validateGatewayRequest(
    { workerId: request.workerId, method: request.method ?? 'GET', url: location, bodyBytes: 0 },
    policy,
    context,
  );
}
