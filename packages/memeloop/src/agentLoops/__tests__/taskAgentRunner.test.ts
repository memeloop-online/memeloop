import { describe, expect, it } from 'vitest';

import type { AgentFrameworkContext } from '../../types.js';
import { resolveTaskAgentTerminalState, runTaskAgentTurn } from '../llm-io/runner.js';

const unusedContext: AgentFrameworkContext = {
  storage: undefined as never,
  llmProvider: undefined as never,
  tools: undefined as never,
  syncAdapters: [],
  network: undefined as never,
};

describe('runTaskAgentTurn', () => {
  it('resolves terminal state from task-agent thinking steps', async () => {
    const progress: string[] = [];
    const result = await runTaskAgentTurn(
      unusedContext,
      { conversationId: 'c1', message: 'hello' },
      {
        taskAgent: async function*() {
          yield { type: 'thinking', data: { status: 'calling-llm' } };
          yield { type: 'message', data: 'partial' };
          yield { type: 'thinking', data: { status: 'input-required' } };
        },
        onProgress: (status) => {
          progress.push(status);
        },
      },
    );

    expect(result).toEqual({ state: 'input-required', stepCount: 3 });
    expect(progress).toEqual(['calling-llm', 'input-required']);
  });

  it('normalizes non-terminal working state to completed', async () => {
    const result = await runTaskAgentTurn(
      unusedContext,
      { conversationId: 'c1', message: 'hello' },
      {
        taskAgent: async function*() {
          yield { type: 'thinking', data: { status: 'calling-llm' } };
          yield { type: 'message', data: 'done' };
        },
      },
    );

    expect(result.state).toBe('completed');
  });
});

describe('resolveTaskAgentTerminalState', () => {
  it('maps task-agent statuses to AgentInstanceState', () => {
    expect(
      resolveTaskAgentTerminalState({ type: 'thinking', data: { status: 'cancelled' } }, 'working'),
    ).toBe('canceled');
    expect(
      resolveTaskAgentTerminalState({ type: 'thinking', data: { status: 'blocked' } }, 'working'),
    ).toBe('failed');
    expect(
      resolveTaskAgentTerminalState(
        { type: 'thinking', data: { status: 'max-iterations' } },
        'working',
      ),
    ).toBe('completed');
  });
});
