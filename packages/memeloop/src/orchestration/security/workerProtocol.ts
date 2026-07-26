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
  'operation.complete',
  'operation.fail',
  'operation.cancel',
] as const;

export type WorkerProtocolMethod = typeof WORKER_PROTOCOL_METHODS[number];

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
  maxRequestsPerMinute?: number;
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
  'operation.complete': 64 * 1024,
  'operation.fail': 32 * 1024,
  'operation.cancel': 4096,
};

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_RATE_PER_MINUTE = 120;
const DEFAULT_MAX_CLOCK_SKEW_MS = 30_000;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
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

function validateShape(request: WorkerProtocolRequest): void {
  if (request.apiVersion !== WORKER_PROTOCOL_VERSION) {
    throw protocolError('UNSUPPORTED', `worker protocol '${String(request.apiVersion)}' is not supported`);
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

/**
 * Create the trusted-side protocol gateway. Session resolution, signature
 * verification, replay state, and effects are all injected host ports.
 */
export function createWorkerProtocolGateway(options: WorkerProtocolGatewayOptions): {
  handle(request: WorkerProtocolRequest, signal?: AbortSignal): Promise<WorkerProtocolResponse>;
} {
  const now = options.now ?? (() => new Date());
  const maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  const rateLimit = options.maxRequestsPerMinute ?? DEFAULT_RATE_PER_MINUTE;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const requestLog = new Map<string, number[]>();

  async function audit(
    request: Pick<WorkerProtocolRequest, 'requestId' | 'sessionName' | 'method' | 'target'>,
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
        accepted,
        ...(code ? { code } : {}),
        receivedAt,
      });
    } catch {
      // Audit storage failure must not leak request payloads or replace the
      // original protocol result. Hosts should alert through their sink.
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
          throw protocolError('INVALID', 'worker protocol request deadline is outside the allowed window');
        }
        const payloadLimit = options.methodPayloadLimits?.[request.method] ?? DEFAULT_PAYLOAD_LIMITS[request.method];
        if (byteSize(request.payload) > payloadLimit) {
          throw protocolError('INVALID', `worker protocol payload exceeds ${payloadLimit} bytes`);
        }

        const session = await options.resolveSession(request.sessionName);
        if (!session || session.revoked) throw protocolError('FORBIDDEN', 'worker session is unavailable or revoked');
        if (session.protocol !== WORKER_PROTOCOL_VERSION) throw protocolError('UNSUPPORTED', 'worker session protocol is not supported');
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
          throw protocolError('FORBIDDEN', `worker session does not allow target '${request.target}'`);
        }
        if (
          !await options.verifySignature({
            session,
            message: canonicalWorkerProtocolRequestBytes(request),
            signature: request.signature,
          })
        ) {
          throw protocolError('FORBIDDEN', 'worker request signature is invalid');
        }
        if (!await options.replayProtector.consume(session.name, request.sequence, request.nonce)) {
          throw protocolError('CONFLICT', 'worker request sequence or nonce was already consumed');
        }

        const windowStart = received.getTime() - 60_000;
        const log = (requestLog.get(session.name) ?? []).filter((time) => time >= windowStart);
        if (log.length >= rateLimit) {
          throw new OrchestrationError({
            code: 'EXHAUSTED',
            message: 'worker protocol session rate limit exceeded',
            retryable: true,
            retryAfterMs: Math.max(1, log[0] + 60_000 - received.getTime()),
          });
        }
        log.push(received.getTime());
        requestLog.set(session.name, log);

        const payload = await options.dispatch({
          requestId: request.requestId,
          session,
          method: request.method,
          target: request.target,
          payload: request.payload,
          signal,
        });
        if (byteSize(payload) > maxResponseBytes) {
          throw protocolError('EXHAUSTED', `worker protocol response exceeds ${maxResponseBytes} bytes`);
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
      if ((!state && sequence !== 1) || (state && sequence !== state.sequence + 1) || state?.nonces.has(nonce)) {
        return false;
      }
      const nonces = state?.nonces ?? new Set<string>();
      nonces.add(nonce);
      states.set(sessionName, { sequence, nonces });
      return true;
    },
  };
}
