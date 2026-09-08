import { describe, expect, it, vi } from 'vitest';

import { ProviderRegistry } from '../llm/providerRegistry.js';
import type { AgentLoopGenerator } from '../loopAPI/types.js';
import { createMissingApiKeyAgentRunError, MemoryAgentRunStateStore } from '../runState.js';
import { createMemeLoopRuntime, type MemeLoopRuntime, type MemeLoopRuntimeShutdownError } from '../runtime.js';
import type { AgentFrameworkContext } from '../types.js';
import { createTestStorage } from './testStorage.js';

function context(
  runAgentToolLoop: NonNullable<AgentFrameworkContext['runAgentToolLoop']>,
): AgentFrameworkContext {
  return {
    storage: createTestStorage(),
    localNodeId: 'local-test-node',
    llmProvider: { name: 'injected-test-runner', chat: vi.fn() },
    tools: { registerTool: vi.fn(), getTool: vi.fn(), listTools: () => [] },
    syncAdapters: [],
    network: { start: vi.fn(), stop: vi.fn() },
    runAgentToolLoop,
  };
}

async function waitForState(
  runtime: MemeLoopRuntime,
  runId: string,
  expected: 'accepted' | 'queued' | 'running' | 'completed' | 'cancelled' | 'failed',
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await runtime.getRunStatus(runId))?.state === expected) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(`run ${runId} did not reach ${expected}`);
}

