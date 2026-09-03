import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  type BindWorkerSessionRequest,
  canonicalWorkerBootstrapDescriptorBytes,
  type ControlStore,
  type ControlStoreActor,
  createWorkerProtocolGateway,
  WORKER_PROTOCOL_VERSION,
  WORKER_SESSION_API_VERSION,
  WORKER_SESSION_KIND,
  type WorkerBootstrapSessionDescriptor,
  type WorkerProtocolGatewayOptions,
  type WorkerProtocolRequest,
  type WorkerSessionResource,
} from 'memeloop';

import { bindHttpAbortLifecycle, readBoundedBody, replyJson } from './httpBoundary.js';
import {
  createControlStoreWorkerReplayProtector,
  fingerprintWorkerPublicKey,
  resolveControlStoreWorkerGatewaySession,
  verifyWorkerBootstrapToken,
  verifyWorkerEd25519Signature,
  workerBootstrapProofMessage,
} from './nodeWorkerSecurity.js';

export interface WorkerBootstrapRequest {
  enrollmentName: string;
  bootstrapToken: string;
  workerPublicKey: string;
  /** Ed25519 signature over workerBootstrapProofMessage(...), base64url. */
  proofSignature: string;
  ttlMs?: number;
}

export interface WorkerGatewayHttpHandlerOptions {
  store: ControlStore;
  actor: ControlStoreActor;
  dispatch: WorkerProtocolGatewayOptions['dispatch'];
  gatewayKeyFingerprint: string;
  signBootstrap: (message: Uint8Array) => Promise<string> | string;
  bootstrapPath?: string;
  messagePath?: string;
  maxRequestBytes?: number;
  maxSessionTtlMs?: number;
  maxRequestsPerMinute?: WorkerProtocolGatewayOptions['maxRequestsPerMinute'];
  methodRequestsPerMinute?: WorkerProtocolGatewayOptions['methodRequestsPerMinute'];
  now?: () => Date;
  onAudit?: WorkerProtocolGatewayOptions['onAudit'];
  onError?: (error: unknown) => void;
  /** Host-managed identity route used to bind a worker session. */
  bindSession: (
    enrollmentName: string,
    request: BindWorkerSessionRequest,
  ) => Promise<WorkerSessionResource>;
}

export type WorkerGatewayHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

const DEFAULT_REQUEST_LIMIT = 1024 * 1024 + 64 * 1024;
export const DEFAULT_WORKER_GATEWAY_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_WORKER_GATEWAY_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** One TTL policy shared by the standalone handler and NodeRuntime wiring. */
export function normalizeWorkerGatewaySessionTtlMs(
  value: number | undefined,
  fallback = DEFAULT_WORKER_GATEWAY_SESSION_TTL_MS,
): number {
  const requested = value ?? fallback;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new TypeError('worker gateway session TTL must be a positive safe integer');
  }
  return Math.min(requested, MAX_WORKER_GATEWAY_SESSION_TTL_MS);
}

function isBootstrapRequest(value: unknown): value is WorkerBootstrapRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.enrollmentName === 'string' &&
    typeof record.bootstrapToken === 'string' &&
    typeof record.workerPublicKey === 'string' &&
    typeof record.proofSignature === 'string' &&
    (record.ttlMs === undefined ||
      (Number.isSafeInteger(record.ttlMs) && (record.ttlMs as number) > 0))
  );
}

/**
 * Trusted Node HTTP boundary for the dedicated outbound worker protocol.
 *
 * Bootstrap consumes a short-lived enrollment token and verifies possession
 * of a worker-generated ephemeral Ed25519 key. Subsequent messages use the
 * portable gateway with ControlStore-backed replay fencing. The handler does
 * not expose ResourceClient or accept a worker-selected actor.
 */
