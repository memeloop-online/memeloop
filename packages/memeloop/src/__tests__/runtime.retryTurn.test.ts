import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ConversationEvent } from '../conversation/index.js';
import { type AgentRunStateStore, MemoryAgentRunStateStore } from '../runState.js';
import { createMemeLoopRuntime, type MemeLoopRunState, type MemeLoopRuntime } from '../runtime.js';
import {
  assertAtomicAgentRetrySourceMessage,
  assertAtomicAgentRetryStoreConformance,
  type AtomicAgentRetryInput,
  type AtomicAgentRetryStore,
  createAtomicAgentRetryEventDrafts,
  createAtomicAgentRetryReplacementPayload,
  digestAtomicAgentRetryPayload,
} from '../storage/atomicAgentRetry.js';
import type { AgentFrameworkContext, FullAgentStorage } from '../types.js';
import { createTestStorage, type TestStorage } from './testStorage.js';

const CONVERSATION_ID = 'conversation-retry';
const DEFINITION_ID = 'definition-retry';
const SOURCE_TURN_ID = 'turn-source';
const NEW_TURN_ID = 'turn-replacement';

async function* emptyAgentToolLoop() {
  yield* [];
}

function sourceUserMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    messageId: SOURCE_TURN_ID,
    turnId: SOURCE_TURN_ID,
    conversationId: CONVERSATION_ID,
    originNodeId: 'peer-origin',
    originSequence: 1,
    timestamp: 10,
    lamportClock: 1,
    role: 'user',
    content: 'durable original content',
    parts: [
      { type: 'text', text: 'durable original content' },
      {
        type: 'attachment',
        attachment: {
          contentHash: `sha256:${'a'.repeat(64)}`,
          filename: 'design.md',
          mimeType: 'text/markdown',
          size: 123,
        },
      },
    ],
    attachments: [{
      contentHash: `sha256:${'a'.repeat(64)}`,
      filename: 'design.md',
      mimeType: 'text/markdown',
      size: 123,
    }],
    metadata: { workspace: 'wiki-a', nested: { retained: true } },
    contentType: 'text/markdown',
    ...overrides,
  };
}

function createFixture(options: {
  storage?: TestStorage;
  store?: MemoryAgentRunStateStore;
  source?: ChatMessage;
} = {}): {
  executed: ReturnType<typeof vi.fn>;
  runtime: MemeLoopRuntime;
  storage: TestStorage;
  store: MemoryAgentRunStateStore;
} {
  const storage = options.storage ?? createTestStorage({
    events: [],
    messages: [options.source ?? sourceUserMessage()],
  });
  const store = options.store ?? new MemoryAgentRunStateStore();
  const executed = vi.fn();
  const context: AgentFrameworkContext = {
    storage,
    localNodeId: 'peer-local',
    llmProvider: { name: 'test', chat: vi.fn().mockResolvedValue('') },
    tools: { registerTool: vi.fn(), getTool: vi.fn(), listTools: vi.fn().mockReturnValue([]) },
    syncAdapters: [],
    network: { start: vi.fn(), stop: vi.fn() },
    runAgentToolLoop: async function*(input) {
      executed(input);
      yield { type: 'thinking', data: 'ok' };
    },
  };
  return {
    executed,
    runtime: createMemeLoopRuntime(context, {
      runStateStore: store,
      allowNonAtomicRetry: true,
    }),
    storage,
    store,
  };
}

