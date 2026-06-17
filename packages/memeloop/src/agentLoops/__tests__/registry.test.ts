import { beforeEach, describe, expect, it } from 'vitest';

import { LLM_IO_LOOP_ID, registerBuiltinLoops, SUB_AGENT_LOOP_ID } from '../plugins/builtinLoopsPlugin.js';
import { getLoopRegistry, resetLoopRegistry } from '../registry.js';
import type { LoopProfile } from '../types.js';

interface InstallCall {
  id: string;
  config: Record<string, unknown> | undefined;
  target: { [key: string]: unknown };
}

function makeProfile(overrides: Partial<LoopProfile> = {}): LoopProfile {
  return {
    id: 'profile:test',
    name: 'Test Profile',
    description: 'Test profile',
    loopId: 'llm-io',
    ...overrides,
  };
}

describe('LoopRegistry', () => {
  beforeEach(() => {
    resetLoopRegistry();
  });

  it('registers the builtin loop definitions once', () => {
    const registry = getLoopRegistry();

    registerBuiltinLoops();
    registerBuiltinLoops();

    expect(registry.getLoop(LLM_IO_LOOP_ID)?.id).toBe(LLM_IO_LOOP_ID);
    expect(registry.getLoop(SUB_AGENT_LOOP_ID)?.id).toBe(SUB_AGENT_LOOP_ID);
    expect(registry.listLoops().map(loop => loop.id).sort()).toEqual([
      LLM_IO_LOOP_ID,
      SUB_AGENT_LOOP_ID,
    ].sort());
    expect(registry.createRunner(SUB_AGENT_LOOP_ID)).not.toBeNull();
  });

  it('installs only enabled profile plugins and passes plugin config', () => {
    const registry = getLoopRegistry();
    const calls: InstallCall[] = [];

    registry.registerPlugin({
      id: 'plugin:alpha',
      targetLoopId: 'llm-io',
      install: (target, config) => calls.push({ id: 'plugin:alpha', config, target }),
    });
    registry.registerPlugin({
      id: 'plugin:beta',
      targetLoopId: 'llm-io',
      install: (target, config) => calls.push({ id: 'plugin:beta', config, target }),
    });
    registry.registerPlugin({
      id: 'plugin:gamma',
      targetLoopId: 'llm-io',
      install: (target, config) => calls.push({ id: 'plugin:gamma', config, target }),
    });

    const profile = makeProfile({
      plugins: [
        { id: 'plugin:alpha', config: { threshold: 3 } },
        { id: 'plugin:beta', enabled: false, config: { ignored: true } },
      ],
    });
    const target = { marker: 'target' };

    registry.installPluginsForProfile(profile, target);

    expect(calls).toEqual([{ id: 'plugin:alpha', config: { threshold: 3 }, target }]);
  });

  it('creates profile runners after installing profile plugins', async () => {
    const registry = getLoopRegistry();
    const target = { marker: 'target' };
    const calls: string[] = [];

    registry.registerLoop({
      id: 'loop:test',
      name: 'Test Loop',
      description: 'Test loop',
      createRunner: context =>
        async function*() {
          yield { type: 'message', data: context.installed };
        },
    });
    registry.registerPlugin({
      id: 'plugin:alpha',
      targetLoopId: 'loop:test',
      install: context => {
        calls.push(String(context.marker));
        context.installed = 'alpha-installed';
      },
    });

    const runner = registry.createRunnerForProfile(
      makeProfile({ loopId: 'loop:test', plugins: [{ id: 'plugin:alpha' }] }),
      target,
    );

    expect(runner).not.toBeNull();
    const steps = [];
    for await (const step of runner?.({ conversationId: 'c1', message: 'run' }) ?? []) {
      steps.push(step);
    }
    expect(calls).toEqual(['target']);
    expect(steps).toEqual([{ type: 'message', data: 'alpha-installed' }]);
  });

  it('respects plugin target loop ids when installing profile plugins', () => {
    const registry = getLoopRegistry();
    const calls: string[] = [];

    registry.registerPlugin({
      id: 'plugin:sub-agent-only',
      targetLoopId: 'sub-agent',
      install: () => calls.push('sub-agent'),
    });
    registry.registerPlugin({
      id: 'plugin:any-loop',
      targetLoopId: '*',
      install: () => calls.push('any-loop'),
    });

    registry.installPluginsForProfile(
      makeProfile({
        loopId: 'llm-io',
        plugins: [{ id: 'plugin:sub-agent-only' }, { id: 'plugin:any-loop' }],
      }),
      {},
    );

    expect(calls).toEqual(['any-loop']);
  });

  it('keeps installPluginsForLoop compatible with string selections', () => {
    const registry = getLoopRegistry();
    const calls: string[] = [];

    registry.registerPlugin({
      id: 'plugin:alpha',
      targetLoopId: '*',
      install: () => calls.push('alpha'),
    });
    registry.registerPlugin({
      id: 'plugin:beta',
      targetLoopId: '*',
      install: () => calls.push('beta'),
    });

    registry.installPluginsForLoop('llm-io', {}, ['plugin:beta']);

    expect(calls).toEqual(['beta']);
  });
});
