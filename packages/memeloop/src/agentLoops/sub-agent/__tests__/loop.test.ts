import { describe, expect, it } from 'vitest';

import type { AgentLoopGenerator, AgentLoopRuntime, AgentLoopStep } from '../../types.js';
import { createSubAgentLoopDefinition, type SubAgentLoopScriptArguments } from '../loop.js';

async function collect(generator: AgentLoopGenerator): Promise<AgentLoopStep[]> {
  const steps: AgentLoopStep[] = [];
  for await (const step of generator) {
    steps.push(step);
  }
  return steps;
}

describe('SubAgent_Loop', () => {
  it('delegates control flow to a provided loop script', async () => {
    const definition = createSubAgentLoopDefinition();
    const runner = definition.createRunner({
      script: async function*({ input }: SubAgentLoopScriptArguments) {
        yield { type: 'message', data: `script:${input.message}` };
      },
    });

    const steps = await collect(runner({ conversationId: 'c1', message: 'hello' }));

    expect(steps).toContainEqual({ type: 'message', data: 'script:hello' });
    expect(steps.at(-1)).toEqual({
      type: 'thinking',
      data: { status: 'completed', conversationId: 'c1' },
    });
  });

  it('loads a script from the active profile when a loader is provided', async () => {
    const definition = createSubAgentLoopDefinition();
    const loadedScripts: string[] = [];
    const runner = definition.createRunner({
      profile: {
        id: 'profile:sub',
        name: 'Sub',
        description: 'Sub',
        loopId: 'sub-agent',
        script: './loop.mjs',
      },
      loadScript: (scriptPath: string) => {
        loadedScripts.push(scriptPath);
        return async function*() {
          yield { type: 'message', data: 'loaded-script' };
        };
      },
    });

    const steps = await collect(runner({ conversationId: 'c2', message: 'run' }));

    expect(loadedScripts).toEqual(['./loop.mjs']);
    expect(steps).toContainEqual({ type: 'message', data: 'loaded-script' });
  });

  it('runs configured child profiles when no script is provided', async () => {
    const definition = createSubAgentLoopDefinition();
    const childRuns: Array<{ profileId: string; prompt: string; conversationId: string }> = [];
    const runner = definition.createRunner({
      childProfiles: ['profile:a', 'profile:b'],
      runtime: {
        async *runChildAgent(input: Parameters<AgentLoopRuntime['runChildAgent']>[0]) {
          childRuns.push(input);
          yield { type: 'message', data: `child:${input.profileId}` };
        },
        log: () => undefined,
      },
    });

    const steps = await collect(runner({ conversationId: 'parent', message: 'task' }));

    expect(childRuns).toEqual([
      { profileId: 'profile:a', prompt: 'task', conversationId: 'parent:child:0' },
      { profileId: 'profile:b', prompt: 'task', conversationId: 'parent:child:1' },
    ]);
    expect(steps).toContainEqual({ type: 'message', data: 'child:profile:a\n\nchild:profile:b' });
  });
});
