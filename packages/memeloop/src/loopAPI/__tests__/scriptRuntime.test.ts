import { describe, expect, it, vi } from 'vitest';

import { createScriptStepEmitter, yieldScriptResult } from '../scriptRuntime.js';
import type { AgentLoopGenerator, AgentLoopStep } from '../types.js';

async function collect(generator: AgentLoopGenerator): Promise<AgentLoopStep[]> {
  const steps: AgentLoopStep[] = [];
  for await (const step of generator) steps.push(step);
  return steps;
}

describe('shared script runtime', () => {
  it('preserves emitted-step ordering around an async iterable result', async () => {
    const emittedSteps: AgentLoopStep[] = [];
    const onEmit = vi.fn();
    const emit = createScriptStepEmitter(emittedSteps, onEmit);
    const before: AgentLoopStep = { type: 'thinking', data: 'before' };
    const yielded: AgentLoopStep = { type: 'message', data: 'yielded' };
    const after: AgentLoopStep = { type: 'thinking', data: 'after' };
    emit(before);

    const result = (async function*(): AgentLoopGenerator {
      yield yielded;
      emit(after);
    })();

    await expect(collect(yieldScriptResult(result, emittedSteps))).resolves.toEqual([before, yielded, after]);
    expect(onEmit).toHaveBeenCalledTimes(2);
  });

  it('normalizes string results into message steps', async () => {
    await expect(collect(yieldScriptResult('done', []))).resolves.toEqual([{ type: 'message', data: 'done' }]);
  });
});
