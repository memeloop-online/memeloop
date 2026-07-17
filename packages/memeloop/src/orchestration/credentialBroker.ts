import { OrchestrationError } from './errors.js';
import { base64UrlDecode, base64UrlEncode, type ModelHandleSigner } from './modelAccessHandle.js';

/**
 * CredentialGrant broker contract (plan 24.46).
 *
 * Generalizes the ModelAccessHandle pattern to arbitrary scoped credentials
 * (tool operations, SSH, cloud APIs, model access). Every grant is bound to
 * Run/attempt/worker key/target/method/audience/policy digest/expiry, and the
 * broker records exposure and post-task rotation requirements. Grants resolve
 * to opaque handles; raw secret material never appears here — the broker only
 * signs and verifies scoped claims.
 */

export interface CredentialGrantScope {
  runRef?: {
    apiVersion: string;
    kind: string;
    name: string;
    uid?: string;
  };
  attempt?: number;
  /** Fingerprint of the worker's ephemeral public key (proof-of-possession binding). */
  workerKey?: string;
  target: string;
  method: string;
  audience: string;
  policyDigest?: string;
}

export interface CredentialGrantClaims extends CredentialGrantScope {
  grantId: string;
  issuedAt: string;
  expiresAt: string;
  renewedAt?: string;
}

export interface CredentialGrantHandle {
  /** Opaque token presented to the target driver. */
  token: string;
  claims: CredentialGrantClaims;
}

export interface CredentialGrantInspection {
  grantId: string;
  scope: CredentialGrantScope;
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
  expired: boolean;
  /** Exposure assessment used to decide post-task rotation. */
  exposure: 'none' | 'worker-visible' | 'potentially-exposed';
  rotationRequired: boolean;
  rotationReason?: string;
}

export interface IssueCredentialGrantRequest extends CredentialGrantScope {
  grantId?: string;
  ttlMs?: number;
}

export interface CredentialBrokerDriver {
  issue(request: IssueCredentialGrantRequest): Promise<CredentialGrantHandle>;
  /** Renew an unexpired, unrevoked grant; returns a new token with a fresh expiry. */
  renew(token: string, options?: { ttlMs?: number; now?: () => Date }): Promise<CredentialGrantHandle>;
  revoke(grantId: string): void;
  inspect(token: string): Promise<CredentialGrantInspection>;
  /** Verify a presented token for a required target/method/audience. */
  verify(token: string, requirements: { target: string; method: string; audience?: string; workerKey?: string }): Promise<CredentialGrantClaims>;
}

const TOKEN_PREFIX = 'mlcg1';
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;

export interface InMemoryCredentialBrokerOptions {
  signer: ModelHandleSigner;
  /** Broker audience used when verifying without an explicit override. */
  audience?: string;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  now?: () => Date;
}

let grantCounter = 0;