function addAtomicRetryCapability(
  storage: TestStorage,
  stateStore: MemoryAgentRunStateStore,
): TestStorage & AtomicAgentRetryStore & AgentRunStateStore {
  const combined = storage as TestStorage & AtomicAgentRetryStore & AgentRunStateStore;
  combined.createOrGet = stateStore.createOrGet.bind(stateStore);
  combined.get = stateStore.get.bind(stateStore);
  combined.getByRequest = stateStore.getByRequest.bind(stateStore);
  combined.getByTurn = stateStore.getByTurn.bind(stateStore);
  combined.transition = stateStore.transition.bind(stateStore);
  combined.claimExecution = stateStore.claimExecution.bind(stateStore);
  combined.renewExecution = stateStore.renewExecution.bind(stateStore);
  combined.releaseExecution = stateStore.releaseExecution.bind(stateStore);
  combined.listActive = stateStore.listActive.bind(stateStore);
  combined.prune = stateStore.prune.bind(stateStore);
  combined.retryTurnAtomic = vi.fn(async (input: AtomicAgentRetryInput) => {
    const existing = await stateStore.getByRequest(
      input.candidateRun.requestPeerId,
      input.candidateRun.requestId,
    );
    if (input.mode === 'fresh' && !existing) {
      const source = storage.state.messages.find(message =>
        message.conversationId === input.candidateRun.conversationId &&
        message.messageId === input.sourceTurnId
      );
      if (!source) throw new Error('atomic_agent_retry_source_not_found');
      assertAtomicAgentRetrySourceMessage(input.expectedSourceMessage, source);
    } else if (!existing) {
      throw new Error('atomic_agent_retry_replay_not_found');
    }
    const run = await stateStore.createOrGet(input.candidateRun);
    if (
      run.retrySourceTurnId !== input.sourceTurnId ||
      run.turnId !== input.replacementPayload.turnId
    ) throw new Error('atomic_agent_retry_request_conflict');
    const drafts = createAtomicAgentRetryEventDrafts(run, input);
    const [tombstone, userEvent] = await storage.appendLocalEventsAtomic(drafts);
    if (tombstone?.kind !== 'tombstone' || userEvent?.kind !== 'message') {
      throw new Error('atomic_agent_retry_invalid_events');
    }
    return {
      run,
      created: existing === undefined,
      tombstone,
      userEvent,
    };
  });
  return combined;
}

