import { describe, expect, it, vi } from 'vitest';

import { OrchestrationError } from '../errors.js';
import {
  canonicalWorkerProtocolRequestBytes,
  createInMemoryWorkerReplayProtector,
  createWorkerProtocolGateway,
  WORKER_PROTOCOL_VERSION,
  type WorkerGatewaySession,
  type WorkerProtocolRequest,
} from '../security/workerProtocol.js';

const NOW = new Date('2026-07-23T10:00:00.000Z');
const SESSION: WorkerGatewaySession = {
  name: 'session-1',
  workerKeyFingerprint: 'ed25519:worker-1',
  workerPublicKey: 'encoded-public-key',
  audience: 'worker-gateway://node-1',
  protocol: WORKER_PROTOCOL_VERSION,
  expiresAt: '2026-07-23T10:10:00.000Z',
  revoked: false,
  run: { uid: 'run-uid-1', attempt: 1, epoch: 7 },
  policyDigest: 'sha256:policy',
  allowedMethods: ['assignment.pull', 'event.submit', 'capability.request'],
  allowedTargets: ['run-uid-1'],
};

function request(overrides: Partial<WorkerProtocolRequest> = {}): WorkerProtocolRequest {
  return {
    apiVersion: WORKER_PROTOCOL_VERSION,
    requestId: 'request-1',
    sessionName: SESSION.name,
    sequence: 1,
    nonce: 'abcdefghijklmnop',
    deadline: '2026-07-23T10:00:10.000Z',
    audience: SESSION.audience,
    run: SESSION.run,
    method: 'assignment.pull',
    target: 'run-uid-1',
    policyDigest: SESSION.policyDigest,
    payload: {},
    signature: 'valid-signature',
    ...overrides,
  };
}

function gateway(overrides: Partial<Parameters<typeof createWorkerProtocolGateway>[0]> = {}) {
  return createWorkerProtocolGateway({
    resolveSession: async () => SESSION,
    replayProtector: createInMemoryWorkerReplayProtector(),
    verifySignature: async ({ signature }) => signature === 'valid-signature',
    dispatch: async ({ method }) => ({ method }),
    now: () => NOW,
    ...overrides,
  });
}

describe('dedicated worker protocol gateway', () => {
  it('canonicalizes signed bytes independently of property order and signature', () => {
    const first = request();
    const second = { ...first, payload: { z: 1, a: 2 }, signature: 'other' };
    const third = { ...first, payload: { a: 2, z: 1 } };
    expect(canonicalWorkerProtocolRequestBytes(second)).toEqual(canonicalWorkerProtocolRequestBytes(third));
    expect(new TextDecoder().decode(canonicalWorkerProtocolRequestBytes(first))).not.toContain('valid-signature');
  });

  it('accepts a scoped signed request and emits metadata-only audit', async () => {
    const dispatch = vi.fn(async () => ({ assignment: 'redacted' }));
    const audits: unknown[] = [];
    const response = await gateway({ dispatch, onAudit: (event) => audits.push(event) }).handle(request());
    expect(response).toMatchObject({ ok: true, payload: { assignment: 'redacted' } });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'assignment.pull',
      target: 'run-uid-1',
    }));
    expect(audits).toEqual([expect.objectContaining({
      requestId: 'request-1',
      accepted: true,
    })]);
    expect(JSON.stringify(audits)).not.toContain('redacted');
  });

  it('rejects signatures, scope escalation, forbidden methods, and targets', async () => {
    await expect(gateway().handle(request({ signature: 'forged' })))
      .resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    await expect(gateway().handle(request({ run: { ...SESSION.run, epoch: 8 } })))
      .resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    await expect(gateway().handle(request({ method: 'artifact.upload' })))
      .resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    await expect(gateway().handle(request({ target: 'another-run' })))
      .resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('rejects replayed, skipped, and duplicate-nonce messages', async () => {
    const instance = gateway();
    await expect(instance.handle(request())).resolves.toMatchObject({ ok: true });
    await expect(instance.handle(request())).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await expect(instance.handle(request({ sequence: 3, nonce: 'qrstuvwxyzABCDEF' })))
      .resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await expect(instance.handle(request({ sequence: 2, nonce: 'abcdefghijklmnop' })))
      .resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await expect(instance.handle(request({ sequence: 2, nonce: 'qrstuvwxyzABCDEF' })))
      .resolves.toMatchObject({ ok: true });
  });

  it('rejects expired sessions/deadlines and future deadline windows', async () => {
    await expect(gateway().handle(request({ deadline: '2026-07-23T09:59:59.000Z' })))
      .resolves.toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    await expect(gateway().handle(request({ deadline: '2026-07-23T10:01:00.000Z' })))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID' } });
    await expect(
      gateway({
        resolveSession: async () => ({ ...SESSION, expiresAt: '2026-07-23T09:59:59.000Z' }),
      }).handle(request()),
    ).resolves.toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
  });

  it('enforces method payload, response, and per-session rate bounds', async () => {
    await expect(gateway().handle(request({ payload: { value: 'x'.repeat(2000) } })))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID' } });
    await expect(
      gateway({
        maxResponseBytes: 8,
        dispatch: async () => ({ tooLarge: true }),
      }).handle(request()),
    ).resolves.toMatchObject({ ok: false, error: { code: 'EXHAUSTED' } });

    const limited = gateway({ maxRequestsPerMinute: 1 });
    await expect(limited.handle(request())).resolves.toMatchObject({ ok: true });
    await expect(limited.handle(request({ sequence: 2, nonce: 'qrstuvwxyzABCDEF' })))
      .resolves.toMatchObject({ ok: false, error: { code: 'EXHAUSTED' } });
  });

  it('fails closed after replay state loss when a session resumes above sequence one', async () => {
    const restarted = gateway({ replayProtector: createInMemoryWorkerReplayProtector() });
    await expect(restarted.handle(request({ sequence: 9 })))
      .resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('returns a generic internal error without leaking dispatcher secrets', async () => {
    const response = await gateway({
      dispatch: async () => {
        throw new Error('provider key sk-secret-value');
      },
    }).handle(request());
    expect(response).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(response)).not.toContain('sk-secret-value');
  });

  it('does not expose trusted OrchestrationError details to a hostile worker', async () => {
    const response = await gateway({
      dispatch: async () => {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'tenant secret and internal policy branch',
          retryable: false,
        });
      },
    }).handle(request());
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'worker gateway request was denied' },
    });
    expect(JSON.stringify(response)).not.toContain('internal policy');
  });
});
