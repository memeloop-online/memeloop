import { describe, expect, it, vi } from 'vitest';

import { configureLoopTestContext } from '../../__tests__/testLoopContext.js';
import { createTestStorage } from '../../__tests__/testStorage.js';
import type { ChatMessage } from '../../conversation/index.js';
import type { AgentFrameworkContext } from '../../types.js';
import { AGENT_USER_MESSAGE_LIMITS } from '../../userMessageAdmission.js';
import { createAgentToolLoopState, startAgentToolLoopTurn } from '../agent-tool-loop/turnPrimitives.js';

describe('persisted user-message admission', () => {
  it('cannot bypass the whole-message ceiling through persistedUserMessage', async () => {
    const storage = createTestStorage();
    const chat = vi.fn(async () => 'must not execute');
    const context = configureLoopTestContext({
      storage,
      llmProvider: { name: 'persisted-limit-provider', chat },
      tools: {
        registerTool: vi.fn(),
        getTool: vi.fn(),
        listTools: vi.fn().mockReturnValue([]),
      },
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      localNodeId: 'persisted-limit-local-node',
    } as unknown as AgentFrameworkContext);
    const persistedUserMessage: ChatMessage = {
      messageId: 'persisted-limit-turn',
      turnId: 'persisted-limit-turn',
      conversationId: 'persisted-limit-conversation',
      originNodeId: 'persisted-limit-source-node',
      originSequence: 1,
      lamportClock: 1,
      timestamp: 1,
      role: 'user',
      content: '',
      parts: [],
      metadata: {
        padding: 'x'.repeat(AGENT_USER_MESSAGE_LIMITS.canonicalMessageBytes),
      },
    };

    await expect(startAgentToolLoopTurn(context, {
      conversationId: persistedUserMessage.conversationId,
      message: '',
      persistedUserMessage,
    }, createAgentToolLoopState(context))).rejects.toMatchObject({
      agentRunError: { code: 'USER_MESSAGE_TOO_LARGE' },
    });
    expect(chat).not.toHaveBeenCalled();
    expect(storage.state.events).toEqual([]);
  });
});
