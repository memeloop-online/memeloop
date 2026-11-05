import { describe, expect, it, vi } from 'vitest';
import type { AgentGoal, GoalStore } from '../agent-management/goal.js';
import { GoalCoordinator } from '../agent-management/GoalCoordinator.js';
import type { AgentDefinition } from '../agent/types.js';
import { ProviderRegistry } from '../llm/providerRegistry.js';
import type { LoopScriptCheckpointStore } from '../loopAPI/types.js';
import { MemoryAgentRunStateStore } from '../runState.js';
import { createMemeLoopRuntime } from '../runtime.js';
import type { AgentFrameworkContext } from '../types.js';
import { createTestStorage } from './testStorage.js';

function fixture(source: string, loopId = 'agent-tool-loop') {
  const definition: AgentDefinition = {
    id: 'saved-script',
    name: 'Saved script',
    description: 'Saved loop script',
    systemPrompt: '',
    tools: [],
    version: '1',
    loopId,
    scriptReference: { kind: 'source', source },
  };
  const definitions = new Map([[definition.id, definition]]);
  const storage = createTestStorage(undefined, { getAgentDefinition: async id => definitions.get(id) ?? null });
  const provider = { name: 'unused', chat: vi.fn() };
  const registry = new ProviderRegistry();
  registry.register({ ownerId: 'test', kind: 'host' }, provider, {
    models: [{ modelId: 'script-model', wireModelId: 'script-model', apiMode: 'chat-completions' }],
  });
  const context: AgentFrameworkContext = {
    storage,
    llmProvider: provider,
    modelProviderRegistry: registry,
    defaultModelConfig: { providerId: provider.name, modelId: 'script-model' },
    tools: { registerTool: vi.fn(), hasTool: () => false, getTool: () => undefined, listTools: () => [] },
    localNodeId: 'desktop',
    syncAdapters: [],
    network: { start: async () => {}, stop: async () => {} },
    loopScriptPolicy: { allowSource: true, scriptLoadGate: { admitScriptLoad: () => ({ allowed: true }) } },
  };
  return { definition, definitions, storage, context };
}

function checkpointFixture() {
  const values = new Map<string, unknown>();
  const checkpoints: LoopScriptCheckpointStore = {
    saveCheckpoint: async (conversationId, key, value) => {
      values.set(`${conversationId}:${key}`, structuredClone(value));
    },
    loadCheckpoint: async <T>(conversationId: string, key: string) => structuredClone(values.get(`${conversationId}:${key}`)) as T | undefined,
    checkpointFenceStore: {
      acquireCheckpointFence: async (runId, holder) => ({ name: runId, holder, leaseId: 'test-lease', epoch: '1' }),
      renewCheckpointFence: async lease => lease,
      releaseCheckpointFence: async () => {},
    },
  };
  return { values, checkpoints };
}

