import { type AgentModelConfig, type ILLMProvider, type ModelCallRecordResource, prepareAgentExecutionModelRequest, ProviderRegistry } from 'memeloop';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createNodeRuntime } from '../nodeRuntime.js';

it('uses current canonical conversation model and framework overrides for preview and execution', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'conversation-overrides-'));
  const chat = vi.fn<ILLMProvider['chat']>().mockResolvedValue('answer');
  const provider: ILLMProvider = { name: 'real', chat };
  const goals = {
    get: vi.fn().mockResolvedValue(null),
    completeFromRun: vi.fn(),
    blockFromRun: vi.fn(),
  };
  const registry = new ProviderRegistry();
  registry.register({ ownerId: 'test', kind: 'host' }, provider, {
    models: [
      { modelId: 'logical', wireModelId: 'wire', apiMode: 'responses', requestDefaults: { temperature: 0.4 } },
      { modelId: 'global', wireModelId: 'global-wire', apiMode: 'chat-completions' },
    ],
  });
  const runtime = await createNodeRuntime({
    dataDir,
    localNodeId: 'local',
    includeVscodeCli: false,
    workloadExecution: { enabled: false },
    providerRegistry: registry,
    llmProvider: provider,
    goals,
    modelGateway: { routeLoops: false },
    config: {
      defaultModelConfig: { providerId: 'real', modelId: 'global' },
      agents: [{
        id: 'definition',
        name: 'Test',
        description: 'Test definition',
        systemPrompt: 'Base system',
        tools: [],
        version: '1',
        agentFrameworkConfig: { prompts: [], plugins: [] },
      }, {
        id: 'other-definition',
        name: 'Other',
        description: 'Other definition',
        systemPrompt: 'Other system',
        tools: [],
        version: '1',
      }],
    },
  });
  try {
    expect(runtime.context.goals).toBe(goals);
    // Exercise the real creation order: profile resolution precedes metadata.
    expect(await runtime.storage.getConversationMeta('conversation')).toBeNull();
    const created = await runtime.runtime.createAgent({ definitionId: 'definition', conversationId: 'conversation' });
    expect(created.conversationId).toBe('conversation');
    expect((await runtime.storage.getConversationMeta('conversation'))?.definitionId).toBe('definition');
    await expect(runtime.context.resolveAgentDefinition!('other-definition', {
      conversationId: 'conversation',
    })).rejects.toThrow('conversation_definition_changed');
    await runtime.storage.appendLocalEvent({
      eventId: 'meta',
      kind: 'metadataPatch',
      conversationId: 'conversation',
      originNodeId: 'local',
      timestamp: 1,
      patch: {
        definitionId: 'definition',
        instanceDelta: {
          modelConfig: { providerId: 'real', modelId: 'logical', parameters: { reasoningEffort: 'high', maxOutputTokens: 1234 } },
          agentFrameworkConfig: { prompts: [{ id: 'instance-prompt', role: 'system', text: 'Conversation instructions', enabled: true }] },
        },
      },
    });
    const options = { conversationId: 'conversation', signal: new AbortController().signal, stream: false, inputText: 'Hello' };
    const preview = await prepareAgentExecutionModelRequest(runtime.context, options);
    const execution = await prepareAgentExecutionModelRequest(runtime.context, options);
    expect(preview.definition.agentFrameworkConfig).toEqual({
      prompts: [{ id: 'instance-prompt', role: 'system', text: 'Conversation instructions', enabled: true }],
      plugins: [],
    });
    expect(preview.prepared.request.messages).toContainEqual({ role: 'system', content: 'Conversation instructions' });
    expect(execution.prepared.request).toEqual(preview.prepared.request);
    expect(execution.prepared.request).toMatchObject({
      providerId: 'real',
      logicalModelId: 'logical',
      wireModelId: 'wire',
      apiMode: 'responses',
      reasoningEffort: 'high',
      maxOutputTokens: 1234,
      temperature: 0.4,
    });
    const result = await execution.route.provider.chat(execution.prepared.request);
    expect(result).toBe('answer');
    expect(chat).toHaveBeenCalledWith(preview.prepared.request);
    await runtime.storage.appendLocalEvent({
      eventId: 'edited',
      kind: 'metadataPatch',
      conversationId: 'conversation',
      originNodeId: 'local',
      timestamp: 2,
      patch: { instanceDelta: { modelConfig: { providerId: 'real', modelId: 'logical', parameters: { reasoningEffort: 'low' } } } },
    });
    const edited = await prepareAgentExecutionModelRequest(runtime.context, options);
    expect(edited.prepared.request.reasoningEffort).toBe('low');
    expect(edited.definition.agentFrameworkConfig).toEqual({ prompts: [], plugins: [] });
    const runnerSnapshot = { ...runtime.context };
    await runtime.storage.appendLocalEvent({
      eventId: 'inherit',
      kind: 'metadataPatch',
      conversationId: 'conversation',
      originNodeId: 'local',
      timestamp: 3,
      patch: { instanceDelta: {} },
    });
    runtime.context.defaultModelConfig = { providerId: 'real', modelId: 'logical', parameters: { reasoningEffort: 'medium' } };
    const inherited = await prepareAgentExecutionModelRequest(runnerSnapshot, options);
    expect(inherited.prepared.request.reasoningEffort).toBe('medium');
  } finally {
    await runtime.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it('uses live inherited defaults for preview and durable execution without bypassing the model gateway', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'live-model-defaults-'));
  const chat = vi.fn<ILLMProvider['chat']>(async function*() {
    yield { type: 'text-delta', id: 'answer', text: 'answer' };
    yield { type: 'finish', finishReason: 'stop' };
  });
  const provider: ILLMProvider = { name: 'live', chat };
  const registry = new ProviderRegistry();
  registry.register({ ownerId: 'test', kind: 'host' }, provider, {
    models: [
      { modelId: 'first', wireModelId: 'first-wire', apiMode: 'chat-completions' },
      { modelId: 'second', wireModelId: 'second-wire', apiMode: 'responses', requestDefaults: { temperature: 0.4 } },
    ],
  });
  let currentDefault: AgentModelConfig | undefined = { providerId: 'live', modelId: 'first' };
  const runtime = await createNodeRuntime({
    dataDir,
    localNodeId: 'local',
    includeVscodeCli: false,
    workloadExecution: { enabled: false },
    providerRegistry: registry,
    llmProvider: provider,
    resolveDefaultModelConfig: async () => currentDefault,
    config: {
      defaultModelConfig: currentDefault,
      agents: [{
        id: 'definition',
        name: 'Live defaults',
        description: 'Inherits host model selection',
        systemPrompt: 'Answer briefly',
        tools: [],
        version: '1',
      }],
    },
  });
  try {
    const { conversationId } = await runtime.runtime.createAgent({ definitionId: 'definition', conversationId: 'live-conversation' });
    const previewOptions = { conversationId, signal: new AbortController().signal, stream: true, inputText: 'Hello' };
    const execute = async () => {
      const handle = await runtime.runtime.sendMessage({ conversationId, message: 'Hello' });
      await vi.waitFor(async () => {
        expect((await runtime.runtime.getRunStatus(handle.runId))?.state).toBe('completed');
      }, { timeout: 5_000 });
    };
    expect((await prepareAgentExecutionModelRequest(runtime.context, previewOptions)).prepared.request.logicalModelId).toBe('first');
    await execute();
    expect(chat.mock.calls.at(-1)?.[0]).toMatchObject({ logicalModelId: 'first', wireModelId: 'first-wire' });

    currentDefault = { providerId: 'live', modelId: 'second', parameters: { maxOutputTokens: 1234, reasoningEffort: 'high' } };
    const updatedRoute = {
      providerId: 'live',
      logicalModelId: 'second',
      wireModelId: 'second-wire',
      apiMode: 'responses',
      temperature: 0.4,
      maxOutputTokens: 1234,
      reasoningEffort: 'high',
    };
    const preview = await prepareAgentExecutionModelRequest(runtime.context, previewOptions);
    expect(preview.prepared.request).toMatchObject(updatedRoute);
    expect(preview.route.provider).toBe(runtime.context.llmProvider);
    expect(preview.route.provider).not.toBe(provider);
    await execute();
    expect(chat.mock.calls.at(-1)?.[0]).toMatchObject(updatedRoute);
    const records = await runtime.controlStore!.list<ModelCallRecordResource['spec']>({
      apiVersion: 'models.memeloop.io/v1alpha1',
      kind: 'ModelCallRecord',
    });
    expect(records.items).toEqual(expect.arrayContaining([expect.objectContaining({
      spec: expect.objectContaining({ modelClassRef: expect.objectContaining({ name: 'live-second-wire' }) }),
      status: expect.objectContaining({ phase: 'Completed' }),
    })]));

    currentDefault = undefined;
    await expect(prepareAgentExecutionModelRequest(runtime.context, previewOptions)).rejects.toThrow('agent model selection is not configured');
    await runtime.storage.appendLocalEvent({
      eventId: 'explicit-model',
      kind: 'metadataPatch',
      conversationId,
      originNodeId: 'local',
      timestamp: Date.now(),
      patch: { instanceDelta: { modelConfig: { providerId: 'live', modelId: 'first' } } },
    });
    expect((await prepareAgentExecutionModelRequest(runtime.context, previewOptions)).prepared.request.logicalModelId).toBe('first');
    await execute();
    expect(chat.mock.calls.at(-1)?.[0]).toMatchObject({ logicalModelId: 'first', wireModelId: 'first-wire' });
  } finally {
    await runtime.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
