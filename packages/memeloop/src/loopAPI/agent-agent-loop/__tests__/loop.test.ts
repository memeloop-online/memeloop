import { describe, expect, it } from 'vitest';

import { BUILTIN_AGENT_AGENT_LOOP_QUALITY_GATE_SCRIPT_ID } from '../../../loops/agent-agent-loop/builtinLoopSources.js';
import type { AgentOrchestrationClient } from '../../../orchestration/index.js';
import type { AgentLoopGenerator, AgentLoopRuntime, AgentLoopStep } from '../../types.js';
import { type AgentAgentLoopScriptArguments, createAgentAgentLoopDefinition } from '../loop.js';

async function collect(generator: AgentLoopGenerator): Promise<AgentLoopStep[]> {
  const steps: AgentLoopStep[] = [];
  for await (const step of generator) {
    steps.push(step);
  }
  return steps;
}

describe('AgentAgent_Loop', () => {
  it('delegates control flow to a provided loop script', async () => {
    const definition = createAgentAgentLoopDefinition();
    const runner = definition.createRunner({
      script: async function*({ input }: AgentAgentLoopScriptArguments) {
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
    const definition = createAgentAgentLoopDefinition();
    const loadedScripts: string[] = [];
    const runner = definition.createRunner({
      profile: {
        id: 'profile:sub',
        name: 'Sub',
        description: 'Sub',
        loopId: 'agent-agent-loop',
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
    const definition = createAgentAgentLoopDefinition();
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
        loopId: 'agent-agent-loop',
        script: `data:text/javascript,${encodeURIComponent(source)}`,
      },
      scriptPolicy: { allowSource: true },
    });

    const steps = await collect(runner({ conversationId: 'c-module', message: 'run' }));

    expect(steps).toContainEqual({ type: 'message', data: 'module:run' });
  });

  it('runs the bundled quality-gate script until a review approves the draft', async () => {
    const definition = createAgentAgentLoopDefinition();
    const childRuns: Array<{ profileId: string; prompt: string; conversationId: string }> = [];
    const runner = definition.createRunner({
      profile: {
        id: 'profile:bundled-quality-gate',
        name: 'Bundled Quality Gate',
        description: 'Bundled quality gate',
        loopId: 'agent-agent-loop',
        scriptReference: { kind: 'builtin', id: BUILTIN_AGENT_AGENT_LOOP_QUALITY_GATE_SCRIPT_ID },
        metadata: {
          workers: ['profile:worker'],
          reviewers: ['profile:reviewer'],
          fixers: ['profile:fixer'],
          maxIterations: 2,
        },
      },
      runtime: {
        async *runChildAgent(input: Parameters<AgentLoopRuntime['runChildAgent']>[0]) {
          childRuns.push(input);
          if (input.profileId === 'profile:reviewer' && input.prompt.includes('draft-v2')) {
            yield { type: 'message', data: 'APPROVED\nready' };
            return;
          }
          if (input.profileId === 'profile:reviewer') {
            yield { type: 'message', data: 'REVISE\nneeds stronger evidence' };
            return;
          }
          if (input.profileId === 'profile:fixer') {
            expect(input.prompt).toContain('Previous deliverable:');
            expect(input.prompt).toContain('needs stronger evidence');
            yield { type: 'message', data: 'draft-v2' };
            return;
          }
          yield { type: 'message', data: 'draft-v1' };
        },
        checkpoint: async () => undefined,
        signal: { cancelled: false },
      },
    });

    const steps = await collect(runner({ conversationId: 'parent-quality', message: 'task' }));
    const messageData = [...steps].reverse().find((step) => step.type === 'message')?.data;

    expect(messageData).toBe('draft-v2');
    expect(childRuns.map(run => run.profileId)).toEqual([
      'profile:worker',
      'profile:reviewer',
      'profile:fixer',
      'profile:reviewer',
    ]);
    expect(childRuns.map(run => run.conversationId)).toEqual([
      'parent-quality:work:1:0',
      'parent-quality:review:1:0',
      'parent-quality:work:2:0',
      'parent-quality:review:2:0',
    ]);
  });

  it('resumes the bundled quality gate without rerunning checkpointed child agents', async () => {
    const definition = createAgentAgentLoopDefinition();
    const childRuns: string[] = [];
    const checkpoints = new Map<string, unknown>([
      ['quality-gate:1:attempt', { results: [{ profileId: 'profile:worker', conversationId: 'saved-work', steps: [], text: 'draft-v1' }], failures: [], text: 'draft-v1' }],
      ['quality-gate:1:review', {
        results: [{ profileId: 'profile:reviewer', conversationId: 'saved-review', steps: [], text: 'REVISE\nneeds evidence' }],
        failures: [],
        text: 'REVISE\nneeds evidence',
      }],
    ]);
    const runner = definition.createRunner({
      profile: {
        id: 'profile:resume-quality-gate',
        name: 'Resume Quality Gate',
        description: 'Resume quality gate',
        loopId: 'agent-agent-loop',
        scriptReference: { kind: 'builtin', id: BUILTIN_AGENT_AGENT_LOOP_QUALITY_GATE_SCRIPT_ID },
        metadata: { workers: ['profile:worker'], reviewers: ['profile:reviewer'], fixers: ['profile:fixer'], maxIterations: 2 },
      },
      runtime: {
        async *runChildAgent(input: Parameters<AgentLoopRuntime['runChildAgent']>[0]) {
          childRuns.push(input.profileId);
          yield { type: 'message', data: input.profileId === 'profile:reviewer' ? 'APPROVED\nready' : 'draft-v2' };
        },
        checkpoint: async (key, result) => {
          checkpoints.set(key, result);
        },
        loadCheckpoint: async <T>(key: string) => checkpoints.get(key) as T | undefined,
        signal: { cancelled: false },
      },
    });

    const steps = await collect(runner({ conversationId: 'parent-resume', message: 'task' }));
    expect([...steps].reverse().find((step) => step.type === 'message')?.data).toBe('draft-v2');
    expect(childRuns).toEqual(['profile:fixer', 'profile:reviewer']);
  });

  it('rejects source script refs unless the host explicitly allows them', async () => {
    const definition = createAgentAgentLoopDefinition();
    const source = `export default function run() { return 'source-ok'; }`;
    const runner = definition.createRunner({
      profile: {
        id: 'profile:source-denied',
        name: 'Source Denied',
        description: 'Source denied',
        loopId: 'agent-agent-loop',
        scriptReference: { kind: 'source', source },
      },
    });

    await expect(collect(runner({ conversationId: 'source-denied', message: 'run' })))
      .rejects.toThrow('source strings are disabled');
  });

  it('runs source script refs when policy allows source loading', async () => {
    const definition = createAgentAgentLoopDefinition();
    const source = `export default function run(ctx) { return 'source:' + ctx.input.message; }`;
    const runner = definition.createRunner({
      profile: {
        id: 'profile:source-allowed',
        name: 'Source Allowed',
        description: 'Source allowed',
        loopId: 'agent-agent-loop',
        scriptReference: { kind: 'source', source, name: 'source-allowed.mjs' },
      },
      scriptPolicy: { allowSource: true },
    });

    const steps = await collect(runner({ conversationId: 'source-allowed', message: 'run' }));

    expect(steps).toContainEqual({ type: 'message', data: 'source:run' });
  });

  it('passes state and checkpoint APIs to scripts', async () => {
    const definition = createAgentAgentLoopDefinition();
    const stateValues = new Map<string, unknown>();
    const checkpoints = new Map<string, unknown>();
    const runner = definition.createRunner({
      script: async (ctx: AgentAgentLoopScriptArguments) => {
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

  it('passes the policy-scoped orchestration facade to scripts unchanged', async () => {
    const definition = createAgentAgentLoopDefinition();
    const orchestration = {
      getCapabilities: async () => ({
        operations: ['apply'] as const,
        resourceKinds: ['AgentWorkload'],
        interfaces: ['resource'] as const,
      }),
    } as unknown as AgentOrchestrationClient;
    const runner = definition.createRunner({
      script: async (ctx: AgentAgentLoopScriptArguments) => {
        expect(ctx.orchestration).toBe(orchestration);
        const capabilities = await ctx.orchestration?.getCapabilities();
        ctx.finish(capabilities?.resourceKinds.join(',') ?? 'missing');
      },
      runtime: { orchestration },
    });

    const steps = await collect(runner({ conversationId: 'orchestrated', message: 'deploy' }));

    expect(steps).toContainEqual({ type: 'message', data: 'AgentWorkload' });
  });

  it('injects a typed agentClient when orchestration is available', async () => {
    const definition = createAgentAgentLoopDefinition();
    const orchestration = {
      getCapabilities: async () => ({
        operations: ['apply'] as const,
        resourceKinds: ['AgentWorkload'],
        interfaces: ['resource'] as const,
      }),
      apply: async () => ({
        apiVersion: 'workload.memeloop.io/v1alpha1',
        kind: 'AgentWorkload',
        metadata: { name: 'child', uid: 'uid-1', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-16T00:00:00.000Z' },
        spec: { profileId: 'worker' },
      }),
    } as unknown as AgentOrchestrationClient;
    const runner = definition.createRunner({
      script: async (ctx: AgentAgentLoopScriptArguments) => {
        expect(ctx.agentClient).toBeDefined();
        const workload = await ctx.agentClient?.createWorkload({ name: 'child', profileId: 'worker' });
        ctx.finish(workload?.metadata.name ?? 'missing');
      },
      runtime: { orchestration },
    });

    const steps = await collect(runner({ conversationId: 'agent-client', message: 'deploy' }));

    expect(steps).toContainEqual({ type: 'message', data: 'child' });
  });

  it('runs an async .mjs-style script with ctx.runAgents and ctx.finish', async () => {
    const definition = createAgentAgentLoopDefinition();
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
        loopId: 'agent-agent-loop',
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

  it('does not infer a workflow from agents without an explicit script', async () => {
    const definition = createAgentAgentLoopDefinition();
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

    expect(childRuns).toEqual([]);
    expect(steps).toContainEqual({
      type: 'message',
      data: 'AgentAgentLoop requires an explicit loop script. Configure profile.scriptReference or provide context.script.',
    });
  });

  it('reports a missing script when no agents are configured', async () => {
    const definition = createAgentAgentLoopDefinition();
    const runner = definition.createRunner({
      profile: {
        id: 'profile:missing-script',
        name: 'Missing Script',
        description: 'Missing Script',
        loopId: 'agent-agent-loop',
      },
    });

    const steps = await collect(runner({ conversationId: 'parent-missing-script', message: 'task' }));

    expect(steps).toContainEqual({
      type: 'message',
      data: 'AgentAgentLoop requires an explicit loop script. Configure profile.scriptReference or provide context.script.',
    });
  });

  it('aggregates child agent failures without dropping successful child output', async () => {
    const definition = createAgentAgentLoopDefinition();
    const runner = definition.createRunner({
      script: async (ctx: AgentAgentLoopScriptArguments) => {
        ctx.finishAgentResults(await ctx.runParallel({ agents: ['profile:ok', 'profile:fail'] }));
      },
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
    const definition = createAgentAgentLoopDefinition();
    const signal = { cancelled: true };
    const runner = definition.createRunner({
      script: async (ctx: AgentAgentLoopScriptArguments) => {
        ctx.finishAgentResults(await ctx.runParallel({ agents: ['profile:a'] }));
      },
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
