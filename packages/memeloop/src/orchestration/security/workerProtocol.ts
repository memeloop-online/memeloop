import { canonicalJsonBytes } from '../../encoding/canonicalJson.js';
import { LOOP_CHECKPOINT_API_VERSION, LOOP_CHECKPOINT_SCHEMA_VERSION } from '../../loopAPI/types.js';
import { OrchestrationError, type OrchestrationErrorData } from '../errors.js';

/**
 * Dedicated outbound worker protocol (plan §13).
 *
 * This protocol is deliberately smaller than ResourceClient. A worker can
 * interact only with its own assignment/run through method-specific gateway
 * handlers; it cannot list/watch control state, acquire leases, discover
 * peers, or mutate Node/verification/promotion resources.
 */

export const WORKER_PROTOCOL_VERSION = 'worker.memeloop.io/v1alpha1';

export const WORKER_PROTOCOL_METHODS = [
  'assignment.pull',
  'assignment.ack',
  'session.heartbeat',
  'event.submit',
  'capability.request',
  'artifact.upload',
  'checkpoint.load',
  'checkpoint.save',
  'operation.complete',
  'operation.fail',
  'operation.cancel',
] as const;

export type WorkerProtocolMethod = (typeof WORKER_PROTOCOL_METHODS)[number];

export const WORKER_CHECKPOINT_LIMITS = Object.freeze(
  {
    identifierBytes: 512,
    valueBytes: 512 * 1024,
    valueDepth: 32,
    valueNodes: 50_000,
  } as const,
);

export const WORKER_CHECKPOINT_API_VERSION = LOOP_CHECKPOINT_API_VERSION;
export const WORKER_CHECKPOINT_SCHEMA_VERSION = LOOP_CHECKPOINT_SCHEMA_VERSION;

export interface WorkerCheckpointScope {
  scriptDigest: string;
  apiVersion: string;
  schemaVersion: string;
  runId: string;
}

export interface WorkerCheckpointLoadPayload {
  conversationId: string;
  key: string;
  scope: WorkerCheckpointScope;
}

export interface WorkerCheckpointSavePayload extends WorkerCheckpointLoadPayload {
  value: unknown;
  expectedRevision: number;
  fencingEpoch: number;
}

export type WorkerCheckpointLoadResponse =
  | { found: false; nextExpectedRevision: 0; fencingEpoch: number; scope: WorkerCheckpointScope }
  | { found: true; value: unknown; revision: number; fencingEpoch: number; scope: WorkerCheckpointScope };

export interface WorkerCheckpointSaveResponse {
  saved: true;
  revision: number;
  fencingEpoch: number;
}

export interface WorkerRunBinding {
  uid: string;
  attempt: number;
  epoch: number;
}

export interface WorkerProtocolRequest {
  apiVersion: typeof WORKER_PROTOCOL_VERSION;
  requestId: string;
  sessionName: string;
  sequence: number;
  nonce: string;
  deadline: string;
  audience: string;
  run: WorkerRunBinding;
  method: WorkerProtocolMethod;
  target: string;
  policyDigest: string;
  payload: unknown;
  /** Signature over canonicalWorkerProtocolRequestBytes(request). */
  signature: string;
}

export type WorkerProtocolResponse =
  | {
    apiVersion: typeof WORKER_PROTOCOL_VERSION;
    requestId: string;
    ok: true;
    payload: unknown;
    receivedAt: string;
  }
  | {
    apiVersion: typeof WORKER_PROTOCOL_VERSION;
    requestId: string;
    ok: false;
    error: OrchestrationErrorData;
    receivedAt: string;
  };

export interface WorkerBootstrapSessionDescriptor {
  apiVersion: typeof WORKER_PROTOCOL_VERSION;
  sessionName: string;
  audience: string;
  expiresAt: string;
  run: WorkerRunBinding;
  policyDigest: string;
  allowedMethods: WorkerProtocolMethod[];
  allowedTargets?: string[];
  workerKeyFingerprint: string;
  gatewayKeyFingerprint: string;
  issuedAt: string;
}