describe('MemeLoopRuntime lifecycle serialization', () => {
  it('serializes accepted runs for one conversation in durable FIFO order', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const runtime = createMemeLoopRuntime(
      context(async function*(input) {
        order.push(`start:${input.message}`);
        if (input.message === 'first') await firstGate;
        order.push(`end:${input.message}`);
        yield* [];
      }),
      { runStateStore: new MemoryAgentRunStateStore() },
    );

    const first = await runtime.sendMessage({
      conversationId: 'fifo-conversation',
      definitionId: 'definition',
      message: 'first',
      requestId: 'fifo-request-1',
      turnId: 'fifo-turn-1',
    });
    const second = await runtime.sendMessage({
      conversationId: 'fifo-conversation',
      definitionId: 'definition',
      message: 'second',
      requestId: 'fifo-request-2',
      turnId: 'fifo-turn-2',
    });
    await waitForState(runtime, first.runId, 'running');
    expect((await runtime.getRunStatus(second.runId))?.state).toBe('accepted');
    releaseFirst();
    await waitForState(runtime, first.runId, 'completed');
    await waitForState(runtime, second.runId, 'completed');
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    await runtime.dispose();
  });

  it('allows different conversations to run in parallel', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const started = new Set<string>();
    const runtime = createMemeLoopRuntime(
      context(async function*(input) {
        started.add(input.conversationId);
        await gate;
        yield* [];
      }),
      { runStateStore: new MemoryAgentRunStateStore() },
    );
    const first = await runtime.sendMessage({
      conversationId: 'parallel-a',
      definitionId: 'definition',
      message: 'a',
      requestId: 'parallel-request-a',
      turnId: 'parallel-turn-a',
    });
    const second = await runtime.sendMessage({
      conversationId: 'parallel-b',
      definitionId: 'definition',
      message: 'b',
      requestId: 'parallel-request-b',
      turnId: 'parallel-turn-b',
    });
    await waitForState(runtime, first.runId, 'running');
    await waitForState(runtime, second.runId, 'running');
    expect(started).toEqual(new Set(['parallel-a', 'parallel-b']));
    release();
    await waitForState(runtime, first.runId, 'completed');
    await waitForState(runtime, second.runId, 'completed');
    await runtime.dispose();
  });

  it('logs sanitized loop-failure diagnostics correlated with the durable run', async () => {
    const caller = context(async function*() {
      const failure = new Error('provider payload must never be logged: sk-secret-first\nsk-secret-second');
      Object.defineProperty(failure, 'name', { value: 'sk-secret-error-type' });
      Object.defineProperty(failure, 'stack', {
        value: [
          'Error: sk-secret-first',
          'sk-secret-second',
          `    at oversized (/${'x'.repeat(300)}.ts:1:1)`,
          ...Array.from({ length: 8 }, (_, index) => `    at safe (/safe-${index}.ts:${index + 1}:1)`),
        ].join('\n'),
      });
      throw failure;
      yield undefined as never;
    });
    const error = vi.fn();
    caller.logger = { error };
    const runtime = createMemeLoopRuntime(caller, {
      runStateStore: new MemoryAgentRunStateStore(),
    });

    const run = await runtime.sendMessage({
      conversationId: 'failure-diagnostic-conversation',
      definitionId: 'definition',
      message: 'safe user message',
      requestId: 'failure-diagnostic-request',
      turnId: 'failure-diagnostic-turn',
    });
    await waitForState(runtime, run.runId, 'failed');

    const status = await runtime.getRunStatus(run.runId);
    expect(status?.error?.diagnosticId).toBeDefined();
    expect(error).toHaveBeenCalledWith('MemeLoopRuntime agent loop failed', {
      conversationId: 'failure-diagnostic-conversation',
      runId: run.runId,
      diagnosticId: status?.error?.diagnosticId,
      errorType: 'Error',
      stackFrames: expect.arrayContaining([expect.stringMatching(/^at /u)]),
    });
    const metadata = error.mock.calls[0]?.[1] as { stackFrames?: string[] };
    expect(metadata.stackFrames).toHaveLength(6);
    expect(metadata.stackFrames?.every(frame => new TextEncoder().encode(frame).byteLength <= 259)).toBe(true);
    expect(JSON.stringify(error.mock.calls)).not.toContain('sk-secret');
    await runtime.dispose();
  });

  it('persists the loop failure when its diagnostic logger throws', async () => {
    const caller = context(async function*() {
      throw new Error('original loop failure');
      yield undefined as never;
    });
    caller.logger = {
      error: () => {
        throw new Error('logger failure');
      },
    };
    const runtime = createMemeLoopRuntime(caller, {
      runStateStore: new MemoryAgentRunStateStore(),
    });

    const run = await runtime.sendMessage({
      conversationId: 'logger-failure-conversation',
      definitionId: 'definition',
      message: 'safe user message',
      requestId: 'logger-failure-request',
      turnId: 'logger-failure-turn',
    });
    await waitForState(runtime, run.runId, 'failed');
    expect((await runtime.getRunStatus(run.runId))?.error?.code).toBe('INTERNAL');
    await runtime.dispose();
  });

  it('cancels a queued same-conversation run and advances the FIFO', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const executed: string[] = [];
    const runtime = createMemeLoopRuntime(
      context(async function*(input) {
        executed.push(input.message);
        if (input.message === 'first') await firstGate;
        yield* [];
      }),
      { runStateStore: new MemoryAgentRunStateStore() },
    );
    const first = await runtime.sendMessage({
      conversationId: 'cancel-queue',
      definitionId: 'definition',
      message: 'first',
      requestId: 'cancel-queue-request-1',
      turnId: 'cancel-queue-turn-1',
    });
    const cancelled = await runtime.sendMessage({
      conversationId: 'cancel-queue',
      definitionId: 'definition',
      message: 'cancelled',
      requestId: 'cancel-queue-request-2',
      turnId: 'cancel-queue-turn-2',
    });
    const third = await runtime.sendMessage({
      conversationId: 'cancel-queue',
      definitionId: 'definition',
      message: 'third',
      requestId: 'cancel-queue-request-3',
      turnId: 'cancel-queue-turn-3',
    });
    await waitForState(runtime, first.runId, 'running');
    expect(await runtime.cancelRun(cancelled.runId)).toBe(true);
    releaseFirst();
    await waitForState(runtime, first.runId, 'completed');
    await waitForState(runtime, third.runId, 'completed');
    expect(executed).toEqual(['first', 'third']);
    expect((await runtime.getRunStatus(cancelled.runId))?.state).toBe('cancelled');
    await runtime.dispose();
  });

  it('cooperatively aborts and closes active generators before dispose resolves', async () => {
    const closed = vi.fn();
    const store = new MemoryAgentRunStateStore();
    const runtime = createMemeLoopRuntime(
      context(async function*(input) {
        try {
          await new Promise<void>((resolve) => {
            input.signal?.addEventListener('abort', () => {
              resolve();
            }, { once: true });
          });
        } finally {
          closed();
        }
        yield* [];
      }),
      { runStateStore: store, disposeTimeoutMs: 100 },
    );
    const run = await runtime.sendMessage({
      conversationId: 'dispose-cooperative',
      definitionId: 'definition',
      message: 'wait',
      requestId: 'dispose-request',
      turnId: 'dispose-turn',
    });
    await waitForState(runtime, run.runId, 'running');
    await runtime.dispose();
    expect(closed).toHaveBeenCalledTimes(1);
    expect((await store.get(run.runId))?.state).toBe('cancelled');
    await expect(runtime.sendMessage({
      conversationId: 'dispose-cooperative',
      definitionId: 'definition',
      message: 'late',
    })).rejects.toThrow('disposed');
  });

  it('fails dispose explicitly and exactly once when iterator.return ignores cancellation', async () => {
    const pending = new Promise<IteratorResult<never>>(() => undefined);
    const returnIterator = vi.fn(() => pending);
    const iterator = {
      next: vi.fn(() => pending),
      return: returnIterator,
      [Symbol.asyncIterator]() {
        return this;
      },
    } as unknown as AgentLoopGenerator;
    const runtime = createMemeLoopRuntime(context(() => iterator), {
      runStateStore: new MemoryAgentRunStateStore(),
      disposeTimeoutMs: 20,
    });
    const run = await runtime.sendMessage({
      conversationId: 'dispose-hung',
      definitionId: 'definition',
      message: 'hang',
      requestId: 'hung-request',
      turnId: 'hung-turn',
    });
    await waitForState(runtime, run.runId, 'running');
    const firstDispose = runtime.dispose();
    const secondDispose = runtime.dispose();
    expect(secondDispose).toBe(firstDispose);
    await expect(firstDispose).rejects.toMatchObject(
      {
        name: 'MemeLoopRuntimeShutdownError',
        code: 'SHUTDOWN_TIMEOUT',
      } satisfies Partial<MemeLoopRuntimeShutdownError>,
    );
    expect(returnIterator).toHaveBeenCalledOnce();
    await expect(runtime.getRunStatus(run.runId)).rejects.toThrow('disposed');
  });

  it('bounds shutdown while an admitted public operation is still pending', async () => {
    const storage = createTestStorage(undefined, {
      getConversationMeta: vi.fn(() => new Promise<null>(() => undefined)),
    });
    const caller = context(async function*() {});
    caller.storage = storage;
    const runtime = createMemeLoopRuntime(caller, {
      runStateStore: new MemoryAgentRunStateStore(),
      disposeTimeoutMs: 20,
    });
    const pendingSend = runtime.sendMessage({
      conversationId: 'pending-operation',
      definitionId: 'definition',
      message: 'pending',
    });
    void pendingSend.catch(() => undefined);
    await expect(runtime.dispose()).rejects.toMatchObject({
      code: 'SHUTDOWN_TIMEOUT',
    });
    await expect(runtime.sendMessage({
      conversationId: 'pending-operation',
      definitionId: 'definition',
      message: 'late',
    })).rejects.toThrow('disposed');
  });

  it('surfaces run-state list failures as typed shutdown failures after cleanup', async () => {
    class FailingListStore extends MemoryAgentRunStateStore {
      listCalls = 0;

      override async listActive() {
        this.listCalls += 1;
        if (this.listCalls > 1) throw new Error('unsafe backend details');
        return super.listActive();
      }
    }
    const store = new FailingListStore();
    const runtime = createMemeLoopRuntime(context(async function*() {}), {
      runStateStore: store,
    });
    await expect(runtime.dispose()).rejects.toMatchObject({
      name: 'MemeLoopRuntimeShutdownError',
      code: 'SHUTDOWN_FAILED',
      message: 'MemeLoopRuntime shutdown failed',
    });
    await expect(runtime.getRunStatus('unknown-run')).rejects.toThrow('disposed');
  });

  it('surfaces durable cancellation transition failures after closing active work', async () => {
    class FailingTransitionStore extends MemoryAgentRunStateStore {
      failTransitions = false;

      override async transition(...args: Parameters<MemoryAgentRunStateStore['transition']>) {
        if (this.failTransitions) throw new Error('unsafe backend details');
        return super.transition(...args);
      }
    }
    const store = new FailingTransitionStore();
    const closed = vi.fn();
    const runtime = createMemeLoopRuntime(
      context(async function*(input) {
        try {
          await new Promise<void>(resolve => {
            input.signal?.addEventListener('abort', () => {
              resolve();
            }, { once: true });
          });
        } finally {
          closed();
        }
        yield* [];
      }),
      { runStateStore: store, disposeTimeoutMs: 100 },
    );
    const run = await runtime.sendMessage({
      conversationId: 'transition-failure',
      definitionId: 'definition',
      message: 'wait',
    });
    await waitForState(runtime, run.runId, 'running');
    store.failTransitions = true;
    await expect(runtime.dispose()).rejects.toMatchObject({
      code: 'SHUTDOWN_FAILED',
    });
    expect(closed).toHaveBeenCalledOnce();
    await expect(runtime.cancelRun(run.runId)).rejects.toThrow('disposed');
  });

  it('copies caller cancellation state instead of mutating shared context sets', async () => {
    const caller = context(async function*() {});
    const conversationCancellation = new Set(['caller-conversation']);
    const runCancellation = new Set(['caller-run']);
    caller.conversationCancellation = conversationCancellation;
    caller.runCancellation = runCancellation;
    const runtime = createMemeLoopRuntime(caller, {
      runStateStore: new MemoryAgentRunStateStore(),
    });

    await runtime.cancelAgent('runtime-conversation');
    expect(conversationCancellation).toEqual(new Set(['caller-conversation']));
    expect(runCancellation).toEqual(new Set(['caller-run']));
    await runtime.dispose();
    expect(caller.conversationCancellation).toBe(conversationCancellation);
    expect(caller.runCancellation).toBe(runCancellation);
    expect(conversationCancellation).toEqual(new Set(['caller-conversation']));
    expect(runCancellation).toEqual(new Set(['caller-run']));
  });

  it('uses the strong id factory for same-millisecond conversation creation', async () => {
    const ids = ['runtime-id-value', 'conversation-id-one', 'conversation-id-two'];
    const runtime = createMemeLoopRuntime(context(async function*() {}), {
      runStateStore: new MemoryAgentRunStateStore(),
      idFactory: () => ids.shift()!,
    });
    const [first, second] = await Promise.all([
      runtime.createAgent({ definitionId: 'definition' }),
      runtime.createAgent({ definitionId: 'definition' }),
    ]);
    expect(first.conversationId).toBe('conversation:conversation-id-one');
    expect(second.conversationId).toBe('conversation:conversation-id-two');
    await runtime.dispose();
  });

  it('preflights the exact model route before creating a durable run', async () => {
    const provider = { name: 'exact-provider', chat: vi.fn() };
    const providers = new ProviderRegistry();
    providers.register(
      { ownerId: 'test-host', kind: 'host' },
      provider,
      {
        models: [{
          modelId: 'logical-model',
          wireModelId: 'wire-model-v2',
          apiMode: 'responses',
        }],
      },
    );
    const storage = createTestStorage(undefined, {
      getAgentDefinition: vi.fn(async id =>
        id === 'exact-definition'
          ? {
            id,
            name: 'Exact definition',
            description: 'Exact route test profile',
            systemPrompt: 'Stay exact.',
            tools: [],
            modelConfig: { providerId: 'exact-provider', modelId: 'logical-model' },
            version: '1',
          }
          : null
      ),
    });
    const preflightAgentRun = vi.fn(async () =>
      createMissingApiKeyAgentRunError({
        providerId: 'exact-provider',
        modelId: 'logical-model',
        diagnosticId: 'missing-key-test',
      })
    );
    const store = new MemoryAgentRunStateStore();
    const createOrGet = vi.spyOn(store, 'createOrGet');
    const runtime = createMemeLoopRuntime({
      storage,
      localNodeId: 'local-test-node',
      llmProvider: provider,
      modelProviderRegistry: providers,
      preflightAgentRun,
      tools: { registerTool: vi.fn(), getTool: vi.fn(), listTools: () => [] },
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
    }, { runStateStore: store });

    await expect(runtime.sendMessage({
      conversationId: 'exact-conversation',
      definitionId: 'exact-definition',
      message: 'do not accept this run',
      requestId: 'exact-request',
      turnId: 'exact-turn',
    })).rejects.toMatchObject({
      name: 'AgentRunFailure',
      agentRunError: {
        code: 'PROVIDER_AUTH_MISSING',
        providerId: 'exact-provider',
        modelId: 'logical-model',
      },
    });
    expect(preflightAgentRun).toHaveBeenCalledOnce();
    expect(preflightAgentRun).toHaveBeenCalledWith({
      conversationId: 'exact-conversation',
      definitionId: 'exact-definition',
      providerId: 'exact-provider',
      modelId: 'logical-model',
      wireModelId: 'wire-model-v2',
      apiMode: 'responses',
    });
    expect(createOrGet).not.toHaveBeenCalled();
    expect(await store.listActive()).toEqual([]);
    await runtime.dispose();
  });
});
