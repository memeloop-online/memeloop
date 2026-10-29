// Upstream destination: packages/memeloop/src/__tests__/runtime.cancellation.test.ts
import { expect, it, vi } from 'vitest';

import { createMemeLoopRuntime } from '../runtime.js';
import { runRegistryToolCalls } from '../loopAPI/agent-tool-loop/toolCallRunner.js';
import type { AgentFrameworkContext } from '../types.js';

function fixture() {
  const messages: Array<{ role: string; content: string }> = [];
  const definition = {
    id: 'test', name: 'test', description: 'test', version: '1',
    loopId: 'agent-tool-loop', tools: ['read'], systemPrompt: 'Read the page.',
  };
  const read = vi.fn(async () => 'page');
  const chat = vi.fn();
  const context = {
    storage: {
      listConversations: async () => [],
      getMessages: async () => [...messages],
      // Ignored by upstream; enables the same test with the host's bounded-history patch.
      getModelContext: async () => [...messages],
      appendMessage: async (message: { role: string; content: string }) => { messages.push(message); },
      upsertConversationMetadata: async () => {},
      insertMessagesIfAbsent: async () => {},
      getConversationMeta: async () => ({ definitionId: 'test' }),
      getAgentDefinition: async () => definition,
    },
    resolveAgentDefinition: async () => definition,
    tools: { getTool: () => read, listTools: () => ['read'], getPromptPlugins: () => new Map() },
    llmProvider: { name: 'test', chat },
    agentToolLoop: { maxIterations: 3, toolPermissions: { default: 'allow' }, sessionCheckpoint: { enabled: false } },
  } as unknown as AgentFrameworkContext;
  const runtime = createMemeLoopRuntime(context);
  const send = async (conversationId: string) => {
    const done = new Promise<void>((resolve, reject) => {
      const stop = runtime.subscribeToUpdates(conversationId, (value: unknown) => {
        const update = value as { type: string; error?: string };
        if (update.type === 'agent-done' || update.type === 'agent-error') {
          stop();
          if (update.type === 'agent-error') reject(new Error(update.error));
          else resolve();
        }
      });
    });
    await runtime.sendMessage({ conversationId, definitionId: 'test', message: 'Read the page.' });
    await done;
  };
  return { runtime, context, messages, read, chat, send };
}

const call = '<tool_use name="read">{}</tool_use>';

it('connects runtime cancellation to the default loop and stops the remaining sequential calls', async () => {
  const f = fixture();
  const { conversationId } = await f.runtime.createAgent({ definitionId: 'test' });
  f.chat.mockReturnValueOnce(call + call).mockReturnValue('should not run');
  f.read.mockImplementation(async () => {
    await f.runtime.cancelAgent(conversationId);
    return 'in-flight result';
  });
  await f.send(conversationId);
  expect(f.chat).toHaveBeenCalledTimes(1);
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
  expect(f.messages[2].content).toContain('in-flight result');

  // A new user turn clears the runtime cancellation state.
  f.chat.mockReturnValue('resumed');
  await f.send(conversationId);
  expect(f.messages.at(-1)?.content).toBe('resumed');
});

it.each([false, true])('stops a stream cancelled before its final chunk or return (final=%s)', async final => {
  const f = fixture();
  const { conversationId } = await f.runtime.createAgent({ definitionId: 'test' });
  f.chat.mockReturnValueOnce((async function* () {
    yield final ? call : 'Reading.';
    await f.runtime.cancelAgent(conversationId);
    if (!final) yield call;
  })()).mockReturnValue('should not run');
  await f.send(conversationId);
  expect(f.chat).toHaveBeenCalledTimes(1);
  expect(f.read).not.toHaveBeenCalled();
  expect(f.messages.map(message => message.role)).toEqual(['user']);
});

it('retains the host cancellation callback', async () => {
  const f = fixture();
  f.context.agentToolLoop!.isCancelled = () => true;
  const { conversationId } = await f.runtime.createAgent({ definitionId: 'test' });
  await f.send(conversationId);
  expect(f.chat).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});

it.each([false, true])('does not start an already cancelled tool batch (parallel=%s)', async parallel => {
  const f = fixture();
  const steps = [];
  for await (const step of runRegistryToolCalls({
    context: f.context,
    agentToolLoopOptions: { isCancelled: () => true },
    conversationId: 'cancelled',
    calls: [{ found: true, toolId: 'read', parameters: {}, originalText: call }],
    parallel,
    recentToolCalls: [],
  })) steps.push(step);
  expect(steps).toEqual([]);
  expect(f.read).not.toHaveBeenCalled();
  expect(f.messages).toEqual([]);
});
