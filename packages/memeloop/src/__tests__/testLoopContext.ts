import type { AgentDefinition } from '../agent/types.js';
import { ProviderRegistry } from '../llm/providerRegistry.js';
import { HookRegistry } from '../loopAPI/hooks/registry.js';
import type { AgentFrameworkContext, ILLMProvider } from '../types.js';

/**
 * Make a direct loop unit fixture satisfy the same explicit runtime contracts
 * as a composed host: durable definition identity, provider routing and a
 * runtime-owned hook registry. XML tool calls stay explicitly opt-in.
 */
export function configureLoopTestContext(
  context: AgentFrameworkContext,
  options: { definitionId?: string; textToolCallProtocolEnabled?: boolean } = {},
): AgentFrameworkContext {
  const definitionId = options.definitionId ?? 'test:agent';
  const provider = context.llmProvider;
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(
    { ownerId: `test:${provider.name}`, kind: 'host' },
    provider,
    { models: [{ modelId: 'test-model', wireModelId: 'test-model', apiMode: 'chat-completions' }] },
  );

  const getConversationMeta = context.storage.getConversationMeta.bind(context.storage);
  context.storage.getConversationMeta = async (conversationId, callOptions) => {
    const existing = await getConversationMeta(conversationId, callOptions);
    if (existing?.definitionId) return existing;
    return {
      conversationId,
      title: existing?.title ?? 'Loop test',
      lastMessagePreview: existing?.lastMessagePreview ?? '',
      lastMessageTimestamp: existing?.lastMessageTimestamp ?? 0,
      messageCount: existing?.messageCount ?? 0,
      originNodeId: existing?.originNodeId ?? context.localNodeId ?? 'test-node',
      originClock: existing?.originClock ?? 0,
      definitionId,
      instanceDelta: existing?.instanceDelta,
      isUserInitiated: existing?.isUserInitiated ?? true,
      sourceChannel: existing?.sourceChannel,
    };
  };

  const getAgentDefinition = context.storage.getAgentDefinition.bind(context.storage);
  context.storage.getAgentDefinition = async id => await getAgentDefinition(id) ?? defaultDefinition(id);

  context.modelProviderRegistry = providerRegistry;
  context.defaultModelConfig = { providerId: provider.name, modelId: 'test-model' };
  context.hooks ??= new HookRegistry();
  context.agentToolLoop = {
    ...context.agentToolLoop,
    ...(options.textToolCallProtocolEnabled === false ? {} : { textToolCallProtocolEnabled: true }),
  };
  return context;
}

export function textDelta(text: string, id = 'test-text') {
  return { type: 'text-delta' as const, id, text };
}

export function typedTextChat(
  source: (request: Parameters<ILLMProvider['chat']>[0]) => AsyncIterable<string>,
): ILLMProvider['chat'] {
  return async function* typedChat(request) {
    let index = 0;
    for await (const text of source(request)) {
      yield textDelta(text, `test-text-${index++}`);
    }
    yield { type: 'finish', finishReason: 'stop' };
  };
}

function defaultDefinition(id: string): AgentDefinition {
  return {
    id,
    name: 'Loop test agent',
    description: 'Loop test agent',
    systemPrompt: 'You are a test agent.',
    tools: [],
    version: '1.0.0',
  };
}