export interface SignedWorkerBootstrapSessionDescriptor extends WorkerBootstrapSessionDescriptor {
  /** Gateway signature over canonicalWorkerBootstrapDescriptorBytes(...). */
  gatewaySignature: string;
}

export interface WorkerGatewaySession {
  name: string;
  workerKeyFingerprint: string;
  workerPublicKey: string;
  audience: string;
  protocol: typeof WORKER_PROTOCOL_VERSION;
  expiresAt: string;
  revoked: boolean;
  run: WorkerRunBinding;
  policyDigest: string;
  allowedMethods: WorkerProtocolMethod[];
  allowedTargets?: string[];
  /** Trusted host signal raised when the durable session is revoked. */
  revocationSignal?: AbortSignal;
}

export interface WorkerProtocolReplayProtector {
  /**
   * Atomically accept exactly the next sequence and a fresh nonce.
   * Production implementations must persist this state; returning false
   * fails closed on replay, gaps, or uncertain state.
   */
  consume(sessionName: string, sequence: number, nonce: string): Promise<boolean>;
}

export interface WorkerProtocolGatewayOptions {
  resolveSession: (sessionName: string) => Promise<WorkerGatewaySession | undefined>;
  /**
   * Optional durable revocation probe.  The gateway polls only while one
   * request is executing, so a cancelled/finished request never leaves a
   * watcher or timer behind.
   */
  isSessionRevoked?: (sessionName: string) => Promise<boolean> | boolean;
  sessionRevocationPollMs?: number;
  replayProtector: WorkerProtocolReplayProtector;
  verifySignature: (request: {
    session: WorkerGatewaySession;
    message: Uint8Array;
    signature: string;
  }) => Promise<boolean>;
  dispatch: (request: {
    requestId: string;
    session: WorkerGatewaySession;
    method: WorkerProtocolMethod;
    target: string;
    payload: unknown;
    signal: AbortSignal;
  }) => Promise<unknown>;
  now?: () => Date;
  maxClockSkewMs?: number;
  /**
   * Process-local, fixed-window protection. Counts intentionally reset when
   * this gateway instance restarts; durable replay protection still prevents
   * replaying prior requests. Deployments that need a cluster-wide quota must
   * enforce it in the injected dispatch/policy layer.
   */
  maxRequestsPerMinute?: number;
  /**
   * Additional per-method fixed-window quotas. Ordinary methods also consume
   * the per-session quota. `artifact.upload` is intentionally isolated in its
   * dedicated bucket so a bounded multi-chunk artifact cannot exhaust the
   * control-plane request budget.
   */
  methodRequestsPerMinute?: Partial<Record<WorkerProtocolMethod, number>>;
  /** Maximum process-local aggregate and method rate-limit buckets. */
  maxRateLimitBuckets?: number;
  methodPayloadLimits?: Partial<Record<WorkerProtocolMethod, number>>;
  maxResponseBytes?: number;
  onAudit?: (event: WorkerProtocolAuditEvent) => Promise<void> | void;
  /** Trusted host diagnostics; never serialized to the worker response. */
  onError?: (error: unknown) => void;
}

export interface WorkerProtocolAuditEvent {
  requestId: string;
  sessionName: string;
  method: string;
  target: string;
  /** Policy snapshot from the verified request/session binding. */
  policyDigest: string;
  accepted: boolean;
  code?: OrchestrationErrorData['code'];
  receivedAt: string;
}