describe('durable script message outputs', () => {
  it.each(['agent-tool-loop', 'agent-agent-loop'])('persists %s finish output alongside explicit goal evidence', async loopId => {
    const { definition, storage, context } = fixture(
      'export default async function run(ctx) { await ctx.goal.complete("MJS_GOAL_EVIDENCE"); ctx.finish("MJS_GOAL_RESULT"); }',
      loopId,
    );
    let goal: AgentGoal | null = null;
    const store: GoalStore = {
      get: async () => structuredClone(goal),
      save: async (value, revision) => {
        if ((goal?.revision ?? null) !== revision) return false;
        goal = structuredClone(value);
        return true;
      },
      listActive: async () => ({ items: goal?.status === 'active' ? [goal] : [] }),
    };
    const coordinator = new GoalCoordinator({ store, executionNodeId: 'desktop', getRuntime: async () => runtime });
    const runtime = createMemeLoopRuntime({ ...context, goals: coordinator }, { runStateStore: new MemoryAgentRunStateStore() });
    try {
      const { conversationId } = await runtime.createAgent({ definitionId: definition.id });
      await coordinator.start({ conversationId, definitionId: definition.id, objective: 'Complete the saved script.' });
      await vi.waitFor(async () => {
        expect((await coordinator.get(conversationId))?.evidence).toBe('MJS_GOAL_EVIDENCE');
        expect(storage.state.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
      });
      const [user, assistant] = storage.state.messages;
      expect(assistant).toMatchObject({ role: 'assistant', content: 'MJS_GOAL_RESULT', turnId: user.turnId, parts: [{ type: 'text', text: 'MJS_GOAL_RESULT' }] });
      expect(storage.state.events.filter(event => event.kind === 'message')).toHaveLength(2);
    } finally {
      await coordinator.suspend();
      await runtime.dispose();
    }
  });

  it('replays a run whose assistant event committed before its terminal state exactly once', async () => {
    const { definition, storage, context } = fixture('export default function run() { return "Saved final output"; }');
    const first = createMemeLoopRuntime(context, { runStateStore: new MemoryAgentRunStateStore() });
    const { conversationId } = await first.createAgent({ definitionId: definition.id });
    const handle = await first.sendMessage({ conversationId, message: 'Run the saved source.' });
    await vi.waitFor(async () => {
      expect((await first.getRunStatus(handle.runId))?.state).toBe('completed');
    });
    const saved = (await first.getRunStatus(handle.runId))!;
    await first.dispose();
    const recoveredStore = new MemoryAgentRunStateStore();
    await recoveredStore.createOrGet({ ...saved, state: 'queued', finishedAt: undefined });
    const second = createMemeLoopRuntime(context, { runStateStore: recoveredStore });
    try {
      await vi.waitFor(async () => {
        expect((await second.getRunStatus(handle.runId))?.state).toBe('completed');
      });
      expect(storage.state.messages.map(message => message.content)).toEqual(['Run the saved source.', 'Saved final output']);
      expect(storage.state.events.filter(event => event.kind === 'message')).toHaveLength(2);
    } finally {
      await second.dispose();
    }
  });

  it.each(['emit', 'yield'] as const)('retains two identical %s messages and replays both identities exactly once', async mode => {
    const { definition, storage, context } = fixture(`
      export default ${mode === 'yield' ? 'async function*' : 'function'} run(ctx) {
        const step = { type: 'message', data: 'Checked' };
        ${mode === 'emit' ? 'ctx.emit(step); ctx.emit(step);' : 'yield step; yield step;'}
      }
    `);
    const first = createMemeLoopRuntime(context, { runStateStore: new MemoryAgentRunStateStore() });
    const { conversationId } = await first.createAgent({ definitionId: definition.id });
    const handle = await first.sendMessage({ conversationId, message: 'Perform both checks.' });
    await vi.waitFor(async () => {
      expect((await first.getRunStatus(handle.runId))?.state).toBe('completed');
    });
    const firstOutputs = storage.state.messages.filter(message => message.role === 'assistant');
    expect(firstOutputs.map(message => message.content)).toEqual(['Checked', 'Checked']);
    expect(new Set(firstOutputs.map(message => message.messageId)).size).toBe(2);
    const saved = (await first.getRunStatus(handle.runId))!;
    await first.dispose();
    const recoveredStore = new MemoryAgentRunStateStore();
    await recoveredStore.createOrGet({ ...saved, state: 'queued', finishedAt: undefined });
    const recovered = createMemeLoopRuntime(context, { runStateStore: recoveredStore });
    try {
      await vi.waitFor(async () => {
        expect((await recovered.getRunStatus(handle.runId))?.state).toBe('completed');
      });
      expect(storage.state.messages.filter(message => message.role === 'assistant')).toEqual(firstOutputs);
    } finally {
      await recovered.dispose();
    }
  });

  it('persists structured parent results and keeps child progress and stream chunks separate', async () => {
    const { definition, definitions, storage, context } = fixture(
      `
      export default async function run(ctx) {
        const child = await ctx.runAgent({ profileId: "child", prompt: "Build the draft." });
        ctx.emit({ type: "message", data: { type: "text-delta", text: "transient" } });
        ctx.finish({ type: "message", data: {
          content: "Parent: " + child.text,
          contentType: "text/vnd.tiddlywiki",
          parts: [{ type: "text", text: "Parent: " + child.text }],
          metadata: { checked: true }
        } });
      }`,
      'agent-agent-loop',
    );
    definitions.set('child', {
      ...definition,
      id: 'child',
      loopId: 'agent-tool-loop',
      scriptReference: { kind: 'source', source: 'export default function run(ctx) { ctx.finish("child draft"); }' },
    });
    const runtime = createMemeLoopRuntime(context, { runStateStore: new MemoryAgentRunStateStore() });
    try {
      const { conversationId } = await runtime.createAgent({ definitionId: definition.id });
      const handle = await runtime.sendMessage({ conversationId, message: 'Parent request' });
      await vi.waitFor(async () => {
        expect((await runtime.getRunStatus(handle.runId))?.state).toBe('completed');
      });
      expect(storage.state.messages.filter(message => message.conversationId === conversationId && message.role === 'assistant')).toEqual([
        expect.objectContaining({ content: 'Parent: child draft', contentType: 'text/vnd.tiddlywiki', metadata: { checked: true }, turnId: handle.turnId }),
      ]);
      const childMessages = storage.state.messages.filter(message => message.conversationId !== conversationId);
      expect(childMessages.map(message => [message.role, message.content])).toEqual([['user', 'Build the draft.'], ['assistant', 'child draft']]);
      expect(childMessages[1].turnId).toBe(childMessages[0].messageId);
      expect(childMessages[1].originNodeId).toBe('desktop');
      const saved = (await runtime.getRunStatus(handle.runId))!;
      await runtime.dispose();
      const recoveredStore = new MemoryAgentRunStateStore();
      await recoveredStore.createOrGet({ ...saved, state: 'queued', finishedAt: undefined });
      const recovered = createMemeLoopRuntime(context, { runStateStore: recoveredStore });
      try {
        await vi.waitFor(async () => {
          expect((await recovered.getRunStatus(handle.runId))?.state).toBe('completed');
        });
        expect(storage.state.messages).toHaveLength(4);
      } finally {
        await recovered.dispose();
      }
    } finally {
      await runtime.dispose();
    }
  });

  it.each(['yield', 'emit'] as const)('restores the output cursor after a checkpoint following %s, including identical text', async mode => {
    const progress = mode === 'emit' ? 'Checked' : 'Progress saved';
    const final = mode === 'emit' ? 'Checked' : 'Final result after resume';
    const { definition, storage, context } = fixture(
      `
      export const checkpoint = { id: 'output-resume', version: '1' };
      export default async function${mode === 'yield' ? '*' : ''} run(ctx) {
        if (!(await ctx.loadCheckpoint('progress'))) {
          ${mode === 'yield' ? `yield { type: 'message', data: '${progress}' };` : `ctx.emit({ type: 'message', data: '${progress}' });`}
          await ctx.checkpoint('progress', true);
          throw new Error('Process stopped after saving progress');
        }
        ctx.finish('${final}');
      }`,
      'agent-agent-loop',
    );
    const { values, checkpoints } = checkpointFixture();
    context.loopCheckpoints = checkpoints;
    context.loopScriptPolicy = {
      allowSource: true,
      scriptLoadGate: { admitScriptLoad: () => ({ allowed: true, checkpointAccepted: true }) },
    };
    let startedWrite = false;
    let releaseWrite: () => void = () => {};
    if (mode === 'emit') {
      const writeReady = new Promise<void>(resolve => {
        releaseWrite = resolve;
      });
      const append = storage.appendLocalEvent.bind(storage);
      vi.spyOn(storage, 'appendLocalEvent').mockImplementation(async draft => {
        if (draft.kind === 'message' && draft.message.role === 'assistant') {
          startedWrite = true;
          await writeReady;
        }
        return append(draft);
      });
    }
    const first = createMemeLoopRuntime(context, { runStateStore: new MemoryAgentRunStateStore() });
    const { conversationId } = await first.createAgent({ definitionId: definition.id });
    const handle = await first.sendMessage({ conversationId, message: 'Continue after saved progress.' });
    if (mode === 'emit') {
      try {
        await vi.waitFor(() => {
          expect(startedWrite).toBe(true);
        });
        expect(values.size).toBe(0);
      } finally {
        releaseWrite();
      }
    }
    await vi.waitFor(async () => {
      expect((await first.getRunStatus(handle.runId))?.state).toBe('failed');
    });
    const saved = (await first.getRunStatus(handle.runId))!;
    expect(storage.state.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([progress]);
    await first.dispose();
    const recoveredStore = new MemoryAgentRunStateStore();
    await recoveredStore.createOrGet({ ...saved, state: 'queued', finishedAt: undefined, error: undefined });
    const recovered = createMemeLoopRuntime(context, { runStateStore: recoveredStore });
    try {
      await vi.waitFor(async () => {
        expect((await recovered.getRunStatus(handle.runId))?.state).toBe('completed');
      });
      expect(storage.state.messages.filter(message => message.role === 'assistant').map(message => message.content))
        .toEqual([progress, final]);
    } finally {
      await recovered.dispose();
    }
  });

  it.each(['checkpoint', 'state'] as const)('restores a retried child output sequence from its shared %s cache', async kind => {
    const { definition, definitions, storage, context } = fixture(
      `
      export default async function run(ctx) {
        const child = { profileId: 'child', conversationId: 'retried-child', runId: 'retried-child-run', prompt: 'Check both phases' };
        try { await ctx.runAgent(child); } catch {}
        const result = await ctx.runAgent(child);
        ctx.finish(result.text);
      }`,
      'agent-agent-loop',
    );
    definitions.set('child', {
      ...definition,
      id: 'child',
      scriptReference: {
        kind: 'source',
        source: `
          export const checkpoint = { id: 'child-output-resume', version: '1' };
          export default async function run(ctx) {
            if (!(await ${kind === 'checkpoint' ? "ctx.loadCheckpoint('checked')" : "ctx.state.get('checked')"})) {
              ctx.emit({ type: 'message', data: 'Checked' });
              await ${kind === 'checkpoint' ? "ctx.checkpoint('checked', true)" : "ctx.state.set('checked', true)"};
              throw new Error('Retry after saved phase');
            }
            ctx.finish('Checked');
          }
        `,
      },
    });
    context.loopCheckpoints = checkpointFixture().checkpoints;
    context.loopScriptPolicy = {
      allowSource: true,
      scriptLoadGate: { admitScriptLoad: () => ({ allowed: true, checkpointAccepted: true }) },
    };
    const runtime = createMemeLoopRuntime(context, { runStateStore: new MemoryAgentRunStateStore() });
    try {
      const { conversationId } = await runtime.createAgent({ definitionId: definition.id });
      const handle = await runtime.sendMessage({ conversationId, message: 'Recover the child run.' });
      await vi.waitFor(async () => {
        expect((await runtime.getRunStatus(handle.runId))?.state).toBe('completed');
      });
      const childMessages = storage.state.messages.filter(message => message.conversationId === 'retried-child');
      expect(childMessages.map(message => message.content)).toEqual(['Check both phases', 'Checked', 'Checked']);
      expect(new Set(childMessages.map(message => message.messageId)).size).toBe(3);
      expect(storage.state.messages.filter(message => message.conversationId === conversationId && message.role === 'assistant').map(message => message.content))
        .toEqual(['Checked']);
    } finally {
      await runtime.dispose();
    }
  });

  it.each([
    { checkpointed: false, sharedConversation: true },
    { checkpointed: true, sharedConversation: true },
    { checkpointed: true, sharedConversation: false },
  ])('keeps default child invocations distinct and stable (checkpoint=$checkpointed, shared chat=$sharedConversation)', async ({ checkpointed, sharedConversation }) => {
    const { definition, definitions, storage, context } = fixture(
      `
      export const checkpoint = { id: 'child-invocations', version: '1' };
      export default async function run(ctx) {
        const child = { profileId: 'child', ${sharedConversation ? "conversationId: 'same-child'," : ''} prompt: 'Same request' };
        if (!${checkpointed ? "await ctx.loadCheckpoint('first-child')" : 'false'}) {
          await ctx.runAgent(child);
          ${checkpointed ? "await ctx.checkpoint('first-child', true); throw new Error('Restart after first child');" : ''}
        }
        await ctx.runAgent(child);
        ctx.finish('Both child invocations completed');
      }`,
      'agent-agent-loop',
    );
    definitions.set('child', {
      ...definition,
      id: 'child',
      loopId: 'agent-tool-loop',
      scriptReference: { kind: 'source', source: "export default function run(ctx) { ctx.finish('Same result'); }" },
    });
    context.loopCheckpoints = checkpointFixture().checkpoints;
    context.loopScriptPolicy = {
      allowSource: true,
      scriptLoadGate: { admitScriptLoad: () => ({ allowed: true, checkpointAccepted: true }) },
    };
    const first = createMemeLoopRuntime(context, { runStateStore: new MemoryAgentRunStateStore() });
    const { conversationId } = await first.createAgent({ definitionId: definition.id });
    const handle = await first.sendMessage({ conversationId, message: 'Repeat a child request.' });
    await vi.waitFor(async () => {
      expect((await first.getRunStatus(handle.runId))?.state).toBe(checkpointed ? 'failed' : 'completed');
    });
    const saved = (await first.getRunStatus(handle.runId))!;
    await first.dispose();
    let recoveredIds: string[] | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const recoveredStore = new MemoryAgentRunStateStore();
      await recoveredStore.createOrGet({ ...saved, state: 'queued', finishedAt: undefined, error: undefined });
      const recovered = createMemeLoopRuntime(context, { runStateStore: recoveredStore });
      try {
        await vi.waitFor(async () => {
          expect((await recovered.getRunStatus(handle.runId))?.state).toBe('completed');
        });
        const childMessages = storage.state.messages.filter(message => message.conversationId !== conversationId);
        expect(childMessages.map(message => message.content)).toEqual(['Same request', 'Same result', 'Same request', 'Same result']);
        expect(new Set(childMessages.map(message => message.turnId)).size).toBe(2);
        expect(new Set(childMessages.map(message => message.conversationId)).size).toBe(sharedConversation ? 1 : 2);
        const ids = childMessages.map(message => message.messageId);
        if (recoveredIds) expect(ids).toEqual(recoveredIds);
        recoveredIds = ids;
      } finally {
        await recovered.dispose();
      }
    }
  });

  it.each(['state.set', 'state.update', 'checkpoint'] as const)('keeps write-side %s CAS reads from advancing replay output identity', async operation => {
    const write = (value: number) =>
      operation === 'state.update'
        ? `await ctx.state.update('position', () => ${value});`
        : `await ctx.${operation}('position', ${value});`;
    const { definition, storage, context } = fixture(
      `
      export const checkpoint = { id: 'write-side-cursor', version: '1' };
      export default async function* run(ctx) {
        yield { type: 'message', data: 'A' };
        ${write(1)}
        yield { type: 'message', data: 'B' };
        ${write(2)}
        yield { type: 'message', data: 'C' };
      }`,
      'agent-agent-loop',
    );
    context.loopCheckpoints = checkpointFixture().checkpoints;
    context.loopScriptPolicy = {
      allowSource: true,
      scriptLoadGate: { admitScriptLoad: () => ({ allowed: true, checkpointAccepted: true }) },
    };
    const first = createMemeLoopRuntime(context, { runStateStore: new MemoryAgentRunStateStore() });
    const { conversationId } = await first.createAgent({ definitionId: definition.id });
    const handle = await first.sendMessage({ conversationId, message: 'Write both checkpoints.' });
    await vi.waitFor(async () => {
      expect((await first.getRunStatus(handle.runId))?.state).toBe('completed');
    });
    const saved = (await first.getRunStatus(handle.runId))!;
    await first.dispose();
    const recoveredStore = new MemoryAgentRunStateStore();
    await recoveredStore.createOrGet({ ...saved, state: 'queued', finishedAt: undefined });
    const recovered = createMemeLoopRuntime(context, { runStateStore: recoveredStore });
    try {
      await vi.waitFor(async () => {
        expect((await recovered.getRunStatus(handle.runId))?.state).toBe('completed');
      });
      expect(storage.state.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['A', 'B', 'C']);
    } finally {
      await recovered.dispose();
    }
  });

  it('uses the same durable script path for the public child runner and explicit retries', async () => {
    const { definition, storage, context } = fixture("export default function run(ctx) { ctx.finish('Child API result'); }");
    const runtime = createMemeLoopRuntime(context, { runStateStore: new MemoryAgentRunStateStore() });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        for await (const _step of runtime.runChildAgent({ profileId: definition.id, conversationId: 'api-child', prompt: 'Run child', runId: 'child-api-run' })) {
          // Fully consume the public child runner on both executions.
        }
      }
      expect(storage.state.messages.map(message => [message.role, message.content])).toEqual([
        ['user', 'Run child'],
        ['assistant', 'Child API result'],
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it('keeps explicitly identified repeated messages and distinct turns in a shared child conversation', async () => {
    const { definition, definitions, storage, context } = fixture(
      `
      export default async function run(ctx) {
        await ctx.runAgent({ profileId: "child", conversationId: "shared-child", prompt: "First task" });
        await ctx.runAgent({ profileId: "child", conversationId: "shared-child", prompt: "Second task" });
        ctx.emit({ type: "message", data: { messageId: "phase-one", content: "Checked" } });
        ctx.finish({ type: "message", data: { messageId: "phase-two", content: "Checked" } });
      }`,
      'agent-agent-loop',
    );
    definitions.set('child', {
      ...definition,
      id: 'child',
      loopId: 'agent-tool-loop',
      scriptReference: { kind: 'source', source: 'export default function run(ctx) { ctx.finish(ctx.input.message); }' },
    });
    const runtime = createMemeLoopRuntime(context, { runStateStore: new MemoryAgentRunStateStore() });
    try {
      const { conversationId } = await runtime.createAgent({ definitionId: definition.id });
      const handle = await runtime.sendMessage({ conversationId, message: 'Run both tasks.' });
      await vi.waitFor(async () => {
        expect((await runtime.getRunStatus(handle.runId))?.state).toBe('completed');
      });
      expect(storage.state.messages.filter(message => message.conversationId === conversationId && message.role === 'assistant').map(message => message.messageId))
        .toEqual(['phase-one', 'phase-two']);
      const childMessages = storage.state.messages.filter(message => message.conversationId === 'shared-child');
      expect(childMessages.map(message => message.content)).toEqual(['First task', 'First task', 'Second task', 'Second task']);
      expect(new Set(childMessages.map(message => message.turnId)).size).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });
});
