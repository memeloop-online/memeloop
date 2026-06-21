import { describe, expect, it } from 'vitest';

import type { AgentLoopGenerator, AgentLoopRuntime, AgentLoopStep } from '../../types.js';
import { createSubAgentLoopDefinition, type SubAgentLoopScriptArguments } from '../loop.js';
import { BUILTIN_SUB_AGENT_FANOUT_SCRIPT_ID, BUILTIN_SUB_AGENT_MUTUAL_REVIEW_SCRIPT_ID, BUILTIN_SUB_AGENT_SEQUENTIAL_SCRIPT_ID } from '../scripts/builtinScripts.js';

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
      scriptPolicy: { allowSource: true },
    });

    const steps = await collect(runner({ conversationId: 'c-module', message: 'run' }));

    expect(steps).toContainEqual({ type: 'message', data: 'module:run' });
  });

  it('runs the bundled sequential script through scriptReference and metadata agents', async () => {
    const definition = createSubAgentLoopDefinition();
    const childRuns: Array<{ profileId: string; prompt: string; conversationId: string }> = [];
    const runner = definition.createRunner({
      profile: {
        id: 'profile:bundled-sequential',
        name: 'Bundled Sequential',
        description: 'Bundled sequential',
        loopId: 'sub-agent',
        scriptReference: { kind: 'builtin', id: BUILTIN_SUB_AGENT_SEQUENTIAL_SCRIPT_ID },
        metadata: { agents: ['profile:a', 'profile:b'] },
      },
      runtime: {
        async *runChildAgent(input: Parameters<AgentLoopRuntime['runChildAgent']>[0]) {
          childRuns.push(input);
          yield { type: 'message', data: `child:${input.profileId}` };
        },
        log: () => undefined,
        signal: { cancelled: false },
      },
    });

    const steps = await collect(runner({ conversationId: 'parent-bundled', message: 'task' }));

    expect(childRuns).toEqual([
      { profileId: 'profile:a', prompt: 'task', conversationId: 'parent-bundled:child:0' },
      { profileId: 'profile:b', prompt: 'task', conversationId: 'parent-bundled:child:1' },
    ]);
    expect(steps).toContainEqual({ type: 'message', data: 'child:profile:a\n\nchild:profile:b' });
  });

  it('runs the bundled fanout script with configured agents', async () => {
    const definition = createSubAgentLoopDefinition();
    const childRuns: Array<{ profileId: string; prompt: string; conversationId: string }> = [];
    const runner = definition.createRunner({
      profile: {
        id: 'profile:bundled-fanout',
        name: 'Bundled Fanout',
        description: 'Bundled fanout',
        loopId: 'sub-agent',
        scriptReference: { kind: 'builtin', id: BUILTIN_SUB_AGENT_FANOUT_SCRIPT_ID },
        metadata: { agents: ['profile:a', 'profile:b'] },
      },
      runtime: {
        async *runChildAgent(input: Parameters<AgentLoopRuntime['runChildAgent']>[0]) {
          childRuns.push(input);
          yield { type: 'message', data: `fanout:${input.profileId}` };
        },
        signal: { cancelled: false },
      },
    });

    const steps = await collect(runner({ conversationId: 'parent-fanout', message: 'task' }));

    expect(childRuns).toEqual([
      { profileId: 'profile:a', prompt: 'task', conversationId: 'parent-fanout:child:0' },
      { profileId: 'profile:b', prompt: 'task', conversationId: 'parent-fanout:child:1' },
    ]);
    expect(steps).toContainEqual({ type: 'message', data: 'fanout:profile:a\n\nfanout:profile:b' });
  });

  it('runs the bundled mutual-review script with configured agents', async () => {
    const definition = createSubAgentLoopDefinition();
    const childRuns: Array<{ profileId: string; prompt: string; conversationId: string }> = [];
    const runner = definition.createRunner({
      profile: {
        id: 'profile:bundled-mutual-review',
        name: 'Bundled Mutual Review',
        description: 'Bundled mutual review',
        loopId: 'sub-agent',
        scriptReference: { kind: 'builtin', id: BUILTIN_SUB_AGENT_MUTUAL_REVIEW_SCRIPT_ID },
        metadata: { agents: ['profile:a', 'profile:b'] },
      },
      runtime: {
        async *runChildAgent(input: Parameters<AgentLoopRuntime['runChildAgent']>[0]) {
          childRuns.push(input);
          const prefix = input.conversationId.includes(':review:') ? 'review' : 'draft';
          yield { type: 'message', data: `${prefix}:${input.profileId}` };
        },
        signal: { cancelled: false },
      },
    });

    const steps = await collect(runner({ conversationId: 'parent-review', message: 'task' }));
    const messageData = steps.find(step => step.type === 'message')?.data;
    const message = typeof messageData === 'string' ? messageData : '';

    expect(childRuns.map(run => run.conversationId)).toEqual([
      'parent-review:child:0',
      'parent-review:child:1',
      'parent-review:review:0',
      'parent-review:review:1',
    ]);
    expect(message).toContain('Drafts:');
    expect(message).toContain('draft:profile:a');
    expect(message).toContain('Reviews:');
    expect(message).toContain('review:profile:b');
  });

  it('rejects source script refs unless the host explicitly allows them', async () => {
    const definition = createSubAgentLoopDefinition();
    const source = `export default function run() { return 'source-ok'; }`;
    const runner = definition.createRunner({
      profile: {
        id: 'profile:source-denied',
        name: 'Source Denied',
        description: 'Source denied',
        loopId: 'sub-agent',
        scriptReference: { kind: 'source', source },
      },
    });

    await expect(collect(runner({ conversationId: 'source-denied', message: 'run' })))
      .rejects.toThrow('source strings are disabled');
  });

  it('runs source script refs when policy allows source loading', async () => {
    const definition = createSubAgentLoopDefinition();
    const source = `export default function run(ctx) { return 'source:' + ctx.input.message; }`;
    const runner = definition.createRunner({
      profile: {
        id: 'profile:source-allowed',
        name: 'Source Allowed',
        description: 'Source allowed',
        loopId: 'sub-agent',
        scriptReference: { kind: 'source', source, name: 'source-allowed.mjs' },
      },
      scriptPolicy: { allowSource: true },
    });

    const steps = await collect(runner({ conversationId: 'source-allowed', message: 'run' }));

    expect(steps).toContainEqual({ type: 'message', data: 'source:run' });
  });

  it('passes state and checkpoint APIs to scripts', async () => {
    const definition = createSubAgentLoopDefinition();
    const stateValues = new Map<string, unknown>();
    const checkpoints = new Map<string, unknown>();
    const runner = definition.createRunner({
      script: async (ctx: SubAgentLoopScriptArguments) => {
        await ctx.state.set('seen', ctx.input.message);
        await ctx.state.update('count', previous => Number(previous ?? 0) + 1);
        await ctx.checkpoint('after-state', await ctx.state.get('seen'));
        ctx.finish(`state:${String(await ctx.state.get('seen'))}:${String(await ctx.state.get('count'))}`);
      },
      runtime: {
        state: {
          get: async <T>(key: string) => stateValues.get(key) as T | undefined,
          set: async (key: string, value: unknown) => {
            stateValues.set(key, value);
          },
          update: async (key: string, updater: (previous: unknown) => unknown) => {
            stateValues.set(key, updater(stateValues.get(key)));
          },
        },
        checkpoint: async (key: string, result: unknown) => {
          checkpoints.set(key, result);
        },
      },
    });

    const steps = await collect(runner({ conversationId: 'stateful', message: 'saved' }));

    expect(steps).toContainEqual({ type: 'message', data: 'state:saved:1' });
    expect(checkpoints.get('after-state')).toBe('saved');
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
      scriptPolicy: { allowSource: true },
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

  it('runs configured agents when no script is provided', async () => {
    const definition = createSubAgentLoopDefinition();
    const childRuns: Array<{ profileId: string; prompt: string; conversationId: string }> = [];
    const runner = definition.createRunner({
      agents: ['profile:a', 'profile:b'],
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

  it('aggregates child agent failures without dropping successful child output', async () => {
    const definition = createSubAgentLoopDefinition();
    const runner = definition.createRunner({
      agents: ['profile:ok', 'profile:fail'],
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

  it('stops configured agent execution when cancelled', async () => {
    const definition = createSubAgentLoopDefinition();
    const signal = { cancelled: true };
    const runner = definition.createRunner({
      agents: ['profile:a'],
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