export function createWorkerGatewayHttpHandler(
  options: WorkerGatewayHttpHandlerOptions,
): WorkerGatewayHttpHandler {
  const bootstrapPath = options.bootstrapPath ?? '/v1/worker/bootstrap';
  const messagePath = options.messagePath ?? '/v1/worker/message';
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_REQUEST_LIMIT;
  const maxSessionTtlMs = normalizeWorkerGatewaySessionTtlMs(
    options.maxSessionTtlMs,
    MAX_WORKER_GATEWAY_SESSION_TTL_MS,
  );
  const now = options.now ?? (() => new Date());
  const gateway = createWorkerProtocolGateway({
    resolveSession: (sessionName) => resolveControlStoreWorkerGatewaySession(options.store, sessionName),
    isSessionRevoked: async (sessionName) => {
      const session = await options.store.get({
        apiVersion: WORKER_SESSION_API_VERSION,
        kind: WORKER_SESSION_KIND,
        name: sessionName,
      });
      return !session || (session.status as { phase?: string } | undefined)?.phase !== 'Active';
    },
    replayProtector: createControlStoreWorkerReplayProtector(options.store, options.actor),
    verifySignature: async ({ session, message, signature }) =>
      fingerprintWorkerPublicKey(session.workerPublicKey) === session.workerKeyFingerprint &&
      verifyWorkerEd25519Signature(session.workerPublicKey, message, signature),
    dispatch: options.dispatch,
    now,
    ...(options.maxRequestsPerMinute === undefined
      ? {}
      : { maxRequestsPerMinute: options.maxRequestsPerMinute }),
    ...(options.methodRequestsPerMinute === undefined
      ? {}
      : { methodRequestsPerMinute: options.methodRequestsPerMinute }),
    ...(options.onAudit ? { onAudit: options.onAudit } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });

  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://memeloop.invalid');
      if (request.method !== 'POST' || (url.pathname !== bootstrapPath && url.pathname !== messagePath)) {
        replyJson(response, 404, { error: 'not found' });
        return;
      }
      if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
        replyJson(response, 415, { error: 'content-type must be application/json' });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(await readBoundedBody(request, maxRequestBytes, 'worker gateway request exceeds')) as unknown;
      } catch (error) {
        replyJson(response, error instanceof RangeError ? 413 : 400, {
          error: error instanceof RangeError ? error.message : 'invalid JSON request',
        });
        return;
      }

      if (url.pathname === bootstrapPath) {
        if (!isBootstrapRequest(body)) {
          replyJson(response, 400, { error: 'invalid worker bootstrap request' });
          return;
        }
        const workerKeyFingerprint = fingerprintWorkerPublicKey(body.workerPublicKey);
        const proofMessage = workerBootstrapProofMessage(body.enrollmentName, body.bootstrapToken);
        const bindingRequest: BindWorkerSessionRequest = {
          bootstrapToken: body.bootstrapToken,
          workerKeyFingerprint,
          workerPublicKey: body.workerPublicKey,
          gatewayKeyFingerprint: options.gatewayKeyFingerprint,
          proof: {
            challenge: Buffer.from(proofMessage).toString('base64url'),
            signature: body.proofSignature,
          },
          ttlMs: Math.min(
            normalizeWorkerGatewaySessionTtlMs(body.ttlMs),
            maxSessionTtlMs,
          ),
          verifyBootstrapToken: verifyWorkerBootstrapToken,
          verifyWorkerProof: ({ challenge, signature, workerPublicKey }) =>
            challenge === Buffer.from(proofMessage).toString('base64url') &&
            verifyWorkerEd25519Signature(workerPublicKey, proofMessage, signature),
        };
        const session = await options.bindSession(body.enrollmentName, bindingRequest);
        const descriptor: WorkerBootstrapSessionDescriptor = {
          apiVersion: WORKER_PROTOCOL_VERSION,
          sessionName: session.metadata.name,
          audience: session.spec.audience,
          expiresAt: session.status?.expiresAt ?? '',
          run: session.spec.run,
          policyDigest: session.spec.policyDigest,
          allowedMethods: session.spec.allowedMethods,
          ...(session.spec.allowedTargets ? { allowedTargets: session.spec.allowedTargets } : {}),
          workerKeyFingerprint,
          gatewayKeyFingerprint: options.gatewayKeyFingerprint,
          issuedAt: now().toISOString(),
        };
        replyJson(response, 200, {
          ...descriptor,
          gatewaySignature: await options.signBootstrap(
            canonicalWorkerBootstrapDescriptorBytes(descriptor),
          ),
        });
        return;
      }

      const lifecycle = bindHttpAbortLifecycle(request, response, 'worker gateway HTTP');
      try {
        const result = await gateway.handle(body as WorkerProtocolRequest, lifecycle.signal);
        replyJson(response, result.ok ? 200 : result.error.code === 'EXHAUSTED' ? 429 : 403, result);
      } finally {
        lifecycle.dispose();
      }
    } catch (error) {
      options.onError?.(error);
      replyJson(response, 403, { error: 'worker gateway request denied' });
    }
  };
}
