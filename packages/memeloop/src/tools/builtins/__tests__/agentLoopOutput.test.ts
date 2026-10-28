import { describe, expect, it, vi } from 'vitest';

import type { AgentLoopStep } from '../../../loopAPI/types.js';
import { collectAgentLoopText } from '../agentLoopOutput.js';

describe('collectAgentLoopText', () => {
  it('collects canonical text deltas alongside legacy host message shapes', async () => {
    async function* source(): AsyncGenerator<AgentLoopStep> {
      yield { type: 'message', data: { type: 'text-delta', id: 'text-1', text: 'typed ' } };
      yield { type: 'message', data: { content: 'legacy' } };
    }

    await expect(collectAgentLoopText(source())).resolves.toBe('typed legacy');
  });

  it('aborts a pending read and returns the owned iterator exactly once', async () => {
    const controller = new AbortController();
    const return_ = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source: AsyncIterable<AgentLoopStep> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<AgentLoopStep>>(() => {}),
          return: return_,
        };
      },
    };
    const pending = collectAgentLoopText(source, controller.signal);

    controller.abort(new Error('child-agent-cancelled'));

    await expect(pending).rejects.toThrow('child-agent-cancelled');
    expect(return_).toHaveBeenCalledTimes(1);
  });
});
