import { describe, expect, it, vi } from 'vitest';

import type { AgentFrameworkContext, IAgentStorage } from '../../types.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import type { LoopRuntimePreparePayload } from '../drivers/loopRuntimeManagement.js';
import { createManagedLoopRuntimeAdapter } from '../drivers/managedLoopRuntimeAdapter.js';
import { OrchestrationError } from '../errors.js';
import { createInProcessLoopRuntimeDriver, type LoopRunOutcome, type LoopRunStartRequest, type LoopRuntimeDriver } from '../loopRuntimeDriver.js';

const now = () => new Date('2026-07-26T12:00:00.000Z');

function envelope<T>(
  method: string,
  payload: T,
  idempotencyKey: string,
  resourceUid = 'run-uid-1',
  fencingEpoch = 1,
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'execution.memeloop.io/v1alpha1',
      kind: 'AgentRun',
      name: 'run-1',
      uid: resourceUid,
      generation: 1,
    },
    run: { uid: resourceUid, attempt: 1 },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-26T12:01:00.000Z',
    actor: { id: 'controller/runtime', kind: 'controller' },
    capabilityHandleRef: 'capability:runtime-1',
    trace: { traceId: 'trace-1', spanId: idempotencyKey },
    payloadSchemaDigest: `sha256:${'f'.repeat(64)}`,
    payload,
  };
}

function preparePayload(): LoopRuntimePreparePayload {
  return {
    runtimeClass: 'restricted-process',
    runtimeDigest: `sha256:${'a'.repeat(64)}`,
    isolation: 'process',
    trustClass: 'restricted',
  };
}

function resolvedStartRequest(): LoopRunStartRequest {
  return {
    workload: {
      apiVersion: 'execution.memeloop.io/v1alpha1',
      kind: 'AgentWorkload',
      metadata: {
        name: 'workload-1',
        uid: 'workload-uid-1',
        generation: 1,
        resourceVersion: '1',
        creationTimestamp: '2026-07-26T12:00:00.000Z',
      },
      spec: { profileId: 'profile-1' },
    },
    run: {
      apiVersion: 'execution.memeloop.io/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        name: 'run-1',
        uid: 'run-uid-1',
        generation: 1,
        resourceVersion: '1',
        creationTimestamp: '2026-07-26T12:00:00.000Z',
      },
      spec: {
        workloadRef: {
          apiVersion: 'execution.memeloop.io/v1alpha1',
          kind: 'AgentWorkload',
          name: 'workload-1',
          uid: 'workload-uid-1',
        },
        attempt: 1,
      },
    },
  };
}

function frameworkContext(): AgentFrameworkContext {
  const storage: IAgentStorage = {
    async listConversations() {
      return [];
    },
    async getMessages() {
      return [];
    },
    async appendMessage() {},
    async upsertConversationMetadata() {},
    async insertMessagesIfAbsent() {},
    async getAttachment() {
      return null;
    },
    async saveAttachment() {},
    async getAgentDefinition() {
      return null;
    },
    async saveAgentInstance() {},
    async getConversationMeta() {
      return null;
    },
  };
  return {
    storage,
    llmProvider: { name: 'dummy', chat: async () => undefined } as never,
    tools: { registerTool: () => {}, getTool: () => undefined, listTools: () => [] } as never,
    syncAdapters: [],
    network: { start: async () => {}, stop: async () => {} },
    loopScriptPolicy: {
      allowSource: true,
      scriptLoadGate: {
        admitScriptLoad: () => ({ allowed: true, trustClass: 'trusted' as const }),
      },
    },
  };
}