async function waitForState(
  runtime: MemeLoopRuntime,
  runId: string,
  state: MemeLoopRunState,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await runtime.getRunStatus(runId))?.state === state) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${runId} did not reach ${state}`);
}

const retryRequest = {
  conversationId: CONVERSATION_ID,
  definitionId: DEFINITION_ID,
  turnId: SOURCE_TURN_ID,
  newTurnId: NEW_TURN_ID,
  requestId: 'request-retry',
  requestPeerId: 'peer-controller',
} as const;

describe('MemeLoopRuntime durable retry seam', () => {
  it('uses the same injectable async digest provider for ordinary runs and retries', async () => {
    const storage = createTestStorage({ messages: [sourceUserMessage()] });
    const digest = vi.fn(async (_bytes: Uint8Array) => 'a'.repeat(64));
    const ids = ['runtime-id-value', 'send-run-id-value', 'retry-run-id-value'];
    const runtime = createMemeLoopRuntime({
      storage,
      localNodeId: 'peer-local',
      llmProvider: { name: 'test', chat: vi.fn() },
      tools: { registerTool: vi.fn(), getTool: vi.fn(), listTools: vi.fn().mockReturnValue([]) },
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      runAgentToolLoop: emptyAgentToolLoop,
    }, {
      runStateStore: new MemoryAgentRunStateStore(),
      allowNonAtomicRetry: true,
      idFactory: () => ids.shift()!,
      sha256Hex: digest,
    });

    const sent = await runtime.sendMessage({
      conversationId: 'conversation-send',
      definitionId: DEFINITION_ID,
      message: 'ordinary message',
      requestId: 'ordinary-request',
      turnId: 'ordinary-turn',
    });
    await waitForState(runtime, sent.runId, 'completed');
    const retried = await runtime.retryTurn(retryRequest);
    await waitForState(runtime, retried.handle.runId, 'completed');

    expect(digest).toHaveBeenCalledTimes(2);
    expect(digest.mock.calls.every(([bytes]) => bytes instanceof Uint8Array)).toBe(true);
    await runtime.dispose();
  });

  it('exports a shared atomic store replay/drift conformance contract', async () => {
    const source = sourceUserMessage();
    const replacementPayload = createAtomicAgentRetryReplacementPayload(source, NEW_TURN_ID);
    const payloadDigest = await digestAtomicAgentRetryPayload({
      conversationId: CONVERSATION_ID,
      definitionId: DEFINITION_ID,
      sourceTurnId: SOURCE_TURN_ID,
      newTurnId: NEW_TURN_ID,
      replacementPayload,
    });
    const storage = createTestStorage({ messages: [source] });
    const atomicStore = addAtomicRetryCapability(storage, new MemoryAgentRunStateStore());
    await expect(assertAtomicAgentRetryStoreConformance(atomicStore, {
      mode: 'fresh',
      candidateRun: {
        runId: 'run:atomic-conformance',
        conversationId: CONVERSATION_ID,
        definitionId: DEFINITION_ID,
        turnId: NEW_TURN_ID,
        requestPeerId: 'peer-controller',
        requestId: 'request-atomic-conformance',
        payloadDigest,
        retrySourceTurnId: SOURCE_TURN_ID,
        state: 'accepted',
        acceptedAt: 100,
        updatedAt: 100,
      },
      sourceTurnId: SOURCE_TURN_ID,
      expectedSourceMessage: source,
      replacementPayload,
      originNodeId: 'peer-local',
    })).resolves.toMatchObject({
      created: true,
      tombstone: { targetTurnId: SOURCE_TURN_ID },
      userEvent: { message: { messageId: NEW_TURN_ID } },
    });
    expect(storage.state.events).toHaveLength(2);
  });

  it('requires and dispatches the unified atomic capability in production mode', async () => {
    const split = createFixture();
    const productionSplitRuntime = createMemeLoopRuntime({
      storage: split.storage,
      localNodeId: 'peer-local',
      llmProvider: { name: 'test', chat: vi.fn() },
      tools: { registerTool: vi.fn(), getTool: vi.fn(), listTools: vi.fn().mockReturnValue([]) },
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      runAgentToolLoop: emptyAgentToolLoop,
    }, { runStateStore: new MemoryAgentRunStateStore() });
    await expect(productionSplitRuntime.retryTurn(retryRequest)).rejects.toThrow(
      'atomic_agent_retry_store_required',
    );

    const misleadingStorage = addAtomicRetryCapability(
      createTestStorage({ messages: [sourceUserMessage()] }),
      new MemoryAgentRunStateStore(),
    );
    const distinctRunStoreRuntime = createMemeLoopRuntime({
      storage: misleadingStorage,
      localNodeId: 'peer-local',
      llmProvider: { name: 'test', chat: vi.fn() },
      tools: { registerTool: vi.fn(), getTool: vi.fn(), listTools: vi.fn().mockReturnValue([]) },
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      runAgentToolLoop: emptyAgentToolLoop,
    }, { runStateStore: new MemoryAgentRunStateStore() });
    await expect(distinctRunStoreRuntime.retryTurn(retryRequest)).rejects.toThrow(
      'atomic_agent_retry_store_required',
    );

    const storage = createTestStorage({ messages: [sourceUserMessage()] });
    const stateStore = new MemoryAgentRunStateStore();
    const atomicStore = addAtomicRetryCapability(storage, stateStore);
    const executed = vi.fn();
    const runtime = createMemeLoopRuntime({
      storage: atomicStore,
      localNodeId: 'peer-local',
      llmProvider: { name: 'test', chat: vi.fn() },
      tools: { registerTool: vi.fn(), getTool: vi.fn(), listTools: vi.fn().mockReturnValue([]) },
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      runAgentToolLoop: async function*(input) {
        executed(input);
        yield* [];
      },
    }, { runStateStore: atomicStore });
    const first = await runtime.retryTurn(retryRequest);
    const replay = await runtime.retryTurn(retryRequest);
    expect(replay.handle.runId).toBe(first.handle.runId);
    await waitForState(runtime, first.handle.runId, 'completed');
    expect(executed).toHaveBeenCalledTimes(1);
    expect(atomicStore.retryTurnAtomic).toHaveBeenCalledTimes(2);
    expect((atomicStore.retryTurnAtomic as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      mode: 'fresh',
      sourceTurnId: SOURCE_TURN_ID,
    });
    expect((atomicStore.retryTurnAtomic as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toMatchObject({
      mode: 'replay',
      sourceTurnId: SOURCE_TURN_ID,
    });
  });

  it('claims one accepted run across two runtimes sharing one atomic store', async () => {
    const storage = createTestStorage({ messages: [sourceUserMessage()] });
    const atomicStore = addAtomicRetryCapability(storage, new MemoryAgentRunStateStore());
    const executed = vi.fn();
    const createRuntime = (runtimeName: string): MemeLoopRuntime =>
      createMemeLoopRuntime({
        storage: atomicStore,
        localNodeId: 'peer-local',
        llmProvider: { name: 'test', chat: vi.fn() },
        tools: { registerTool: vi.fn(), getTool: vi.fn(), listTools: vi.fn().mockReturnValue([]) },
        syncAdapters: [],
        network: { start: vi.fn(), stop: vi.fn() },
        runAgentToolLoop: async function*(input) {
          executed(input);
          yield* [];
        },
      }, {
        runStateStore: atomicStore,
        idFactory: (() => {
          const ids = [`${runtimeName}-runtime`, `${runtimeName}-run`];
          return () => ids.shift()!;
        })(),
      });
    const firstRuntime = createRuntime('first');
    const secondRuntime = createRuntime('second');

    const [first, second] = await Promise.all([
      firstRuntime.retryTurn(retryRequest),
      secondRuntime.retryTurn(retryRequest),
    ]);
    expect(second.handle.runId).toBe(first.handle.runId);
    await waitForState(firstRuntime, first.handle.runId, 'completed');
    expect(executed).toHaveBeenCalledTimes(1);
    expect(storage.state.events).toHaveLength(2);

    await Promise.all([firstRuntime.dispose(), secondRuntime.dispose()]);
  });

  it('point-reads the durable user root and preserves its structured payload', async () => {
    const fixture = createFixture();
    const result = await fixture.runtime.retryTurn(retryRequest);

    expect(result).toMatchObject({
      handle: {
        conversationId: CONVERSATION_ID,
        turnId: NEW_TURN_ID,
        requestId: retryRequest.requestId,
        state: 'accepted',
      },
      tombstone: { targetTurnId: SOURCE_TURN_ID },
      userEvent: {
        kind: 'message',
        message: {
          messageId: NEW_TURN_ID,
          turnId: NEW_TURN_ID,
          role: 'user',
          content: 'durable original content',
          attachments: sourceUserMessage().attachments,
          metadata: sourceUserMessage().metadata,
        },
      },
    });
    await waitForState(fixture.runtime, result.handle.runId, 'completed');
    expect(fixture.executed).toHaveBeenCalledTimes(1);
    expect(fixture.executed.mock.calls[0]?.[0]).toMatchObject({
      message: 'durable original content',
      persistedUserMessage: {
        messageId: NEW_TURN_ID,
        turnId: NEW_TURN_ID,
        attachments: sourceUserMessage().attachments,
        metadata: sourceUserMessage().metadata,
      },
    });
    expect(fixture.storage.state.events.map(event => event.kind)).toEqual([
      'tombstone',
      'message',
    ]);
  });

  it('coalesces concurrent idempotent calls into one event pair and one execution', async () => {
    const fixture = createFixture();
    const [first, second, third] = await Promise.all([
      fixture.runtime.retryTurn(retryRequest),
      fixture.runtime.retryTurn(retryRequest),
      fixture.runtime.retryTurn(retryRequest),
    ]);

    expect(second.handle.runId).toBe(first.handle.runId);
    expect(third.handle.runId).toBe(first.handle.runId);
    await waitForState(fixture.runtime, first.handle.runId, 'completed');
    expect(fixture.executed).toHaveBeenCalledTimes(1);
    expect(fixture.storage.state.events).toHaveLength(2);
    expect(fixture.storage.appendLocalEventsAtomic).toHaveBeenCalledTimes(1);

    const replay = await fixture.runtime.retryTurn(retryRequest);
    expect(replay.handle.runId).toBe(first.handle.runId);
    expect(fixture.storage.state.events).toHaveLength(2);
    expect(fixture.executed).toHaveBeenCalledTimes(1);
  });

  it('rejects request drift after the original turn is tombstoned', async () => {
    const fixture = createFixture();
    const first = await fixture.runtime.retryTurn(retryRequest);
    await waitForState(fixture.runtime, first.handle.runId, 'completed');

    await expect(fixture.runtime.retryTurn({
      ...retryRequest,
      turnId: 'different-source-turn',
    })).rejects.toThrow('retry_turn_request_conflict');
    await expect(fixture.runtime.retryTurn({
      ...retryRequest,
      newTurnId: 'different-new-turn',
    })).rejects.toThrow('retry_turn_request_conflict');
    await expect(fixture.runtime.retryTurn({
      ...retryRequest,
      definitionId: 'different-definition',
    })).rejects.toThrow('retry_turn_request_conflict');
    expect(fixture.storage.state.events).toHaveLength(2);
    expect(fixture.executed).toHaveBeenCalledTimes(1);
  });

  it('fails before run acceptance for a missing indexed reader or invalid user root', async () => {
    const missingReaderStorage = createTestStorage({ messages: [sourceUserMessage()] });
    const contextStorage: FullAgentStorage = {
      ...missingReaderStorage,
      getMessageById: undefined,
    };
    const store = new MemoryAgentRunStateStore();
    const runtime = createMemeLoopRuntime({
      storage: contextStorage,
      localNodeId: 'peer-local',
      llmProvider: { name: 'test', chat: vi.fn() },
      tools: { registerTool: vi.fn(), getTool: vi.fn(), listTools: vi.fn().mockReturnValue([]) },
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      runAgentToolLoop: emptyAgentToolLoop,
    }, { runStateStore: store, allowNonAtomicRetry: true });
    await expect(runtime.retryTurn(retryRequest)).rejects.toThrow(
      'retry_turn_indexed_point_read_unavailable',
    );
    expect(await store.listActive()).toHaveLength(0);

    const invalid = createFixture({ source: sourceUserMessage({ role: 'assistant' }) });
    await expect(invalid.runtime.retryTurn(retryRequest)).rejects.toThrow(
      'retry_turn_user_root_not_found',
    );
    expect(await invalid.store.listActive()).toHaveLength(0);
  });

  it('repairs the accepted-before-append crash window with the same request', async () => {
    const storage = createTestStorage({ messages: [sourceUserMessage()] });
    const append = storage.appendLocalEventsAtomic.bind(storage);
    let failOnce = true;
    storage.appendLocalEventsAtomic = vi.fn(async drafts => {
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated crash before atomic append');
      }
      return append(drafts);
    });
    const store = new MemoryAgentRunStateStore();
    const firstRuntime = createFixture({ storage, store }).runtime;
    await expect(firstRuntime.retryTurn(retryRequest)).rejects.toThrow(
      'simulated crash before atomic append',
    );
    expect(storage.state.events).toHaveLength(0);
    expect((await store.getByRequest('peer-controller', 'request-retry'))?.state).toBe('accepted');

    const restarted = createFixture({ storage, store });
    const repaired = await restarted.runtime.retryTurn(retryRequest);
    await waitForState(restarted.runtime, repaired.handle.runId, 'completed');
    expect(storage.state.events).toHaveLength(2);
    expect(restarted.executed).toHaveBeenCalledTimes(1);
  });

  it('recovers an accepted run whose atomic event pair committed before scheduling', async () => {
    const storage = createTestStorage({ messages: [sourceUserMessage()] });
    const store = new MemoryAgentRunStateStore();
    const first = createFixture({ storage, store });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>(resolve => {
      releaseAppend = resolve;
    });
    const append = storage.appendLocalEventsAtomic.bind(storage);
    storage.appendLocalEventsAtomic = vi.fn(async drafts => {
      const events = await append(drafts);
      await appendGate;
      return events;
    });
    const pending = first.runtime.retryTurn(retryRequest);
    for (let attempt = 0; attempt < 100 && storage.state.events.length < 2; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    expect(storage.state.events).toHaveLength(2);

    const restarted = createFixture({ storage, store });
    const run = await store.getByRequest('peer-controller', 'request-retry');
    expect(run?.state).toBe('accepted');
    releaseAppend();
    await pending;
    await waitForState(restarted.runtime, run!.runId, 'completed');
    expect(first.executed.mock.calls.length + restarted.executed.mock.calls.length).toBe(1);
    expect(storage.state.events).toHaveLength(2);
  });

  it('observes atomic rollback when the replacement event identity is occupied', async () => {
    const occupied: ConversationEvent = {
      kind: 'message',
      eventId: NEW_TURN_ID,
      conversationId: CONVERSATION_ID,
      originNodeId: 'peer-other',
      originSequence: 1,
      lamportClock: 2,
      timestamp: 20,
      message: {
        messageId: NEW_TURN_ID,
        turnId: NEW_TURN_ID,
        role: 'user',
        content: 'occupied by another request',
      },
    };
    const storage = createTestStorage({
      events: [occupied],
      messages: [sourceUserMessage()],
    });
    const fixture = createFixture({ storage });
    await expect(fixture.runtime.retryTurn(retryRequest)).rejects.toThrow(
      `local eventId ${NEW_TURN_ID} already exists with a different payload`,
    );
    expect(storage.state.events).toEqual([occupied]);
    expect(fixture.executed).not.toHaveBeenCalled();
  });
});