export function createInMemoryCredentialBroker(options: InMemoryCredentialBrokerOptions): CredentialBrokerDriver {
  const now = options.now ?? (() => new Date());
  const defaultTtl = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  const maxTtl = options.maxTtlMs ?? MAX_TTL_MS;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const revoked = new Set<string>();
  /** Grants issued to workers are worker-visible and need rotation after the task. */
  const workerVisible = new Set<string>();

  function assertScope(request: CredentialGrantScope): void {
    if (!request.target) {
      throw new OrchestrationError({ code: 'INVALID', message: 'credential grant target is required', retryable: false });
    }
    if (!request.method) {
      throw new OrchestrationError({ code: 'INVALID', message: 'credential grant method is required', retryable: false });
    }
    if (!request.audience) {
      throw new OrchestrationError({ code: 'INVALID', message: 'credential grant audience is required', retryable: false });
    }
  }

  async function sign(claims: CredentialGrantClaims): Promise<CredentialGrantHandle> {
    const payload = encoder.encode(JSON.stringify(claims));
    const signature = await options.signer.sign(payload);
    return { token: `${TOKEN_PREFIX}.${base64UrlEncode(payload)}.${base64UrlEncode(signature)}`, claims };
  }

  async function parseAndVerify(token: string): Promise<CredentialGrantClaims> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
      throw new OrchestrationError({ code: 'INVALID', message: 'malformed credential grant', retryable: false });
    }
    const payload = base64UrlDecode(parts[1]);
    const signature = base64UrlDecode(parts[2]);
    if (!(await options.signer.verify(payload, signature))) {
      throw new OrchestrationError({ code: 'FORBIDDEN', message: 'credential grant signature invalid', retryable: false });
    }
    let claims: CredentialGrantClaims;
    try {
      claims = JSON.parse(decoder.decode(payload)) as CredentialGrantClaims;
    } catch {
      throw new OrchestrationError({ code: 'INVALID', message: 'credential grant payload invalid', retryable: false });
    }
    return claims;
  }

  function assertUsable(claims: CredentialGrantClaims, at: Date): void {
    if (revoked.has(claims.grantId)) {
      throw new OrchestrationError({ code: 'FORBIDDEN', message: 'credential grant revoked', retryable: false, details: { grantId: claims.grantId } });
    }
    if (at.getTime() >= Date.parse(claims.expiresAt)) {
      throw new OrchestrationError({ code: 'TIMEOUT', message: 'credential grant expired', retryable: false, details: { expiresAt: claims.expiresAt } });
    }
  }

  return {
    async issue(request) {
      assertScope(request);
      const issuedAt = now();
      const ttl = Math.min(request.ttlMs ?? defaultTtl, maxTtl);
      if (ttl <= 0) {
        throw new OrchestrationError({ code: 'INVALID', message: 'credential grant ttl must be positive', retryable: false });
      }
      grantCounter += 1;
      const claims: CredentialGrantClaims = {
        grantId: request.grantId ?? `mlcg-${issuedAt.getTime().toString(36)}-${grantCounter.toString(36)}`,
        ...(request.runRef ? { runRef: request.runRef } : {}),
        ...(request.attempt !== undefined ? { attempt: request.attempt } : {}),
        ...(request.workerKey ? { workerKey: request.workerKey } : {}),
        target: request.target,
        method: request.method,
        audience: request.audience,
        ...(request.policyDigest ? { policyDigest: request.policyDigest } : {}),
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + ttl).toISOString(),
      };
      if (request.workerKey) workerVisible.add(claims.grantId);
      return sign(claims);
    },

    async renew(token, renewOptions = {}) {
      const claims = await parseAndVerify(token);
      assertUsable(claims, renewOptions.now?.() ?? now());
      const renewedAt = renewOptions.now?.() ?? now();
      const ttl = Math.min(renewOptions.ttlMs ?? defaultTtl, maxTtl);
      return sign({
        ...claims,
        renewedAt: renewedAt.toISOString(),
        expiresAt: new Date(renewedAt.getTime() + ttl).toISOString(),
      });
    },

    revoke(grantId) {
      revoked.add(grantId);
    },

    async inspect(token) {
      const claims = await parseAndVerify(token);
      const expired = now().getTime() >= Date.parse(claims.expiresAt);
      const isRevoked = revoked.has(claims.grantId);
      const exposure = workerVisible.has(claims.grantId) ? 'worker-visible' : 'none';
      return {
        grantId: claims.grantId,
        scope: {
          ...(claims.runRef ? { runRef: claims.runRef } : {}),
          ...(claims.attempt !== undefined ? { attempt: claims.attempt } : {}),
          ...(claims.workerKey ? { workerKey: claims.workerKey } : {}),
          target: claims.target,
          method: claims.method,
          audience: claims.audience,
          ...(claims.policyDigest ? { policyDigest: claims.policyDigest } : {}),
        },
        issuedAt: claims.issuedAt,
        expiresAt: claims.expiresAt,
        revoked: isRevoked,
        expired,
        exposure,
        rotationRequired: exposure !== 'none' || isRevoked,
        ...(exposure !== 'none' ? { rotationReason: 'grant was visible to a worker; rotate the underlying credential after the task' } : {}),
      };
    },

    async verify(token, requirements) {
      const claims = await parseAndVerify(token);
      assertUsable(claims, now());
      if (claims.target !== requirements.target) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: `credential grant target mismatch: expected '${requirements.target}'`,
          retryable: false,
        });
      }
      if (claims.method !== requirements.method) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: `credential grant method mismatch: expected '${requirements.method}'`,
          retryable: false,
        });
      }
      const audience = requirements.audience ?? options.audience;
      if (audience && claims.audience !== audience) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: `credential grant audience mismatch: expected '${audience}'`,
          retryable: false,
        });
      }
      if (claims.workerKey && requirements.workerKey && claims.workerKey !== requirements.workerKey) {
        throw new OrchestrationError({ code: 'FORBIDDEN', message: 'credential grant worker key mismatch', retryable: false });
      }
      return claims;
    },
  };
}