const DEFAULT_PAYLOAD_LIMITS: Record<WorkerProtocolMethod, number> = {
  'assignment.pull': 1024,
  'assignment.ack': 4096,
  'session.heartbeat': 4096,
  'event.submit': 64 * 1024,
  'capability.request': 32 * 1024,
  'artifact.upload': 1024 * 1024,
  'checkpoint.load': 4 * 1024,
  // The value itself is capped at 512 KiB. The remainder covers both bounded
  // identifiers and the signed JSON envelope without approaching the 1 MiB
  // HTTP/request frame boundary.
  'checkpoint.save': 640 * 1024,
  'operation.complete': 64 * 1024,
  'operation.fail': 32 * 1024,
  'operation.cancel': 4096,
};

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_RATE_PER_MINUTE = 120;
const DEFAULT_MAX_RATE_LIMIT_BUCKETS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_METHOD_RATES_PER_MINUTE: Partial<Record<WorkerProtocolMethod, number>> = {
  // 640 KiB chunks in the worker host make this at most 625 MiB/minute per
  // authenticated session while allowing a 100 MiB build artifact to finish.
  'artifact.upload': 1_000,
};
const METHODS_WITH_DEDICATED_RATE_LIMIT: ReadonlySet<WorkerProtocolMethod> = new Set([
  'artifact.upload',
]);
const DEFAULT_MAX_CLOCK_SKEW_MS = 30_000;
const DEFAULT_SESSION_REVOCATION_POLL_MS = 250;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      // These bytes are signed on one machine and verified on another.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error('worker protocol values must be JSON-compatible');
}

/** Canonical bytes signed by the worker; excludes only the signature field. */
export function canonicalWorkerProtocolRequestBytes(
  request: Omit<WorkerProtocolRequest, 'signature'> | WorkerProtocolRequest,
): Uint8Array {
  const { signature: _signature, ...unsigned } = request as WorkerProtocolRequest;
  return encoder.encode(canonicalize(unsigned));
}

/** Canonical bytes signed by the pinned gateway after enrollment. */
export function canonicalWorkerBootstrapDescriptorBytes(
  descriptor: WorkerBootstrapSessionDescriptor | SignedWorkerBootstrapSessionDescriptor,
): Uint8Array {
  const { gatewaySignature: _gatewaySignature, ...unsigned } = descriptor as SignedWorkerBootstrapSessionDescriptor;
  return encoder.encode(canonicalize(unsigned));
}

function byteSize(value: unknown): number {
  return encoder.encode(canonicalize(value)).byteLength;
}

function protocolError(
  code: OrchestrationErrorData['code'],
  message: string,
  retryable = false,
): OrchestrationError {
  return new OrchestrationError({ code, message, retryable });
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isBoundedCheckpointIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    value === value.normalize('NFC') &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) &&
    encoder.encode(value).byteLength <= WORKER_CHECKPOINT_LIMITS.identifierBytes
  );
}

function isCheckpointScope(value: unknown): value is WorkerCheckpointScope {
  if (!isRecord(value) || !hasOnlyKeys(value, ['scriptDigest', 'apiVersion', 'schemaVersion', 'runId'])) return false;
  return isBoundedCheckpointIdentifier(value.scriptDigest) &&
    isBoundedCheckpointIdentifier(value.apiVersion) &&
    isBoundedCheckpointIdentifier(value.schemaVersion) &&
    isBoundedCheckpointIdentifier(value.runId);
}

/** Validate the worker checkpoint scope at every protocol ingress. */
export function assertWorkerCheckpointScope(value: unknown): asserts value is WorkerCheckpointScope {
  if (!isCheckpointScope(value)) {
    throw protocolError('INVALID', 'worker checkpoint scope is malformed');
  }
}

/** Return a defensive canonical scope object for host-side adapters. */
export function normalizeWorkerCheckpointScope(value: unknown): WorkerCheckpointScope {
  assertWorkerCheckpointScope(value);
  return {
    scriptDigest: value.scriptDigest,
    apiVersion: value.apiVersion,
    schemaVersion: value.schemaVersion,
    runId: value.runId,
  };
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertCheckpointValue(value: unknown): void {
  try {
    canonicalJsonBytes(value, {
      maxBytes: WORKER_CHECKPOINT_LIMITS.valueBytes,
      maxDepth: WORKER_CHECKPOINT_LIMITS.valueDepth,
      maxNodes: WORKER_CHECKPOINT_LIMITS.valueNodes,
      maxStringBytes: WORKER_CHECKPOINT_LIMITS.valueBytes,
      maxStringCodeUnits: WORKER_CHECKPOINT_LIMITS.valueBytes,
    });
  } catch {
    throw protocolError('INVALID', 'worker checkpoint value is not bounded canonical JSON');
  }
}

/** Strict payload decoder shared by trusted worker-gateway hosts. */
export function parseWorkerCheckpointLoadPayload(value: unknown): WorkerCheckpointLoadPayload {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['conversationId', 'key', 'scope']) ||
    !isBoundedCheckpointIdentifier(value.conversationId) ||
    !isBoundedCheckpointIdentifier(value.key) ||
    !isCheckpointScope(value.scope)
  ) {
    throw protocolError('INVALID', 'worker checkpoint load payload is malformed');
  }
  return { conversationId: value.conversationId, key: value.key, scope: value.scope };
}

