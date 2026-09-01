import { describe, expect, it, vi } from 'vitest';

import { OrchestrationError } from '../errors.js';
import {
  canonicalWorkerProtocolRequestBytes,
  createInMemoryWorkerReplayProtector,
  createWorkerProtocolGateway,
  parseWorkerCheckpointLoadPayload,
  parseWorkerCheckpointSavePayload,
  WORKER_CHECKPOINT_LIMITS,
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
  it('accepts only exact bounded canonical checkpoint payloads', () => {
    expect(
      parseWorkerCheckpointLoadPayload({
        conversationId: 'external:default:workload-1',
        key: 'done',
      }),
    ).toEqual({ conversationId: 'external:default:workload-1', key: 'done' });
    expect(
      parseWorkerCheckpointSavePayload({
        conversationId: 'external:default:workload-1',
        key: 'state:count',
        value: { count: 2 },
      }),
    ).toEqual({
      conversationId: 'external:default:workload-1',
      key: 'state:count',
      value: { count: 2 },
    });
    expect(() =>
      parseWorkerCheckpointLoadPayload({
        conversationId: 'external:default:workload-1',
        key: 'done',
        extra: true,
      })
    ).toThrow(OrchestrationError);
    expect(() =>
      parseWorkerCheckpointSavePayload({
        conversationId: 'external:default:workload-1',
        key: 'done',
        value: 'x'.repeat(512 * 1024 + 1),
      })
    ).toThrow(OrchestrationError);
    expect(() =>
      parseWorkerCheckpointSavePayload({
        conversationId: 'external:default:workload-1',
        key: 'done',
        value: undefined,
      })
    ).toThrow(OrchestrationError);
  });

  it('enforces checkpoint identifier, byte, depth, and node limits at their exact boundaries', () => {
    const identifierAtLimit = 'i'.repeat(WORKER_CHECKPOINT_LIMITS.identifierBytes);
    expect(
      parseWorkerCheckpointLoadPayload({
        conversationId: identifierAtLimit,
        key: identifierAtLimit,
      }),
    ).toEqual({ conversationId: identifierAtLimit, key: identifierAtLimit });
    expect(() =>
      parseWorkerCheckpointLoadPayload({
        conversationId: `${identifierAtLimit}i`,
        key: 'bounded',
      })
    ).toThrow(OrchestrationError);

    const valueAtByteLimit = 'x'.repeat(WORKER_CHECKPOINT_LIMITS.valueBytes - 2);
    expect(
      parseWorkerCheckpointSavePayload({
        conversationId: 'external:default:workload-1',
        key: 'bytes',
        value: valueAtByteLimit,
      }).value,
    ).toBe(valueAtByteLimit);
    expect(() =>
      parseWorkerCheckpointSavePayload({
        conversationId: 'external:default:workload-1',
        key: 'bytes',
        value: `${valueAtByteLimit}x`,
      })
    ).toThrow(OrchestrationError);

    const nested = (depth: number): unknown => {
      let value: unknown = null;
      for (let index = 0; index < depth; index += 1) value = [value];
      return value;
    };
    expect(() =>
      parseWorkerCheckpointSavePayload({
        conversationId: 'external:default:workload-1',
        key: 'depth',
        value: nested(WORKER_CHECKPOINT_LIMITS.valueDepth),
      })
    ).not.toThrow();
    expect(() =>
      parseWorkerCheckpointSavePayload({
        conversationId: 'external:default:workload-1',
        key: 'depth',
        value: nested(WORKER_CHECKPOINT_LIMITS.valueDepth + 1),
      })
    ).toThrow(OrchestrationError);

    expect(() =>
      parseWorkerCheckpointSavePayload({
        conversationId: 'external:default:workload-1',
        key: 'nodes',
        value: Array.from({ length: WORKER_CHECKPOINT_LIMITS.valueNodes - 1 }, () => null),
      })
    ).not.toThrow();
    expect(() =>
      parseWorkerCheckpointSavePayload({
        conversationId: 'external:default:workload-1',
        key: 'nodes',
        value: Array.from({ length: WORKER_CHECKPOINT_LIMITS.valueNodes }, () => null),
      })
    ).toThrow(OrchestrationError);
  });

  it('canonicalizes signed bytes independently of property order and signature', () => {
    const first = request();
    const second = { ...first, payload: { z: 1, a: 2 }, signature: 'other' };
    const third = { ...first, payload: { a: 2, z: 1 } };
    expect(canonicalWorkerProtocolRequestBytes(second)).toEqual(
      canonicalWorkerProtocolRequestBytes(third),
    );
    expect(new TextDecoder().decode(canonicalWorkerProtocolRequestBytes(first))).not.toContain(
      'valid-signature',
    );
  });

  it('orders signed object keys independently of the verifier locale', () => {
    const bytes = canonicalWorkerProtocolRequestBytes(request({ payload: { ä: 1, z: 2 } }));
    expect(new TextDecoder().decode(bytes)).toContain('"payload":{"z":2,"ä":1}');
  });

  it('accepts a scoped signed request and emits metadata-only audit', async () => {
    const dispatch = vi.fn(async () => ({ assignment: 'redacted' }));
    const audits: unknown[] = [];
    const response = await gateway({
      dispatch,
      onAudit: (event) => {
        audits.push(event);
      },
    }).handle(request());
    expect(response).toMatchObject({ ok: true, payload: { assignment: 'redacted' } });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'assignment.pull',
        target: 'run-uid-1',
      }),
    );
    expect(audits).toEqual([
      expect.objectContaining({
        requestId: 'request-1',
        accepted: true,
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain('redacted');
  });

  it('rejects signatures, scope escalation, forbidden methods, and targets', async () => {
    await expect(gateway().handle(request({ signature: 'forged' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    await expect(
      gateway().handle(request({ run: { ...SESSION.run, epoch: 8 } })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    await expect(gateway().handle(request({ method: 'artifact.upload' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    await expect(gateway().handle(request({ target: 'another-run' }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
  });

  it('rejects replayed, skipped, and duplicate-nonce messages', async () => {
    const instance = gateway();
    await expect(instance.handle(request())).resolves.toMatchObject({ ok: true });
    await expect(instance.handle(request())).resolves.toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    await expect(
      instance.handle(request({ sequence: 3, nonce: 'qrstuvwxyzABCDEF' })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await expect(
      instance.handle(request({ sequence: 2, nonce: 'abcdefghijklmnop' })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await expect(
      instance.handle(request({ sequence: 2, nonce: 'qrstuvwxyzABCDEF' })),
    ).resolves.toMatchObject({ ok: true });
  });

  it('rejects expired sessions/deadlines and future deadline windows', async () => {
    await expect(
      gateway().handle(request({ deadline: '2026-07-23T09:59:59.000Z' })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    await expect(
      gateway().handle(request({ deadline: '2026-07-23T10:01:00.000Z' })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID' } });
    await expect(
      gateway({
        resolveSession: async () => ({ ...SESSION, expiresAt: '2026-07-23T09:59:59.000Z' }),
      }).handle(request()),
    ).resolves.toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
  });

  it('enforces method payload, response, and per-session rate bounds', async () => {
    await expect(
      gateway().handle(request({ payload: { value: 'x'.repeat(2000) } })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID' } });
    await expect(
      gateway({
        maxResponseBytes: 8,
        dispatch: async () => ({ tooLarge: true }),
      }).handle(request()),
    ).resolves.toMatchObject({ ok: false, error: { code: 'EXHAUSTED' } });

    const limited = gateway({ maxRequestsPerMinute: 1 });
    await expect(limited.handle(request())).resolves.toMatchObject({ ok: true });
    await expect(
      limited.handle(request({ sequence: 2, nonce: 'qrstuvwxyzABCDEF' })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'EXHAUSTED' } });
  });

  it('keeps artifact uploads in their dedicated quota while ordinary methods share the aggregate quota', async () => {
    const artifactSession = {
      ...SESSION,
      allowedMethods: [...SESSION.allowedMethods, 'artifact.upload' as const],
    };
    const instance = gateway({
      maxRequestsPerMinute: 2,
      methodRequestsPerMinute: { 'artifact.upload': 5 },
      resolveSession: async () => artifactSession,
    });
    await expect(instance.handle(request())).resolves.toMatchObject({ ok: true });
    await expect(
      instance.handle(
        request({
          sequence: 2,
          nonce: 'artifactNonce001',
          method: 'artifact.upload',
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      instance.handle(
        request({
          sequence: 3,
          nonce: 'artifactNonce002',
          method: 'artifact.upload',
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      instance.handle(
        request({
          sequence: 4,
          nonce: 'controlNonce0001',
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      instance.handle(
        request({
          sequence: 5,
          nonce: 'controlNonce0002',
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'EXHAUSTED' } });

    const methodLimited = gateway({
      maxRequestsPerMinute: 3,
      methodRequestsPerMinute: { 'artifact.upload': 1 },
      resolveSession: async () => artifactSession,
    });
    await expect(
      methodLimited.handle(request({ method: 'artifact.upload' })),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      methodLimited.handle(
        request({
          sequence: 2,
          nonce: 'artifactNonce001',
          method: 'artifact.upload',
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'EXHAUSTED' } });
    await expect(
      methodLimited.handle(
        request({
          sequence: 3,
          nonce: 'controlNonce0001',
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      methodLimited.handle(
        request({
          sequence: 4,
          nonce: 'controlNonce0002',
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      methodLimited.handle(
        request({
          sequence: 5,
          nonce: 'controlNonce0003',
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      methodLimited.handle(
        request({
          sequence: 6,
          nonce: 'controlNonce0004',
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'EXHAUSTED' } });
  });

  it('allows a 100 MiB artifact upload at the default quotas and still bounds its chunk rate', async () => {
    const artifactSession = {
      ...SESSION,
      allowedMethods: [...SESSION.allowedMethods, 'artifact.upload' as const],
    };
    const chunkBytes = 640 * 1024;
    const artifactBytes = 100 * 1024 * 1024;
    const chunkCount = Math.ceil(artifactBytes / chunkBytes);
    let uploadedBytes = 0;
    const instance = gateway({
      resolveSession: async () => artifactSession,
      dispatch: async ({ payload }) => {
        const byteLength = (payload as { byteLength?: number }).byteLength ?? 0;
        uploadedBytes += byteLength;
        return { accepted: true };
      },
    });

    for (let index = 0; index < chunkCount; index += 1) {
      const remaining = artifactBytes - index * chunkBytes;
      const byteLength = Math.min(chunkBytes, remaining);
      await expect(
        instance.handle(
          request({
            requestId: `artifact-chunk-${index}`,
            sequence: index + 1,
            nonce: `artifactChunkNonce${String(index).padStart(4, '0')}`,
            method: 'artifact.upload',
            payload: { operation: 'chunk', byteLength },
          }),
        ),
      ).resolves.toMatchObject({ ok: true });
    }

    expect(chunkCount).toBe(160);
    expect(uploadedBytes).toBe(artifactBytes);

    const methodLimited = gateway({
      methodRequestsPerMinute: { 'artifact.upload': chunkCount },
      resolveSession: async () => artifactSession,
    });
    for (let index = 0; index < chunkCount; index += 1) {
      await expect(
        methodLimited.handle(
          request({
            requestId: `bounded-artifact-chunk-${index}`,
            sequence: index + 1,
            nonce: `boundedChunkNonce${String(index).padStart(4, '0')}`,
            method: 'artifact.upload',
            payload: { operation: 'chunk', byteLength: chunkBytes },
          }),
        ),
      ).resolves.toMatchObject({ ok: true });
    }
    await expect(
      methodLimited.handle(
        request({
          requestId: 'bounded-artifact-over-limit',
          sequence: chunkCount + 1,
          nonce: 'boundedChunkNonceOverLimit',
          method: 'artifact.upload',
          payload: { operation: 'chunk', byteLength: 1 },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'EXHAUSTED' } });
  });

  it('bounds active rate-limit state and reclaims expired session buckets under churn', async () => {
    let current = NOW.getTime();
    const artifactSession = {
      ...SESSION,
      allowedMethods: [...SESSION.allowedMethods, 'artifact.upload' as const],
    };
    const instance = gateway({
      maxRateLimitBuckets: 2,
      now: () => new Date(current),
      resolveSession: async (sessionName) => ({ ...artifactSession, name: sessionName }),
    });
    await expect(
      instance.handle(
        request({
          sessionName: 'session-churn-1',
          method: 'artifact.upload',
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      instance.handle(
        request({
          sessionName: 'session-churn-2',
          method: 'artifact.upload',
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      instance.handle(
        request({
          sessionName: 'session-churn-3',
          method: 'artifact.upload',
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'EXHAUSTED' } });

    current += 60_001;
    await expect(
      instance.handle(
        request({
          sessionName: 'session-churn-2',
          sequence: 2,
          nonce: 'churnNonce000002',
          deadline: new Date(current + 10_000).toISOString(),
          method: 'artifact.upload',
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it('rejects invalid configured worker rate limits at gateway creation', () => {
    expect(() => gateway({ maxRequestsPerMinute: 0 })).toThrow(TypeError);
    expect(() => gateway({ maxRateLimitBuckets: 0 })).toThrow(TypeError);
    expect(() => gateway({ maxRateLimitBuckets: 1 })).toThrow(TypeError);
    expect(() => gateway({ methodRequestsPerMinute: { 'artifact.upload': -1 } })).toThrow(
      TypeError,
    );
    expect(() =>
      gateway({
        methodRequestsPerMinute: { 'unknown.method': 1 } as never,
      })
    ).toThrow(TypeError);
  });

  it('fails closed after replay state loss when a session resumes above sequence one', async () => {
    const restarted = gateway({ replayProtector: createInMemoryWorkerReplayProtector() });
    await expect(restarted.handle(request({ sequence: 9 }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
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

  it('composes client disconnect and deadline cancellation through dispatch', async () => {
    const client = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let dispatchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const dispatch = vi.fn(({ signal }: { signal: AbortSignal }) => {
      observedSignal = signal;
      dispatchStarted();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(
              signal.reason instanceof Error ? signal.reason : new Error('worker dispatch aborted'),
            );
          },
          { once: true },
        );
      });
    });
    const pending = gateway({ dispatch }).handle(request(), client.signal);
    await started;
    client.abort(new Error('client disconnected'));
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE' },
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('aborts an in-flight dispatch when the durable session is revoked', async () => {
    const revoked = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let dispatchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const dispatch = vi.fn(({ signal }: { signal: AbortSignal }) => {
      observedSignal = signal;
      dispatchStarted();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(
              signal.reason instanceof Error ? signal.reason : new Error('worker dispatch aborted'),
            );
          },
          { once: true },
        );
      });
    });
    const pending = gateway({
      dispatch,
      resolveSession: async () => ({ ...SESSION, revocationSignal: revoked.signal }),
    }).handle(request());
    await started;
    revoked.abort(
      new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'worker session was revoked',
        retryable: false,
      }),
    );
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('fails a dispatch that ignores an expired deadline after it returns', async () => {
    const dispatch = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(signal.aborted).toBe(true);
      return { late: true };
    });
    const response = await gateway({
      dispatch,
      now: () => NOW,
    }).handle(request({ deadline: '2026-07-23T10:00:00.001Z' }));
    expect(response).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
  });
});