describe('managed production Loop Runtime adapter', () => {
  it('drives the real in-process runtime through the managed lifecycle', async () => {
    const startRequest = resolvedStartRequest();
    startRequest.workload.spec = {
      scriptReference: `sha256:${'1'.repeat(64)}`,
    };
    startRequest.scriptSource = 'export default async function* run() { yield { type: "message", data: "managed-ok" }; }';
    const adapter = createManagedLoopRuntimeAdapter(
      createInProcessLoopRuntimeDriver(frameworkContext()),
      {
        now,
        capabilities: {
          name: 'in-process-runtime',
          isolation: ['none'],
          supportedTrustClasses: ['trusted'],
          supportsCheckpoint: false,
          supportsRestore: false,
          supportsAdoption: false,
          persistence: 'process',
          threatAssumptions: ['the trusted daemon remains alive'],
        },
        resolveStartRequest: async () => startRequest,
      },
    );
    const payload: LoopRuntimePreparePayload = {
      ...preparePayload(),
      isolation: 'none',
      trustClass: 'trusted',
    };
    const prepared = await adapter.prepare(envelope('loop.prepare', payload, 'real-prepare'));
    const running = await adapter.start(envelope('loop.start', prepared, 'real-start'));
    const events = [];
    for await (
      const status of adapter.watch(envelope(
        'loop.watch',
        { runHandle: running.runHandle },
        'real-watch',
      ))
    ) {
      events.push(status.phase);
    }
    expect(events.at(-1)).toBe('Completed');
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('prepares, starts idempotently, watches, inspects, and deletes a real execution handle', async () => {
    let finish!: (outcome: LoopRunOutcome) => void;
    const outcome = new Promise<LoopRunOutcome>((resolve) => {
      finish = resolve;
    });
    const cancel = vi.fn(async () => {
      finish({ phase: 'Cancelled' });
    });
    const start = vi.fn(async () => ({ wait: () => outcome, cancel }));
    const narrow: LoopRuntimeDriver = { start };
    const adapter = createManagedLoopRuntimeAdapter(narrow, {
      now,
      capabilities: {
        name: 'process-runtime',
        isolation: ['process'],
        supportedTrustClasses: ['trusted', 'restricted'],
        supportsCheckpoint: false,
        supportsRestore: false,
        supportsAdoption: false,
        persistence: 'process',
        threatAssumptions: ['the trusted daemon remains alive'],
      },
      resolveStartRequest: async () => resolvedStartRequest(),
    });

    const prepared = await adapter.prepare(envelope('loop.prepare', preparePayload(), 'prepare-1'));
    const first = await adapter.start(envelope('loop.start', prepared, 'start-1'));
    const duplicate = await adapter.start(envelope('loop.start', prepared, 'start-1'));
    expect(duplicate.runHandle).toBe(first.runHandle);
    expect(start).toHaveBeenCalledOnce();
    expect((await adapter.inspect(envelope('loop.inspect', { runHandle: first.runHandle }, 'inspect-1')))?.phase).toBe('Running');

    const watcher = adapter.watch(envelope(
      'loop.watch',
      { runHandle: first.runHandle },
      'watch-1',
    ))[Symbol.asyncIterator]();
    expect((await watcher.next()).value).toMatchObject({ phase: 'Running' });
    const cancelled = await adapter.cancel(envelope('loop.cancel', { runHandle: first.runHandle }, 'cancel-1'));
    expect(cancelled.phase).toBe('Cancelled');
    expect((await watcher.next()).value).toMatchObject({ phase: 'Cancelled' });
    expect(cancel).toHaveBeenCalledOnce();
    await adapter.delete(envelope('loop.delete', { runHandle: first.runHandle }, 'delete-1'));
    await adapter.delete(envelope('loop.delete', { runHandle: first.runHandle }, 'delete-1'));
    expect(await adapter.inspect(envelope('loop.inspect', { runHandle: first.runHandle }, 'inspect-2'))).toBeUndefined();
  });

  it('bounds watch and cancellation waits by the request deadline', async () => {
    vi.useFakeTimers();
    try {
      const narrow: LoopRuntimeDriver = {
        start: async () => ({
          wait: () => new Promise<LoopRunOutcome>(() => {}),
          cancel: async () => {},
        }),
      };
      const adapter = createManagedLoopRuntimeAdapter(narrow, {
        now,
        capabilities: {
          name: 'process-runtime',
          isolation: ['process'],
          supportedTrustClasses: ['restricted'],
          supportsCheckpoint: false,
          supportsRestore: false,
          supportsAdoption: false,
          persistence: 'process',
          threatAssumptions: ['the trusted daemon remains alive'],
        },
        resolveStartRequest: async () => resolvedStartRequest(),
      });
      const prepared = await adapter.prepare(envelope('loop.prepare', preparePayload(), 'prepare-timeout'));
      const running = await adapter.start(envelope('loop.start', prepared, 'start-timeout'));
      const cancellation = adapter.cancel({
        ...envelope('loop.cancel', { runHandle: running.runHandle }, 'cancel-timeout'),
        deadline: '2026-07-26T12:00:00.010Z',
      });
      const rejection = expect(cancellation).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects capability declarations that overstate the narrow adapter', () => {
    const narrow: LoopRuntimeDriver = {
      start: async () => ({
        wait: async () => ({ phase: 'Completed' }),
        cancel: async () => {},
      }),
    };
    expect(() =>
      createManagedLoopRuntimeAdapter(narrow, {
        now,
        capabilities: {
          name: 'dishonest-runtime',
          isolation: ['process'],
          supportedTrustClasses: ['restricted'],
          supportsCheckpoint: false,
          supportsRestore: false,
          supportsAdoption: true,
          persistence: 'host',
          threatAssumptions: [],
        },
        resolveStartRequest: async () => resolvedStartRequest(),
      })
    ).toThrowError(OrchestrationError);
  });

  it('fails closed for unsupported durable operations, stale epochs, scope mismatch, and resolver identity drift', async () => {
    const narrow: LoopRuntimeDriver = {
      start: vi.fn(async () => ({
        wait: async () => ({ phase: 'Completed' }),
        cancel: async () => {},
      })),
    };
    const adapter = createManagedLoopRuntimeAdapter(narrow, {
      now,
      capabilities: {
        name: 'in-process-runtime',
        isolation: ['none'],
        supportedTrustClasses: ['trusted'],
        supportsCheckpoint: false,
        supportsRestore: false,
        supportsAdoption: false,
        persistence: 'process',
        threatAssumptions: ['the trusted daemon remains alive'],
      },
      resolveStartRequest: async () => resolvedStartRequest(),
    });
    await expect(adapter.prepare(envelope('loop.prepare', preparePayload(), 'wrong-isolation')))
      .rejects.toMatchObject({ code: 'UNSUPPORTED' });

    const trustedPayload: LoopRuntimePreparePayload = {
      ...preparePayload(),
      isolation: 'none',
      trustClass: 'trusted',
    };
    const prepared = await adapter.prepare(envelope('loop.prepare', trustedPayload, 'prepare-2', 'run-uid-1', 3));
    const running = await adapter.start(envelope('loop.start', prepared, 'start-2', 'run-uid-1', 3));
    await expect(adapter.inspect(envelope(
      'loop.inspect',
      { runHandle: running.runHandle },
      'stale',
      'run-uid-1',
      2,
    ))).rejects.toMatchObject({ code: 'STALE_EPOCH' });
    await expect(adapter.inspect(envelope(
      'loop.inspect',
      { runHandle: running.runHandle },
      'other',
      'other-run-uid',
      3,
    ))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(adapter.checkpoint(envelope(
      'loop.checkpoint',
      { runHandle: running.runHandle },
      'checkpoint',
      'run-uid-1',
      3,
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(adapter.adopt(envelope(
      'loop.adopt',
      { runHandle: running.runHandle },
      'adopt',
      'run-uid-1',
      3,
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED' });

    const drifting = createManagedLoopRuntimeAdapter(narrow, {
      now,
      capabilities: {
        name: 'in-process-runtime',
        isolation: ['none'],
        supportedTrustClasses: ['trusted'],
        supportsCheckpoint: false,
        supportsRestore: false,
        supportsAdoption: false,
        persistence: 'process',
        threatAssumptions: ['the trusted daemon remains alive'],
      },
      resolveStartRequest: async () => ({
        ...resolvedStartRequest(),
        run: {
          ...resolvedStartRequest().run,
          metadata: { ...resolvedStartRequest().run.metadata, uid: 'wrong-run' },
        },
      }),
    });
    await expect(drifting.prepare(envelope('loop.prepare', trustedPayload, 'drift')))
      .rejects.toBeInstanceOf(OrchestrationError);
  });
});
