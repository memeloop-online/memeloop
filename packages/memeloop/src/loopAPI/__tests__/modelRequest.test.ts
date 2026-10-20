import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { PromptPreviewAuditSessionStore } from '../../agent-management/PromptPreviewAuditSessionStore.js';
import { PromptPreviewController } from '../../agent-management/PromptPreviewController.js';
import type { AgentDefinition } from '../../agent/types.js';
import { type ChatMessage, createContextCompactionBoundaryFromCoverage } from '../../conversation/index.js';
import { prepareModelRequest, resolveAgentModelRoute } from '../../llm/prepareModelRequest.js';
import { ProviderRegistry } from '../../llm/providerRegistry.js';
import type { PromptNode } from '../../promptUtilities/types.js';
import type { AgentFrameworkContext, ILLMProvider } from '../../types.js';
import { buildLlmMessages, prepareAgentModelRequest } from '../agent-tool-loop/modelMessages.js';

describe('prepareModelRequest', () => {
  it('applies route defaults while preserving explicit parameters and merging provider options', () => {
    const provider: ILLMProvider = {
      name: 'cpa-defaults',
      chat: vi.fn(async () => 'unused'),
    };
    const providers = new ProviderRegistry();
    providers.register(
      { ownerId: 'test/runtime-defaults', kind: 'host' },
      provider,
      {
        models: [{
          modelId: 'logical',
          wireModelId: 'wire',
          apiMode: 'responses',
          requestDefaults: {
            maxOutputTokens: 32_768,
            temperature: 0.4,
            topP: 0.95,
            reasoningEffort: 'high',
            providerOptions: {
              openai: { routeOnly: true, shared: 'route' },
              responses: { include: ['reasoning.encrypted_content'] },
            },
          },
        }],
      },
    );
    const route = resolveAgentModelRoute(providers, {
      providerId: 'cpa-defaults',
      modelId: 'logical',
      parameters: { maxOutputTokens: 8_192, temperature: 0.2 },
    });

    const prepared = prepareModelRequest({
      route,
      messages: [{ role: 'user', content: 'hello' }],
      providerOptions: {
        openai: { shared: 'call', callOnly: 1 },
      },
    });

    expect(prepared.request).toMatchObject({
      maxOutputTokens: 8_192,
      temperature: 0.2,
      topP: 0.95,
      reasoningEffort: 'high',
      providerOptions: {
        openai: { routeOnly: true, shared: 'call', callOnly: 1 },
        responses: { include: ['reasoning.encrypted_content'] },
      },
    });
    expect(prepared.request.providerOptions).not.toBe(route.requestDefaults?.providerOptions);
  });

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
      logicalModelId: 'gpt-sol',
      wireModelId: 'gpt-5.6-sol',
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

  it('includes turn-scoped native tools contributed by a prompt plugin', async () => {
    const provider: ILLMProvider = {
      name: 'dynamic-provider',
      chat: vi.fn(async () => 'unused'),
    };
    const providers = new ProviderRegistry();
    providers.register(
      { ownerId: 'test/dynamic-schema', kind: 'host' },
      provider,
      { models: [{ modelId: 'logical', wireModelId: 'wire', apiMode: 'responses' }] },
    );
    const route = resolveAgentModelRoute(providers, {
      providerId: provider.name,
      modelId: 'logical',
    });
    const context = {
      promptPlugins: new Map([['dynamic-plugin', (hooks: {
        processPrompts: { tapAsync: (name: string, handler: (context: unknown, done: () => void) => void) => void };
      }) => {
        hooks.processPrompts.tapAsync('dynamic-plugin', (rawContext, done) => {
          const hookContext = rawContext as {
            toolConfig: { toolId: string };
            registerModelTool: (tool: {
              name: string;
              description: string;
              inputSchema: Record<string, never>;
            }) => void;
          };
          if (hookContext.toolConfig.toolId === 'dynamic-plugin') {
            hookContext.registerModelTool({
              name: 'mcp-read',
              description: 'Read through MCP',
              inputSchema: {},
            });
          }
          done();
        });
      }]]),
      tools: {
        registerTool: () => undefined,
        getTool: () => undefined,
        listTools: () => [],
        getToolParameterSchema: () => undefined,
      },
    } as unknown as AgentFrameworkContext;
    const definition: AgentDefinition = {
      id: 'dynamic-schema-definition',
      name: 'Dynamic schema',
      description: '',
      systemPrompt: '',
      tools: [],
      version: '1',
      agentFrameworkConfig: {
        prompts: [{ id: 'system', text: 'system' }],
        plugins: [{ id: 'dynamic', toolId: 'dynamic-plugin' }],
      },
    };

    const prepared = await prepareAgentModelRequest(context, definition, [], {
      route,
      conversationId: 'dynamic-schema-conversation',
      stream: true,
      inputText: 'read it',
    });

    expect(prepared.request.tools).toEqual([{
      name: 'mcp-read',
      description: 'Read through MCP',
      inputSchema: {},
    }]);
    expect(prepared.request.toolChoice).toBe('auto');
  });

  it('prepares plugins once and pages the exact request with prompt ancestry and every history source', async () => {
    const provider: ILLMProvider = { name: 'preview-provider', chat: vi.fn(async () => 'unused') };
    const registry = new ProviderRegistry();
    registry.register({ ownerId: 'test/preview', kind: 'host' }, provider, {
      models: [{ modelId: 'logical', wireModelId: 'wire', apiMode: 'responses' }],
    });
    const route = resolveAgentModelRoute(registry, { providerId: provider.name, modelId: 'logical' });
    let pluginCalls = 0;
    const context = {
      promptPlugins: new Map([['dynamic', (hooks: {
        processPrompts: { tapAsync: (name: string, handler: (context: unknown, done: () => void) => void) => void };
      }) => {
        hooks.processPrompts.tapAsync('dynamic', (raw, done) => {
          pluginCalls += 1;
          const hook = raw as { prompts: PromptNode[] };
          hook.prompts[0].children!.push({
            id: 'generated',
            caption: 'Generated',
            role: 'system',
            text: `plugin pass ${pluginCalls}`,
            source: ['plugins', 'dynamic-config'],
          });
          done();
        });
      }]]),
      tools: {},
    } as unknown as AgentFrameworkContext;
    const definition: AgentDefinition = {
      id: 'preview-definition',
      name: 'Preview',
      description: '',
      systemPrompt: '',
      tools: [],
      version: '1',
      agentFrameworkConfig: {
        prompts: [{
          id: 'root',
          caption: 'Policy',
          children: [{ id: 'policy', caption: 'Instructions', role: 'system', text: 'policy' }],
        }],
        plugins: [{ id: 'dynamic-config', toolId: 'dynamic' }],
      },
    };
    const historyMessage = (id: string, role: ChatMessage['role'], parts: ChatMessage['parts']): ChatMessage => ({
      messageId: id,
      turnId: 'turn',
      conversationId: 'conversation',
      originNodeId: 'node',
      originSequence: 1,
      lamportClock: 1,
      timestamp: 1,
      role,
      content: id,
      parts,
    });
    const summary = historyMessage('summary', 'assistant', [{ type: 'text', text: 'retained memory' }]);
    summary.metadata = {
      compacted: true,
      contextCompaction: createContextCompactionBoundaryFromCoverage({
        coveredVersion: { old: 2 },
        coveredMessageCountByOrigin: { old: 2 },
        coveredUserTurnCountByOrigin: { old: 1 },
      }),
    };
    const history = [
      summary,
      historyMessage('user', 'user', [{ type: 'text', text: 'question' }]),
      historyMessage('call', 'assistant', [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'search', arguments: { query: 'q' } }]),
      historyMessage('result', 'tool', [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'search', result: 'found' }]),
      historyMessage('answer', 'assistant', [{ type: 'text', text: 'answer' }]),
    ];
    const store = new PromptPreviewAuditSessionStore({ createSessionId: () => 'session', createRevision: () => 'revision' });
    let exact: Awaited<ReturnType<typeof prepareAgentModelRequest>> | undefined;
    const rerun = vi.fn(async () => {
      throw new Error('must not rerun plugins');
    });
    const controller = new PromptPreviewController({
      prepareExecutionModelRequest: async () => {
        exact = await prepareAgentModelRequest(context, definition, history, {
          route,
          conversationId: 'conversation',
          stream: true,
          inputText: 'unsent',
        });
        return store.createSession({ request: exact.request, provenance: exact.provenance });
      },
      previewClient: {
        generatePreview: rerun,
        getAuditPage: async request => store.getPage(request),
        getAuditDetail: async request => store.getDetail(request),
        releaseAuditSession: request => {
          store.release(request);
        },
      },
    });
    const preview = await controller.generate(definition.agentFrameworkConfig!, 'conversation', 'unsent');
    expect(preview).not.toBeNull();
    expect(pluginCalls).toBe(1);
    expect(rerun).not.toHaveBeenCalled();
    expect(exact!.provenance.map(item => item.source)).toEqual([
      'prompt',
      'prompt',
      'context-compaction-summary',
      'conversation-message',
      'conversation-message',
      'tool',
      'conversation-message',
      'preview-input',
    ]);
    expect(exact!.provenance[0].promptPath).toEqual([
      { id: 'root', caption: 'Policy', fieldPaths: ['prompts', 'root'] },
      { id: 'policy', caption: 'Instructions', fieldPaths: ['prompts', 'root', 'policy'] },
    ]);
    expect(exact!.provenance[1].promptPath?.at(-1)?.fieldPaths).toEqual(['plugins', 'dynamic-config']);
    expect(exact!.provenance.slice(2, 7).map(item => item.messageId)).toEqual(history.map(item => item.messageId));

    const reconstructed: unknown[] = [];
    let page = await controller.getAuditPage({
      sessionId: 'session',
      expectedRevision: 'revision',
      mode: 'around',
      entryIndex: 0,
      limit: 2,
      maxBytes: 4_096,
    });
    while (true) {
      for (const entry of page.items) {
        const chunk = await controller.getAuditDetail({
          sessionId: 'session',
          expectedRevision: 'revision',
          target: { kind: 'entry', entryId: entry.entryId, entryIndex: entry.entryIndex },
          maxBytes: 4_096,
        });
        expect(chunk.complete).toBe(true);
        reconstructed.push(JSON.parse(new TextDecoder().decode(chunk.canonicalUtf8)));
      }
      if (!page.nextCursor) break;
      page = await controller.getAuditPage({
        sessionId: 'session',
        expectedRevision: 'revision',
        mode: 'after',
        cursor: page.nextCursor,
        limit: 2,
        maxBytes: 4_096,
      });
    }
    expect(reconstructed).toEqual(exact!.request.messages);
    expect(pluginCalls).toBe(1);
  });

  it('retains a configured user prompt when the historical attachment cannot be appended by prompt concat', async () => {
    const readAttachmentFile = vi.fn(async () => {
      throw new Error('file unavailable');
    });
    const context = {
      agentToolLoop: { readAttachmentFile },
      promptPlugins: new Map(),
      tools: {},
    } as unknown as AgentFrameworkContext;
    const definition: AgentDefinition = {
      id: 'definition',
      name: 'Definition',
      description: '',
      systemPrompt: '',
      tools: [],
      version: '1',
      agentFrameworkConfig: { prompts: [{ id: 'configured-user', role: 'user', text: 'configured instruction' }], plugins: [] },
    };
    const history: ChatMessage = {
      conversationId: 'conversation',
      messageId: 'historical-user',
      turnId: 'historical-user',
      originNodeId: 'node',
      originSequence: 1,
      lamportClock: 1,
      timestamp: 1,
      role: 'user',
      content: 'historical question',
      parts: [{ type: 'text', text: 'historical question' }],
      metadata: { file: { path: 'unavailable-image' } },
    };
    const messages = await buildLlmMessages(context, definition, [history]);
    expect(readAttachmentFile).toHaveBeenCalledOnce();
    expect(messages.map(message => message.content)).toEqual(['configured instruction', 'historical question']);
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
      parts: [{ type: 'text', text: 'The user selected project Atlas.' }],
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

  it('propagates cancellation into an attachment read and does not start the next read', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const readAttachmentData = vi.fn((contentHash: string, options?: { signal?: AbortSignal }) => {
      calls.push(contentHash);
      return new Promise<Uint8Array>((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) {
          reject(new Error('missing attachment read signal'));
          return;
        }
        const rejectAbort = () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('attachment read aborted'));
        };
        if (signal.aborted) {
          rejectAbort();
          return;
        }
        signal.addEventListener('abort', rejectAbort, { once: true });
      });
    });
    const context = {
      agentToolLoop: {},
      storage: { readAttachmentData },
    } as unknown as AgentFrameworkContext;
    const definition: AgentDefinition = {
      id: 'attachment-definition',
      name: 'Attachment definition',
      description: '',
      systemPrompt: '',
      tools: [],
      version: '1',
    };
    const attachment = (suffix: string) => ({
      contentHash: `sha256:${suffix.repeat(64)}`,
      filename: `${suffix}.png`,
      mimeType: 'image/png',
      size: 300_000,
    });
    const history: ChatMessage[] = [
      {
        messageId: 'attachment-a',
        turnId: 'attachment-a',
        conversationId: 'conversation-attachment',
        originNodeId: 'node-a',
        originSequence: 1,
        lamportClock: 1,
        timestamp: 1,
        role: 'user',
        content: 'first',
        parts: [{ type: 'text', text: 'first' }, { type: 'attachment', attachment: attachment('a') }],
        attachments: [attachment('a')],
      },
      {
        messageId: 'attachment-b',
        turnId: 'attachment-b',
        conversationId: 'conversation-attachment',
        originNodeId: 'node-a',
        originSequence: 2,
        lamportClock: 2,
        timestamp: 2,
        role: 'user',
        content: 'second',
        parts: [{ type: 'text', text: 'second' }, { type: 'attachment', attachment: attachment('b') }],
        attachments: [attachment('b')],
      },
    ];

    const pending = buildLlmMessages(context, definition, history, controller.signal);
    await vi.waitFor(() => {
      expect(readAttachmentData).toHaveBeenCalledOnce();
    });
    expect(readAttachmentData).toHaveBeenCalledWith(
      attachment('a').contentHash,
      { signal: controller.signal },
    );
    controller.abort(new Error('cancel slow attachment read'));
    await expect(pending).rejects.toThrow('cancel slow attachment read');
    expect(calls).toEqual([attachment('a').contentHash]);
  });
});
