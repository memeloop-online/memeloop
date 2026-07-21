import { OrchestrationError } from '../errors.js';

/**
 * ModelAccessHandle: a short-lived opaque credential issued by a trusted
 * CredentialBroker. It authorizes model calls through a ModelGateway without
 * ever handing the worker a provider API key. The handle binds the Run,
 * attempt, worker proof-of-possession key, model, audience, policy digest,
 * budgets, and expiry. Handles must never be written to logs, checkpoints,
 * status, or resource specs.
 */

export interface ModelAccessHandleBudget {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxCost?: number;
  currency?: string;
  maxConcurrent?: number;
}

export interface ModelAccessHandleClaims {
  handleId: string;
  runRef?: {
    apiVersion: string;
    kind: string;
    name: string;
    uid?: string;
  };
  attempt?: number;
  /** Fingerprint of the worker's ephemeral public key (proof-of-possession binding). */
  workerKey?: string;
  modelClassRef: {
    apiVersion: string;
    kind: string;
    name: string;
  };
  modelDigest?: string;
  /** Gateway/endpoint audience this handle is valid for. */
  audience: string;
  /** Digest of the admission/policy snapshot the handle was issued under. */
  policyDigest?: string;
  budget?: ModelAccessHandleBudget;
  issuedAt: string;
  expiresAt: string;
}

export interface ModelAccessHandle {
  /** Opaque token presented to the gateway. */
  token: string;
  claims: ModelAccessHandleClaims;
}

export interface IssueModelAccessHandleRequest {
  handleId?: string;
  runRef?: ModelAccessHandleClaims['runRef'];
  attempt?: number;
  workerKey?: string;
  modelClassRef: ModelAccessHandleClaims['modelClassRef'];
  modelDigest?: string;
  policyDigest?: string;
  budget?: ModelAccessHandleBudget;
  /** Lifetime override in milliseconds; capped by the broker's max TTL. */
  ttlMs?: number;
}

/**
 * Injectable crypto port. Core stays platform-neutral; Node hosts plug in an
 * HMAC/Ed25519 implementation, tests use fakes.
 */
