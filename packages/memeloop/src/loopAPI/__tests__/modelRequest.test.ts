import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '../../agent/types.js';
import { type ChatMessage, createContextCompactionBoundaryFromCoverage } from '../../conversation/index.js';
import { prepareModelRequest, resolveAgentModelRoute } from '../../llm/prepareModelRequest.js';
import { ProviderRegistry } from '../../llm/providerRegistry.js';
import type { AgentFrameworkContext, ILLMProvider } from '../../types.js';
import { buildLlmMessages, prepareAgentModelRequest } from '../agent-tool-loop/modelMessages.js';

describe('prepareModelRequest', () => {
  it('builds the exact portable request from the runtime provider route and agent model config', () => {
    const provider: ILLMProvider = {
      name: 'cpa',
      chat: vi.fn(async () => 'unused'),
    };
    const providers = new ProviderRegistry();
    providers.register(
      { ownerId: 'test/runtime', kind: 'host' },
      provider,
      {
        models: [{ modelId: 'gpt-sol', wireModelId: 'gpt-5.6-sol', apiMode: 'responses' }],
      },
    );
    const signal = new AbortController().signal;
    const route = resolveAgentModelRoute(providers, {
      providerId: 'cpa',
      modelId: 'gpt-sol',
      parameters: { maxOutputTokens: 4096, temperature: 0.2, topP: 0.9 },
    });
    const prepared = prepareModelRequest({
      route,
      conversationId: 'conversation-1',
      stream: true,
      messages: [
        { role: 'system', content: 'system contract' },
        { role: 'user', content: 'hello' },
      ],
      signal,
    });

    expect(prepared.route.provider).toBe(provider);
    expect(prepared.request).toMatchObject({
      providerId: 'cpa',
      modelId: 'gpt-5.6-sol',
      apiMode: 'responses',
      conversationId: 'conversation-1',
      stream: true,
      maxOutputTokens: 4096,
      temperature: 0.2,
      topP: 0.9,
      messages: [
        { role: 'system', content: 'system contract' },
        { role: 'user', content: 'hello' },
      ],
      signal,
    });
  });

  it('normalizes foreign-realm registered tool schemas on the model-request path', async () => {
    const provider: ILLMProvider = {
      name: 'foreign-schema-provider',
      chat: vi.fn(async () => 'unused'),
    };
    const providers = new ProviderRegistry();
    providers.register(
      { ownerId: 'test/foreign-schema', kind: 'host' },
      provider,
      {
        models: [{ modelId: 'logical', wireModelId: 'wire', apiMode: 'chat-completions' }],
      },
    );
    const route = resolveAgentModelRoute(providers, {
      providerId: provider.name,
      modelId: 'logical',
    });
    const foreignSchema = runInNewContext(`({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    })`) as Record<string, unknown>;
    const context = {
      tools: {
        registerTool: () => undefined,
        getTool: () => undefined,
        listTools: () => ['foreign-tool'],
        getToolParameterSchema: () => foreignSchema,
      },
    } as unknown as AgentFrameworkContext;
    const definition: AgentDefinition = {
      id: 'foreign-schema-definition',
      name: 'Foreign schema',
      description: '',
      systemPrompt: '',
      tools: ['foreign-tool'],
      version: '1',
    };

    const prepared = await prepareAgentModelRequest(context, definition, [], {
      route,
      conversationId: 'foreign-schema-conversation',
      stream: true,
      inputText: 'run it',
    });

    const inputSchema = prepared.request.tools?.[0]?.inputSchema;
    expect(Object.getPrototypeOf(inputSchema!)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(inputSchema?.properties as object)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(inputSchema?.required as object)).toBe(Array.prototype);
  });

  it('projects a compaction summary as explicit continuity memory, not an assistant reply', async () => {
    const boundary = createContextCompactionBoundaryFromCoverage({
      coveredVersion: { 'node-a': 10 },
      coveredMessageCountByOrigin: { 'node-a': 10 },
      coveredUserTurnCountByOrigin: { 'node-a': 5 },
    });
    const summary: ChatMessage = {
      messageId: 'compaction:summary-1',
      turnId: 'compaction:summary-1',
      conversationId: 'conversation-summary',
      originNodeId: 'node-summary',
      originSequence: 1,
      lamportClock: 11,
      timestamp: 11,
      role: 'assistant',
      content: 'The user selected project Atlas.',
      metadata: { contextCompaction: boundary, compacted: true },
    };
    const context = { agentToolLoop: {} } as unknown as AgentFrameworkContext;
    const definition: AgentDefinition = {
      id: 'summary-definition',
      name: 'Summary definition',
      description: '',
      systemPrompt: 'Original system policy.',
      tools: [],
      version: '1',
    };

    const messages = await buildLlmMessages(context, definition, [summary]);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: 'system' });
    expect(messages[1]?.content).toContain('durable conversation context');
    expect(messages[1]?.content).toContain(JSON.stringify(summary.content));
  });
});