/** Strict payload decoder shared by trusted worker-gateway hosts. */
export function parseWorkerCheckpointSavePayload(value: unknown): WorkerCheckpointSavePayload {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['conversationId', 'key', 'scope', 'value', 'expectedRevision', 'fencingEpoch']) ||
    !isBoundedCheckpointIdentifier(value.conversationId) ||
    !isBoundedCheckpointIdentifier(value.key) ||
    !isCheckpointScope(value.scope) ||
    !isRevision(value.expectedRevision) ||
    !isRevision(value.fencingEpoch)
  ) {
    throw protocolError('INVALID', 'worker checkpoint save payload is malformed');
  }
  assertCheckpointValue(value.value);
  return {
    conversationId: value.conversationId,
    key: value.key,
    scope: value.scope,
    value: value.value,
    expectedRevision: value.expectedRevision,
    fencingEpoch: value.fencingEpoch,
  };
}

function abortError(
  reason: unknown,
  fallbackCode: OrchestrationErrorData['code'] = 'UNAVAILABLE',
  fallbackMessage = 'worker execution was cancelled',
): OrchestrationError {
  if (reason instanceof OrchestrationError) return reason;
  if (reason && typeof reason === 'object') {
    const candidate = reason as { code?: unknown; message?: unknown };
    if (
      (candidate.code === 'TIMEOUT' ||
        candidate.code === 'FORBIDDEN' ||
        candidate.code === 'UNAVAILABLE') &&
      typeof candidate.message === 'string'
    ) {
      return protocolError(candidate.code, candidate.message);
    }
  }
  return protocolError(fallbackCode, fallbackMessage, fallbackCode === 'UNAVAILABLE');
}

function createLinkedAbortController(signals: readonly AbortSignal[]): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const listeners = signals.map((signal) => {
    const listener = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) listener();
    return { signal, listener };
  });
  return {
    controller,
    dispose() {
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
    },
  };
}

function validateShape(request: WorkerProtocolRequest): void {
  if (request.apiVersion !== WORKER_PROTOCOL_VERSION) {
    throw protocolError(
      'UNSUPPORTED',
      `worker protocol '${String(request.apiVersion)}' is not supported`,
    );
  }
  if (
    !request.requestId ||
    !request.sessionName ||
    !Number.isSafeInteger(request.sequence) ||
    request.sequence < 1 ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(request.nonce) ||
    !request.audience ||
    !request.target ||
    !request.policyDigest ||
    !request.signature
  ) {
    throw protocolError('INVALID', 'worker protocol request envelope is malformed');
  }
  if (
    !request.run?.uid ||
    !Number.isSafeInteger(request.run.attempt) ||
    request.run.attempt < 1 ||
    !Number.isSafeInteger(request.run.epoch) ||
    request.run.epoch < 1
  ) {
    throw protocolError('INVALID', 'worker protocol Run binding is malformed');
  }
  if (!WORKER_PROTOCOL_METHODS.includes(request.method)) {
    throw protocolError('FORBIDDEN', `worker protocol method '${request.method}' is not allowed`);
  }
}

function sameRun(left: WorkerRunBinding, right: WorkerRunBinding): boolean {
  return left.uid === right.uid && left.attempt === right.attempt && left.epoch === right.epoch;
}

