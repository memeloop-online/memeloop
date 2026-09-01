import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type ChatMessage, MAX_CONVERSATION_MESSAGE_WINDOW_BYTES, MAX_CONVERSATION_MESSAGE_WINDOW_SIZE } from 'memeloop';

import { SQLiteAgentStorage } from '../../storage/sqliteStorage.js';
import { startMockOpenAI } from '../../testing/mockOpenAI.js';
import { createNodeRuntime } from '../nodeRuntime.js';
import { ToolRegistry } from '../toolRegistry.js';

const INTEGRATION_TEST_TIMEOUT_MS = 30_000;
const configuredModel = {
  defaultModelConfig: { providerId: 'oai', modelId: 'test-model' },
  models: [{ id: 'test-model', name: 'Mock model' }],
} as const;

function includesText(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.includes(expected);
}

async function readTestMessages(
  storage: Pick<SQLiteAgentStorage, 'getFullContentMessagePage'>,
  conversationId: string,
): Promise<ChatMessage[]> {
  const page = await storage.getFullContentMessagePage(conversationId, {
    limit: MAX_CONVERSATION_MESSAGE_WINDOW_SIZE,
    maxBytes: MAX_CONVERSATION_MESSAGE_WINDOW_BYTES,
  });
  if (page.reset) throw new Error('unexpected message-page reset without a cursor');
  if (page.hasMoreBefore || page.hasMoreAfter) {
    throw new Error('integration fixture unexpectedly exceeded one bounded message page');
  }
  return page.items;
}

