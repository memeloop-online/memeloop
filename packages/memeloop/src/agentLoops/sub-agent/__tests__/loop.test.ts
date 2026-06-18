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

  it('loads an importable module script from the active profile by default', async () => {
    const definition = createSubAgentLoopDefinition();
    const source = `
      export default async function* run({ input }) {
        yield { type: 'message', data: 'module:' + input.message };
      }
    `;
    const runner = definition.createRunner({
      profile: {
        id: 'profile:sub-module',
        name: 'Sub Module',
        description: 'Sub module',
        loopId: 'sub-agent',
        script: `data:text/javascript,${encodeURIComponent(source)}`,
      },
    });

    const steps = await collect(runner({ conversationId: 'c-module', message: 'run' }));

    expect(steps).toContainEqual({ type: 'message', data: 'module:run' });
  });

  it('runs an async .mjs-style script with ctx.runAgents and ctx.finish', async () => {
    const definition = createSubAgentLoopDefinition();
    const childRuns: Array<{ profileId: string; prompt: string; conversationId: string }> = [];
    const source = `
      export default async function run(ctx) {
        const results = await ctx.runAgents([
          { profile: 'worker:a', prompt: ctx.input.message, conversationId: 'child-a' },
          { profileId: 'worker:b', prompt: ctx.input.message, conversationId: 'child-b' },
        ]);
        ctx.finish(results.map(result => result.text).join('|'));
      }
    `;
    const runner = definition.createRunner({
      profile: {
        id: 'profile:script-api',
        name: 'Script API',
        description: 'Script API',
        loopId: 'sub-agent',
        script: `data:text/javascript,${encodeURIComponent(source)}`,
      },
      runtime: {
        async *runChildAgent(input: Parameters<AgentLoopRuntime['runChildAgent']>[0]) {
          childRuns.push(input);
          yield { type: 'message', data: `result:${input.profileId}` };
        },
        log: () => undefined,
        emit: () => undefined,
        signal: { cancelled: false },
      },
    });

    const steps = await collect(runner({ conversationId: 'parent-script', message: 'task' }));

    expect(childRuns).toEqual([
      { profileId: 'worker:a', prompt: 'task', conversationId: 'child-a' },
      { profileId: 'worker:b', prompt: 'task', conversationId: 'child-b' },
    ]);
    expect(steps).toContainEqual({ type: 'message', data: 'result:worker:a|result:worker:b' });
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

  it('aggregates child profile failures without dropping successful child output', async () => {
    const definition = createSubAgentLoopDefinition();
    const runner = definition.createRunner({
      childProfiles: ['profile:ok', 'profile:fail'],
      runtime: {
        async *runChildAgent(input: Parameters<AgentLoopRuntime['runChildAgent']>[0]) {
          if (input.profileId === 'profile:fail') throw new Error('boom');
          yield { type: 'message', data: `child:${input.profileId}` };
        },
        log: () => undefined,
        signal: { cancelled: false },
      },
    });

    const steps = await collect(runner({ conversationId: 'parent-fail', message: 'task' }));
    const message = steps.find(step => step.type === 'message')?.data;

    expect(message).toContain('child:profile:ok');
    expect(message).toContain('Failed child agents:');
    expect(message).toContain('profile:fail: boom');
  });

  it('stops configured child profile execution when cancelled', async () => {
    const definition = createSubAgentLoopDefinition();
    const signal = { cancelled: true };
    const runner = definition.createRunner({
      childProfiles: ['profile:a'],
      runtime: {
        async *runChildAgent() {
          yield { type: 'message', data: 'should-not-run' };
        },
        log: () => undefined,
        signal,
      },
    });

    const steps = await collect(runner({ conversationId: 'parent-cancel', message: 'task' }));

    expect(steps).toContainEqual({
      type: 'thinking',
      data: { status: 'cancelled', conversationId: 'parent-cancel' },
    });
    expect(steps.some(step => step.type === 'message' && step.data === 'should-not-run')).toBe(false);
  });
});