function asError(error: unknown): OrchestrationErrorData {
  if (error instanceof OrchestrationError) {
    const publicMessage: Partial<Record<OrchestrationErrorData['code'], string>> = {
      INVALID: 'worker gateway request is invalid',
      FORBIDDEN: 'worker gateway request was denied',
      NOT_FOUND: 'worker gateway target is unavailable',
      UNSUPPORTED: 'worker gateway request is unsupported',
      TIMEOUT: 'worker gateway request expired',
      CONFLICT: 'worker gateway request conflicts with session state',
      EXHAUSTED: 'worker gateway request exceeded a limit',
      INTERNAL: 'worker gateway request failed',
      UNAVAILABLE: 'worker gateway is unavailable',
    };
    return {
      code: error.code,
      message: publicMessage[error.code] ?? 'worker gateway request failed',
      retryable: error.retryable,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  return { code: 'INTERNAL', message: 'worker gateway request failed', retryable: false };
}

function assertRateLimit(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 1_000_000) {
    throw new TypeError(`${field} must be a positive safe integer no greater than 1000000`);
  }
}

interface RateLimitWindow {
  count: number;
  startedAt: number;
}

/**
 * Create the trusted-side protocol gateway. Session resolution, signature
 * verification, replay state, and effects are all injected host ports.
 */
export function createWorkerProtocolGateway(options: WorkerProtocolGatewayOptions): {
  handle(request: WorkerProtocolRequest, signal?: AbortSignal): Promise<WorkerProtocolResponse>;
} {
  const now = options.now ?? (() => new Date());
  const maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  const sessionRevocationPollMs = Math.max(
    25,
    options.sessionRevocationPollMs ?? DEFAULT_SESSION_REVOCATION_POLL_MS,
  );
  const rateLimit = options.maxRequestsPerMinute ?? DEFAULT_RATE_PER_MINUTE;
  assertRateLimit(rateLimit, 'maxRequestsPerMinute');
  const methodRateLimits = {
    ...DEFAULT_METHOD_RATES_PER_MINUTE,
    ...options.methodRequestsPerMinute,
  };
  for (const [method, limit] of Object.entries(methodRateLimits)) {
    if (!WORKER_PROTOCOL_METHODS.includes(method as WorkerProtocolMethod)) {
      throw new TypeError(`methodRequestsPerMinute contains unsupported method '${method}'`);
    }
    assertRateLimit(limit, `methodRequestsPerMinute.${method}`);
  }
  const maxRateLimitBuckets = options.maxRateLimitBuckets ?? DEFAULT_MAX_RATE_LIMIT_BUCKETS;
  assertRateLimit(maxRateLimitBuckets, 'maxRateLimitBuckets');
  if (Object.keys(methodRateLimits).length > 0 && maxRateLimitBuckets < 2) {
    throw new TypeError('maxRateLimitBuckets must be at least 2 when method quotas are configured');
  }
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const requestLog = new Map<string, RateLimitWindow>();
  let nextRequestLogSweepAt = 0;

  function pruneInactiveRequestLogs(receivedAtMs: number, force = false): void {
    if (!force && receivedAtMs < nextRequestLogSweepAt) return;
    for (const [bucket, window] of requestLog) {
      if (window.startedAt + RATE_LIMIT_WINDOW_MS <= receivedAtMs) requestLog.delete(bucket);
    }
    nextRequestLogSweepAt = receivedAtMs + RATE_LIMIT_WINDOW_MS;
  }

  function consumeRateLimits(
    sessionName: string,
    method: WorkerProtocolMethod,
    receivedAtMs: number,
  ): void {
    pruneInactiveRequestLogs(receivedAtMs);
    const buckets: Array<{ key: string; limit: number; message: string }> = [];
    if (!METHODS_WITH_DEDICATED_RATE_LIMIT.has(method)) {
      buckets.push({
        key: sessionName,
        limit: rateLimit,
        message: 'worker protocol session rate limit exceeded',
      });
    }
    const methodRateLimit = methodRateLimits[method];
    if (methodRateLimit !== undefined) {
      buckets.push({
        key: `${sessionName}\0${method}`,
        limit: methodRateLimit,
        message: `worker protocol ${method} rate limit exceeded`,
      });
    }

    const active = buckets.map((bucket) => {
      const current = requestLog.get(bucket.key);
      return {
        ...bucket,
        current: current && current.startedAt + RATE_LIMIT_WINDOW_MS > receivedAtMs ? current : undefined,
      };
    });
    const missingBuckets = active.filter(({ current }) => current === undefined).length;
    if (requestLog.size + missingBuckets > maxRateLimitBuckets) {
      pruneInactiveRequestLogs(receivedAtMs, true);
    }
    if (requestLog.size + missingBuckets > maxRateLimitBuckets) {
      const oldestExpiry = Math.min(
        ...Array.from(requestLog.values(), ({ startedAt }) => startedAt + RATE_LIMIT_WINDOW_MS),
      );
      throw new OrchestrationError({
        code: 'EXHAUSTED',
        message: 'worker protocol rate limiter capacity exceeded',
        retryable: true,
        retryAfterMs: Math.max(1, oldestExpiry - receivedAtMs),
      });
    }
    for (const bucket of active) {
      if (bucket.current && bucket.current.count >= bucket.limit) {
        throw new OrchestrationError({
          code: 'EXHAUSTED',
          message: bucket.message,
          retryable: true,
          retryAfterMs: Math.max(1, bucket.current.startedAt + RATE_LIMIT_WINDOW_MS - receivedAtMs),
        });
      }
    }
    for (const bucket of active) {
      if (bucket.current) {
        bucket.current.count += 1;
      } else {
        requestLog.set(bucket.key, { count: 1, startedAt: receivedAtMs });
      }
    }
  }

  async function audit(
    request: Pick<
      WorkerProtocolRequest,
      'requestId' | 'sessionName' | 'method' | 'target' | 'policyDigest'
    >,
    accepted: boolean,
    receivedAt: string,
    code?: OrchestrationErrorData['code'],
  ): Promise<void> {
    try {
      await options.onAudit?.({
        requestId: request.requestId,
        sessionName: request.sessionName,
        method: request.method,
        target: request.target,
        policyDigest: request.policyDigest,
        accepted,
        ...(code ? { code } : {}),
        receivedAt,
      });
    } catch (error) {
      // Audit storage failure must not leak request payloads or replace the
      // original protocol result. Surface the failure through the host's
      // existing error sink instead of silently discarding it.
      options.onError?.(error);
    }
  }

  return {
    async handle(request, signal = new AbortController().signal) {
      const received = now();
      const receivedAt = received.toISOString();
      try {
        validateShape(request);
        const deadline = new Date(request.deadline);
        if (!Number.isFinite(deadline.getTime()) || deadline.getTime() < received.getTime()) {
          throw protocolError('TIMEOUT', 'worker protocol request deadline has expired');
        }
        if (deadline.getTime() - received.getTime() > maxClockSkewMs) {
          throw protocolError(
            'INVALID',
            'worker protocol request deadline is outside the allowed window',
          );
        }
        const payloadLimit = options.methodPayloadLimits?.[request.method] ?? DEFAULT_PAYLOAD_LIMITS[request.method];
        if (byteSize(request.payload) > payloadLimit) {
          throw protocolError('INVALID', `worker protocol payload exceeds ${payloadLimit} bytes`);
        }

        const session = await options.resolveSession(request.sessionName);
        if (!session || session.revoked) {
          throw protocolError('FORBIDDEN', 'worker session is unavailable or revoked');
        }
        if (session.protocol !== WORKER_PROTOCOL_VERSION) {
          throw protocolError('UNSUPPORTED', 'worker session protocol is not supported');
        }
        if (new Date(session.expiresAt).getTime() <= received.getTime()) {
          throw protocolError('TIMEOUT', 'worker session has expired');
        }
        if (
          session.audience !== request.audience ||
          session.policyDigest !== request.policyDigest ||
          !sameRun(session.run, request.run)
        ) {
          throw protocolError('FORBIDDEN', 'worker request scope does not match its session');
        }
        if (!session.allowedMethods.includes(request.method)) {
          throw protocolError('FORBIDDEN', `worker session does not allow '${request.method}'`);
        }
        if (session.allowedTargets && !session.allowedTargets.includes(request.target)) {
          throw protocolError(
            'FORBIDDEN',
            `worker session does not allow target '${request.target}'`,
          );
        }
        if (
          !(await options.verifySignature({
            session,
            message: canonicalWorkerProtocolRequestBytes(request),
            signature: request.signature,
          }))
        ) {
          throw protocolError('FORBIDDEN', 'worker request signature is invalid');
        }
        if (
          !(await options.replayProtector.consume(session.name, request.sequence, request.nonce))
        ) {
          throw protocolError('CONFLICT', 'worker request sequence or nonce was already consumed');
        }

        consumeRateLimits(session.name, request.method, received.getTime());

        const deadlineController = new AbortController();
        const deadlineTimer = setTimeout(
          () => {
            deadlineController.abort(
              protocolError('TIMEOUT', 'worker protocol request deadline has expired'),
            );
          },
          Math.max(0, deadline.getTime() - received.getTime()),
        );
        const linked = createLinkedAbortController([
          signal,
          deadlineController.signal,
          ...(session.revocationSignal ? [session.revocationSignal] : []),
        ]);
        let revocationTimer: ReturnType<typeof setInterval> | undefined;
        let revocationProbeInFlight = false;
        if (options.isSessionRevoked) {
          revocationTimer = setInterval(() => {
            if (linked.controller.signal.aborted || revocationProbeInFlight) return;
            revocationProbeInFlight = true;
            void Promise.resolve(options.isSessionRevoked!(session.name))
              .then((revoked) => {
                if (revoked && !linked.controller.signal.aborted) {
                  linked.controller.abort(protocolError('FORBIDDEN', 'worker session was revoked'));
                }
              })
              .catch(() => {
                // A failed revocation probe is fail-closed for the running
                // effect: the caller must reconcile it rather than retrying.
                if (!linked.controller.signal.aborted) {
                  linked.controller.abort(
                    protocolError('UNAVAILABLE', 'worker session revocation state is unavailable'),
                  );
                }
              })
              .finally(() => {
                revocationProbeInFlight = false;
              });
          }, sessionRevocationPollMs);
        }
        try {
          if (linked.controller.signal.aborted) {
            throw abortError(linked.controller.signal.reason);
          }
          const payload = await options.dispatch({
            requestId: request.requestId,
            session,
            method: request.method,
            target: request.target,
            payload: request.payload,
            signal: linked.controller.signal,
          });
          if (linked.controller.signal.aborted) {
            throw abortError(linked.controller.signal.reason);
          }
          if (byteSize(payload) > maxResponseBytes) {
            throw protocolError(
              'EXHAUSTED',
              `worker protocol response exceeds ${maxResponseBytes} bytes`,
            );
          }
          await audit(request, true, receivedAt);
          return {
            apiVersion: WORKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            payload,
            receivedAt,
          };
        } catch (error) {
          if (linked.controller.signal.aborted) {
            throw abortError(linked.controller.signal.reason);
          }
          throw error;
        } finally {
          clearTimeout(deadlineTimer);
          if (revocationTimer !== undefined) clearInterval(revocationTimer);
          linked.dispose();
        }
      } catch (error) {
        options.onError?.(error);
        const data = asError(error);
        await audit(request, false, receivedAt, data.code);
        return {
          apiVersion: WORKER_PROTOCOL_VERSION,
          requestId: typeof request?.requestId === 'string' ? request.requestId : '',
          ok: false,
          error: data,
          receivedAt,
        };
      }
    },
  };
}

/** In-memory replay fixture. Production gateways must use durable state. */
export function createInMemoryWorkerReplayProtector(): WorkerProtocolReplayProtector {
  const states = new Map<string, { sequence: number; nonces: Set<string> }>();
  return {
    async consume(sessionName, sequence, nonce) {
      const state = states.get(sessionName);
      if (
        (!state && sequence !== 1) ||
        (state && sequence !== state.sequence + 1) ||
        state?.nonces.has(nonce)
      ) {
        return false;
      }
      const nonces = state?.nonces ?? new Set<string>();
      nonces.add(nonce);
      states.set(sessionName, { sequence, nonces });
      return true;
    },
  };
}
