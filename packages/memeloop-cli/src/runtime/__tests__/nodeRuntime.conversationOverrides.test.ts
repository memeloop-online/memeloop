import { type ILLMProvider, prepareAgentExecutionModelRequest, ProviderRegistry } from 'memeloop';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createNodeRuntime } from '../nodeRuntime.js';

it('uses current canonical conversation model and framework overrides for preview and execution', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'conversation-overrides-'));
  const chat = vi.fn<ILLMProvider['chat']>().mockResolvedValue('answer');
  const provider: ILLMProvider = { name: 'real', chat };
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