describe('createNodeRuntime + mock OpenAI HTTP', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  it('completes a user turn with JSON chat/completions (dialogue)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-oai-'));
    dirs.push(dataDir);
    const mock = await startMockOpenAI([{ response: 'mock says hello', stream: true }]);
    try {
      const { runtime, storage } = await createNodeRuntime({
        config: {
          providers: [{
            name: 'oai',
            baseUrl: mock.baseUrl,
            apiKey: 'k',
            models: configuredModel.models.map(model => ({ ...model })),
          }],
          defaultModelConfig: configuredModel.defaultModelConfig,
        },
        dataDir,
      });
      const { conversationId } = await runtime.createAgent({
        definitionId: 'memeloop:general-assistant',
      });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          reject(new Error('timeout'));
        }, 20_000);
        const off = runtime.subscribeToUpdates(conversationId, (u) => {
          const update = u as {
            type?: string;
            error?: string;
            step?: { type?: string; data?: unknown };
          };
          if (update.type === 'agent-step') {
            const step = update.step;
            if (step) {
              // debugging: log step types
              void step;
            }
          }
          if (update.type === 'agent-done') {
            clearTimeout(t);
            off();
            resolve();
          }
          if (update.type === 'agent-error') {
            clearTimeout(t);
            off();
            reject(
              new Error(
                typeof update.error === 'string'
                  ? update.error
                  : JSON.stringify(update.error ?? 'agent-error'),
              ),
            );
          }
        });
        void runtime.sendMessage({ conversationId, message: 'hi' });
      });

      const msgs = await readTestMessages(storage, conversationId);
      expect(msgs.some((m) => m.role === 'user')).toBe(true);
      expect(
        msgs.some((m) =>
          m.role === 'assistant' &&
          includesText(m.content, 'mock says hello')
        ),
        JSON.stringify(msgs),
      ).toBe(true);
    } finally {
      await mock.stop();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('runs a tool round-trip: first completion requests tool, second completes', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-oai-tool-'));
    dirs.push(dataDir);
    const mock = await startMockOpenAI([
      { response: '<tool_use name="e2eEcho">{"text":"openai-mock"}</tool_use>', stream: true },
      { response: 'final line after tool execution', stream: true },
    ]);
    try {
      const { runtime, storage } = await createNodeRuntime({
        config: {
          providers: [{
            name: 'oai',
            baseUrl: mock.baseUrl,
            apiKey: 'k',
            models: configuredModel.models.map(model => ({ ...model })),
          }],
          defaultModelConfig: configuredModel.defaultModelConfig,
          tools: { allowlist: ['e2eEcho'] },
        },
        dataDir,
        agentToolLoop: { legacyTextToolCalls: true },
        configureTools(registry) {
          registry.registerTool(
            'e2eEcho',
            async (args: Record<string, unknown>) => ({
              echoed: typeof args.text === 'string' ? args.text : '',
            }),
            z.object({ text: z.string() }).strict(),
          );
        },
      });

      const { conversationId } = await runtime.createAgent({
        definitionId: 'memeloop:general-assistant',
      });

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          reject(new Error('timeout'));
        }, 25_000);
        const off = runtime.subscribeToUpdates(conversationId, (u) => {
          if ((u as { type?: string }).type === 'agent-done') {
            clearTimeout(t);
            off();
            resolve();
          }
          if ((u as { type?: string }).type === 'agent-error') {
            clearTimeout(t);
            off();
            const error = (u as { error?: unknown }).error;
            reject(new Error(typeof error === 'string' ? error : JSON.stringify(error ?? 'agent-error')));
          }
        });
        void runtime.sendMessage({ conversationId, message: 'use echo' });
      });

      const msgs = await readTestMessages(storage, conversationId);
      expect(
        msgs.some((m) => m.role === 'tool'),
        JSON.stringify(msgs),
      ).toBe(true);
      const toolMsg = msgs.find((m) => m.role === 'tool');
      expect(
        toolMsg?.parts?.some(part => part.type === 'tool-result' && part.toolName === 'e2eEcho'),
        JSON.stringify(toolMsg),
      ).toBe(true);
      expect(
        msgs.some((m) =>
          m.role === 'assistant' &&
          includesText(m.content, 'final line after tool')
        ),
      ).toBe(true);
    } finally {
      await mock.stop();
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it('registers node environment tools in memeloop-cli runtime', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-tools-'));
    dirs.push(dataDir);
    const mock = await startMockOpenAI([{ response: 'ok' }]);
    try {
      const { toolRegistry } = await createNodeRuntime({
        config: {
          providers: [{
            name: 'oai',
            baseUrl: mock.baseUrl,
            apiKey: 'k',
            models: configuredModel.models.map(model => ({ ...model })),
          }],
          defaultModelConfig: configuredModel.defaultModelConfig,
        },
        dataDir,
      });
      const tools = toolRegistry.listTools();
      expect(tools).toContain('file.read');
      expect(tools).toContain('git');
      expect(tools).toContain('webFetch');
      expect(tools).toContain('todo');
      expect(tools).toContain('summary');
    } finally {
      await mock.stop();
    }
  });

  it('drains the MemeLoop runtime before closing its owned SQLite storage', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-stop-order-'));
    dirs.push(dataDir);
    const mock = await startMockOpenAI([{ response: 'ok' }]);
    try {
      const node = await createNodeRuntime({
        config: {
          providers: [{
            name: 'oai',
            baseUrl: mock.baseUrl,
            apiKey: 'k',
            models: configuredModel.models.map(model => ({ ...model })),
          }],
          defaultModelConfig: configuredModel.defaultModelConfig,
        },
        dataDir,
      });
      const order: string[] = [];
      const originalDispose = node.runtime.dispose.bind(node.runtime);
      const originalClose = (node.storage as SQLiteAgentStorage).close.bind(node.storage);
      vi.spyOn(node.runtime, 'dispose').mockImplementation(async () => {
        order.push('runtime.dispose');
        await originalDispose();
      });
      vi.spyOn(node.storage as SQLiteAgentStorage, 'close').mockImplementation(() => {
        order.push('storage.close');
        originalClose();
      });

      await node.stop();

      expect(order).toEqual(['runtime.dispose', 'storage.close']);
    } finally {
      await mock.stop();
    }
  });

  it('embed / SDK mode: injected storage + llmProvider without dataDir', async () => {
    const storage = new SQLiteAgentStorage({ filename: ':memory:' });
    const llmProvider = {
      name: 'embed-test',
      model: {},
      chat: async function*() {
        yield { type: 'text-delta' as const, id: 'embed-delta', text: 'ok' };
        yield { type: 'finish' as const, finishReason: 'stop' };
      },
    };
    const { runtime, providerRegistry } = await createNodeRuntime({
      storage,
      llmProvider,
      toolRegistry: new ToolRegistry(),
    });
    expect(runtime).toBeDefined();
    expect(providerRegistry).toBeDefined();
  });
});
