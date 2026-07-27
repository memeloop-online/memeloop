import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  bindWorkerSession,
  type BindWorkerSessionRequest,
  canonicalWorkerBootstrapDescriptorBytes,
  type ControlStore,
  type ControlStoreActor,
  createWorkerProtocolGateway,
  WORKER_PROTOCOL_VERSION,
  type WorkerBootstrapSessionDescriptor,
  type WorkerProtocolGatewayOptions,
  type WorkerProtocolRequest,
} from 'memeloop';

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
  now?: () => Date;
  onAudit?: WorkerProtocolGatewayOptions['onAudit'];
  onError?: (error: unknown) => void;
  /** Managed identity route; direct narrow binding remains a compatibility fallback. */
  bindSession?: (
    enrollmentName: string,
    request: BindWorkerSessionRequest,
  ) => ReturnType<typeof bindWorkerSession>;
}

export type WorkerGatewayHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

const DEFAULT_REQUEST_LIMIT = 1024 * 1024 + 64 * 1024;
const DEFAULT_SESSION_TTL = 15 * 60 * 1000;
const DEFAULT_MAX_SESSION_TTL = 60 * 60 * 1000;

function reply(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > limit) throw new RangeError(`worker gateway request exceeds ${limit} bytes`);
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function isBootstrapRequest(value: unknown): value is WorkerBootstrapRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.enrollmentName === 'string' &&
    typeof record.bootstrapToken === 'string' &&
    typeof record.workerPublicKey === 'string' &&
    typeof record.proofSignature === 'string' &&
    (record.ttlMs === undefined || typeof record.ttlMs === 'number')
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
  const maxSessionTtlMs = options.maxSessionTtlMs ?? DEFAULT_MAX_SESSION_TTL;
  const now = options.now ?? (() => new Date());
  const gateway = createWorkerProtocolGateway({
    resolveSession: (sessionName) => resolveControlStoreWorkerGatewaySession(options.store, sessionName),
    replayProtector: createControlStoreWorkerReplayProtector(options.store, options.actor),
    verifySignature: async ({ session, message, signature }) =>
      fingerprintWorkerPublicKey(session.workerPublicKey) === session.workerKeyFingerprint &&
      verifyWorkerEd25519Signature(session.workerPublicKey, message, signature),
    dispatch: options.dispatch,
    now,
    ...(options.onAudit ? { onAudit: options.onAudit } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });

  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://memeloop.invalid');
      if (request.method !== 'POST' || (url.pathname !== bootstrapPath && url.pathname !== messagePath)) {
        reply(response, 404, { error: 'not found' });
        return;
      }
      if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
        reply(response, 415, { error: 'content-type must be application/json' });
        return;
      }
      let body: unknown;
      try {
        body = await readJson(request, maxRequestBytes);
      } catch (error) {
        reply(response, error instanceof RangeError ? 413 : 400, {
          error: error instanceof RangeError ? error.message : 'invalid JSON request',
        });
        return;
      }

      if (url.pathname === bootstrapPath) {
        if (!isBootstrapRequest(body)) {
          reply(response, 400, { error: 'invalid worker bootstrap request' });
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
          ttlMs: Math.min(body.ttlMs ?? DEFAULT_SESSION_TTL, maxSessionTtlMs),
          verifyBootstrapToken: verifyWorkerBootstrapToken,
          verifyWorkerProof: ({ challenge, signature, workerPublicKey }) =>
            challenge === Buffer.from(proofMessage).toString('base64url') &&
            verifyWorkerEd25519Signature(workerPublicKey, proofMessage, signature),
        };
        const session = options.bindSession
          ? await options.bindSession(body.enrollmentName, bindingRequest)
          : await bindWorkerSession(
            options.store,
            options.actor,
            body.enrollmentName,
            bindingRequest,
            now,
          );
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
        reply(response, 200, {
          ...descriptor,
          gatewaySignature: await options.signBootstrap(
            canonicalWorkerBootstrapDescriptorBytes(descriptor),
          ),
        });
        return;
      }

      const abort = new AbortController();
      request.once('aborted', () => {
        abort.abort();
      });
      response.once('close', () => {
        if (!response.writableEnded) abort.abort();
      });
      const result = await gateway.handle(body as WorkerProtocolRequest, abort.signal);
      reply(response, result.ok ? 200 : result.error.code === 'EXHAUSTED' ? 429 : 403, result);
    } catch (error) {
      options.onError?.(error);
      reply(response, 403, { error: 'worker gateway request denied' });
    }
  };
}