export interface ModelHandleSigner {
  sign(payload: Uint8Array): Promise<Uint8Array>;
  verify(payload: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

export interface ModelAccessHandleBroker {
  issueModelAccessHandle(request: IssueModelAccessHandleRequest): Promise<ModelAccessHandle>;
  verifyModelAccessHandle(token: string, options?: VerifyModelAccessHandleOptions): Promise<ModelAccessHandleClaims>;
  /**
   * Revoke a handle by id (e.g. on Run cancellation or worker compromise).
   * Verification of a revoked handle fails with FORBIDDEN before expiry.
   */
  revokeModelAccessHandle(handleId: string): void;
}

export interface VerifyModelAccessHandleOptions {
  /** Required audience; defaults to the broker's own audience. */
  audience?: string;
  /** Presented worker key fingerprint; must match the claim when the claim exists. */
  workerKey?: string;
  now?: () => Date;
}

const TOKEN_PREFIX = 'mlh1';
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64UrlEncode(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : undefined;
    const c = index + 2 < bytes.length ? bytes[index + 2] : undefined;
    output += BASE64_ALPHABET[a >> 2];
    output += BASE64_ALPHABET[((a & 0b11) << 4) | ((b ?? 0) >> 4)];
    output += b === undefined ? '=' : BASE64_ALPHABET[((b & 0b1111) << 2) | ((c ?? 0) >> 6)];
    output += c === undefined ? '=' : BASE64_ALPHABET[c & 0b11_1111];
  }
  return output.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const bytes: number[] = [];
  for (let index = 0; index < padded.length; index += 4) {
    const a = BASE64_ALPHABET.indexOf(padded[index]);
    const b = BASE64_ALPHABET.indexOf(padded[index + 1]);
    const c = padded[index + 2] === '=' ? -1 : BASE64_ALPHABET.indexOf(padded[index + 2]);
    const d = padded[index + 3] === '=' ? -1 : BASE64_ALPHABET.indexOf(padded[index + 3]);
    if (a < 0 || b < 0) {
      throw new OrchestrationError({ code: 'INVALID', message: 'invalid base64url payload', retryable: false });
    }
    bytes.push((a << 2) | (b >> 4));
    if (c >= 0) bytes.push(((b & 0b1111) << 4) | (c >> 2));
    if (d >= 0 && c >= 0) bytes.push(((c & 0b11) << 6) | d);
  }
  return new Uint8Array(bytes);
}

let handleCounter = 0;

export interface InMemoryModelAccessHandleBrokerOptions {
  signer: ModelHandleSigner;
  /** Gateway audience handles are issued for and verified against. */
  audience: string;
  /** Default TTL when the request does not specify one (default 15min). */
  defaultTtlMs?: number;
  /** Hard cap on any requested TTL (default 60min). */
  maxTtlMs?: number;
  now?: () => Date;
}

/**
 * In-memory reference CredentialBroker for model access. Suitable for tests
 * and single-process hosts; multi-node deployments replace it with a broker
 * backed by the control plane's signing key (see plan 24.34/24.35).
 */
export function createInMemoryModelAccessHandleBroker(
  options: InMemoryModelAccessHandleBrokerOptions,
): ModelAccessHandleBroker {
  const now = options.now ?? (() => new Date());
  const defaultTtl = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  const maxTtl = options.maxTtlMs ?? MAX_TTL_MS;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const revoked = new Set<string>();

  async function issueModelAccessHandle(request: IssueModelAccessHandleRequest): Promise<ModelAccessHandle> {
    if (!request.modelClassRef?.name) {
      throw new OrchestrationError({ code: 'INVALID', message: 'modelClassRef.name is required', retryable: false });
    }
    const issuedAt = now();
    const ttl = Math.min(request.ttlMs ?? defaultTtl, maxTtl);
    if (ttl <= 0) {
      throw new OrchestrationError({ code: 'INVALID', message: 'ttl must be positive', retryable: false });
    }
    handleCounter += 1;
    const claims: ModelAccessHandleClaims = {
      handleId: request.handleId ?? `mlh-${issuedAt.getTime().toString(36)}-${handleCounter.toString(36)}`,
      ...(request.runRef ? { runRef: request.runRef } : {}),
      ...(request.attempt !== undefined ? { attempt: request.attempt } : {}),
      ...(request.workerKey ? { workerKey: request.workerKey } : {}),
      modelClassRef: request.modelClassRef,
      ...(request.modelDigest ? { modelDigest: request.modelDigest } : {}),
      audience: options.audience,
      ...(request.policyDigest ? { policyDigest: request.policyDigest } : {}),
      ...(request.budget ? { budget: request.budget } : {}),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttl).toISOString(),
    };
    const payload = encoder.encode(JSON.stringify(claims));
    const signature = await options.signer.sign(payload);
    const token = `${TOKEN_PREFIX}.${base64UrlEncode(payload)}.${base64UrlEncode(signature)}`;
    return { token, claims };
  }

  async function verifyModelAccessHandle(
    token: string,
    verifyOptions: VerifyModelAccessHandleOptions = {},
  ): Promise<ModelAccessHandleClaims> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
      throw new OrchestrationError({ code: 'INVALID', message: 'malformed model access handle', retryable: false });
    }
    const payload = base64UrlDecode(parts[1]);
    const signature = base64UrlDecode(parts[2]);
    const valid = await options.signer.verify(payload, signature);
    if (!valid) {
      throw new OrchestrationError({ code: 'FORBIDDEN', message: 'model access handle signature invalid', retryable: false });
    }
    let claims: ModelAccessHandleClaims;
    try {
      claims = JSON.parse(decoder.decode(payload)) as ModelAccessHandleClaims;
    } catch {
      throw new OrchestrationError({ code: 'INVALID', message: 'model access handle payload invalid', retryable: false });
    }
    if (revoked.has(claims.handleId)) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'model access handle revoked',
        retryable: false,
        details: { handleId: claims.handleId },
      });
    }
    const expectedAudience = verifyOptions.audience ?? options.audience;
    if (claims.audience !== expectedAudience) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `model access handle audience mismatch: expected '${expectedAudience}'`,
        retryable: false,
      });
    }
    const at = (verifyOptions.now ?? now)();
    if (at.getTime() >= Date.parse(claims.expiresAt)) {
      throw new OrchestrationError({
        code: 'TIMEOUT',
        message: 'model access handle expired',
        retryable: false,
        details: { expiresAt: claims.expiresAt },
      });
    }
    if (claims.workerKey && verifyOptions.workerKey && claims.workerKey !== verifyOptions.workerKey) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'model access handle worker key mismatch',
        retryable: false,
      });
    }
    return claims;
  }

  function revokeModelAccessHandle(handleId: string): void {
    revoked.add(handleId);
  }

  return { issueModelAccessHandle, verifyModelAccessHandle, revokeModelAccessHandle };
}
