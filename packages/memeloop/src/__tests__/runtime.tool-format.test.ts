import { expect, it, vi } from 'vitest';
import { createMemeLoopRuntime } from '../runtime.js';
import type { AgentFrameworkContext } from '../types.js';

const complete = '<tool_use name="save">{"title":"Example"}</tool_use>';
const mixed = '<tool_use name="save">{"title":"Example"}</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>';

function fixture(replies: string[]) {
  const messages: Array<{ role: string; content: string }> = [];
  const definition = {
    id: 'test', name: 'test', description: 'test', version: '1',
    loopId: 'agent-tool-loop', tools: ['save'], systemPrompt: 'Save an example.',
  };
  const save = vi.fn(async () => 'saved');
  const chat = vi.fn(() => replies.shift() ?? 'done');
  const context = {
    storage: {
      listConversations: async () => [],
      getMessages: async () => [...messages],
      appendMessage: async (message: { role: string; content: string }) => { messages.push(message); },
      upsertConversationMetadata: async () => {},
      insertMessagesIfAbsent: async () => {},
      getConversationMeta: async () => ({ definitionId: 'test' }),
      getAgentDefinition: async () => definition,
    },
    resolveAgentDefinition: async () => definition,
    tools: { getTool: () => save, listTools: () => ['save'], getPromptPlugins: () => new Map() },
    llmProvider: { name: 'test', chat },
    agentToolLoop: { maxIterations: 5, toolPermissions: { default: 'allow' }, sessionCheckpoint: { enabled: false } },
  } as unknown as AgentFrameworkContext;
  const runtime = createMemeLoopRuntime(context);
  const send = async () => {
    const { conversationId } = await runtime.createAgent({ definitionId: 'test' });
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
    void done.catch(() => {});
    await runtime.sendMessage({ conversationId, definitionId: 'test', message: 'Save an example.' });
    await done;
  };
  return { messages, save, chat, send };
}

it('preserves a malformed response and repairs it before dispatching the tool', async () => {
  const f = fixture([mixed, complete, 'saved example']);
  await f.send();
  expect(f.save).toHaveBeenCalledTimes(1);
  expect(f.save).toHaveBeenCalledWith({ title: 'Example' });
  expect(f.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'tool', 'assistant']);
  expect(f.messages[1].content).toBe(mixed);
  expect(f.messages[2].content).toContain('No tools from that response were executed');
  expect(f.messages.at(-1)?.content).toBe('saved example');
});

it.each([mixed, complete + mixed, '<tool_use name="save">{"title":</tool_use>'])(
  'fails a repeated malformed response without executing calls: %s', async response => {
    const f = fixture([response, response]);
    await expect(f.send()).rejects.toThrow('TOOL_CALL_FORMAT_ERROR:');
    expect(f.save).not.toHaveBeenCalled();
    expect(f.chat).toHaveBeenCalledTimes(2);
    expect(f.messages.filter(message => message.role === 'assistant').map(message => message.content))
      .toEqual([response, response]);
  },
);

it('keeps complete calls and ordinary final prose on the existing path', async () => {
  const f = fixture([complete, 'saved example']);
  await f.send();
  expect(f.save).toHaveBeenCalledTimes(1);
  expect(f.save).toHaveBeenCalledWith({ title: 'Example' });
  expect(f.chat).toHaveBeenCalledTimes(2);
  expect(f.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
});
