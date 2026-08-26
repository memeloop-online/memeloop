import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_AGENT_LOOP_ID, AGENT_TOOL_LOOP_ID, registerBuiltinLoops } from '../plugins/builtinLoopsPlugin.js';
import { LoopRegistryImpl } from '../registry.js';
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
    loopId: 'agent-tool-loop',
    ...overrides,
  };
}

describe('LoopRegistry', () => {
  let registry: LoopRegistryImpl;

  beforeEach(() => {
    registry = new LoopRegistryImpl();
  });

  it('registers the builtin loop definitions once', () => {
    registerBuiltinLoops(registry);
    registerBuiltinLoops(registry);

    expect(registry.getLoop(AGENT_TOOL_LOOP_ID)?.id).toBe(AGENT_TOOL_LOOP_ID);
    expect(registry.getLoop(AGENT_AGENT_LOOP_ID)?.id).toBe(AGENT_AGENT_LOOP_ID);
    expect(registry.listLoops().map(loop => loop.id).sort()).toEqual([
      AGENT_TOOL_LOOP_ID,
      AGENT_AGENT_LOOP_ID,
    ].sort());
    expect(registry.createRunner(AGENT_AGENT_LOOP_ID)).not.toBeNull();
  });

  it('installs only enabled profile plugins and passes plugin config', () => {
    const calls: InstallCall[] = [];

    registry.registerPlugin({
      id: 'plugin:alpha',
      targetLoopId: 'agent-tool-loop',
      install: (target, config) => {
        calls.push({ id: 'plugin:alpha', config, target });
        return undefined;
      },
    });
    registry.registerPlugin({
      id: 'plugin:beta',
      targetLoopId: 'agent-tool-loop',
      install: (target, config) => {
        calls.push({ id: 'plugin:beta', config, target });
        return undefined;
      },
    });
    registry.registerPlugin({
      id: 'plugin:gamma',
      targetLoopId: 'agent-tool-loop',
      install: (target, config) => {
        calls.push({ id: 'plugin:gamma', config, target });
        return undefined;
      },
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
        return undefined;
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

  it('installs profile plugins per invocation and disposes them exactly once', async () => {
    const install = vi.fn();
    const cleanup = vi.fn();
    install.mockImplementation(() => cleanup);
    registry.registerLoop({
      id: 'loop:profile-lifecycle',
      name: 'Profile lifecycle',
      description: 'test',
      createRunner: () =>
        async function*() {
          yield { type: 'message', data: 'done' };
        },
    });
    registry.registerPlugin({
      id: 'plugin:profile-lifecycle',
      targetLoopId: 'loop:profile-lifecycle',
      activationScope: 'profile',
      install,
    });
    const runner = registry.createRunnerForProfile(makeProfile({
      loopId: 'loop:profile-lifecycle',
      plugins: [{ id: 'plugin:profile-lifecycle' }],
    }));
    expect(install).not.toHaveBeenCalled();

    for await (const _ of runner?.({ conversationId: 'first', message: 'run' }) ?? []) {
      // Consume the invocation to trigger its scoped disposer.
    }
    for await (const _ of runner?.({ conversationId: 'second', message: 'run' }) ?? []) {
      // Consume a second independent invocation.
    }
    expect(install).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('registration disposal unloads active runtime installs exactly once', () => {
    const cleanup = vi.fn();
    const unregister = registry.registerPlugin({
      id: 'plugin:registration-lifecycle',
      targetLoopId: '*',
      activationScope: 'runtime',
      install: () => cleanup,
    });
    const tools = {};
    registry.installPluginsForLoop('*', { tools });
    registry.installPluginsForLoop('*', { tools });

    unregister();
    unregister();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(registry.getPlugin('plugin:registration-lifecycle')).toBeUndefined();
  });

  it('replaces an active runtime plugin generation without stale cleanup crossing owners', () => {
    const originalCleanup = vi.fn();
    const replacementCleanup = vi.fn();
    const original = {
      id: 'plugin:generation',
      targetLoopId: '*',
      activationScope: 'runtime' as const,
      install: () => originalCleanup,
    };
    const replacement = { ...original, install: () => replacementCleanup };
    const unregisterOriginal = registry.registerPlugin(original);
    const tools = {};
    registry.installPluginsForLoop('*', { tools });

    const unregisterReplacement = registry.replacePlugin(replacement);
    expect(originalCleanup).toHaveBeenCalledTimes(1);
    registry.installPluginsForLoop('*', { tools });
    unregisterOriginal();
    expect(replacementCleanup).not.toHaveBeenCalled();
    unregisterReplacement();
    expect(replacementCleanup).toHaveBeenCalledTimes(1);
  });

  it('rolls back earlier profile installs when a later activation fails', () => {
    const cleanup = vi.fn();
    const unregisterFirst = registry.registerPlugin({
      id: 'plugin:first',
      targetLoopId: '*',
      activationScope: 'profile',
      install: () => cleanup,
    });
    registry.registerPlugin({
      id: 'plugin:failing',
      targetLoopId: '*',
      activationScope: 'profile',
      install: () => {
        throw new Error('activation failed');
      },
    });

    expect(() => registry.installPluginsForLoop('*', {})).toThrow('activation failed');
    expect(cleanup).toHaveBeenCalledTimes(1);
    unregisterFirst();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('rolls back runtime installs created by a failed activation batch', () => {
    const cleanup = vi.fn();
    registry.registerPlugin({
      id: 'plugin:runtime-first',
      targetLoopId: '*',
      activationScope: 'runtime',
      install: () => cleanup,
    });
    registry.registerPlugin({
      id: 'plugin:runtime-failing',
      targetLoopId: '*',
      activationScope: 'runtime',
      install: () => {
        throw new Error('runtime activation failed');
      },
    });
    const tools = {};

    expect(() => registry.installPluginsForLoop('*', { tools })).toThrow('runtime activation failed');
    expect(cleanup).toHaveBeenCalledTimes(1);
    registry.reset();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not roll back an earlier shared runtime install when a later batch fails', () => {
    const cleanup = vi.fn();
    registry.registerPlugin({
      id: 'plugin:shared',
      targetLoopId: '*',
      activationScope: 'runtime',
      install: () => cleanup,
    });
    const tools = {};
    registry.installPluginsForLoop('*', { tools }, ['plugin:shared']);
    registry.registerPlugin({
      id: 'plugin:later-failing',
      targetLoopId: '*',
      activationScope: 'runtime',
      install: () => {
        throw new Error('later activation failed');
      },
    });

    expect(() => registry.installPluginsForLoop('*', { tools })).toThrow('later activation failed');
    expect(cleanup).not.toHaveBeenCalled();
    registry.reset();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects conflicting config for the same runtime plugin owner', () => {
    registry.registerPlugin({
      id: 'plugin:configured',
      targetLoopId: '*',
      activationScope: 'runtime',
      install: vi.fn(() => vi.fn()),
    });
    const tools = {};
    registry.installPluginsForLoop('*', { tools }, [{
      id: 'plugin:configured',
      config: { mode: 'first' },
    }]);

    expect(() =>
      registry.installPluginsForLoop('*', { tools }, [{
        id: 'plugin:configured',
        config: { mode: 'second' },
      }])
    ).toThrow('configuration conflict');
  });

  it('prevents stale registration disposers from resurrecting entries after reset', () => {
    const loop = {
      id: 'loop:stale-reset',
      name: 'Stale reset',
      description: 'test',
      createRunner: () => async function*() {},
    };
    const disposeLoop = registry.registerLoop(loop);
    const disposeProfile = registry.registerProfile(makeProfile({ id: 'profile:stale-reset' }));
    const disposePlugin = registry.registerPlugin({ id: 'plugin:stale-reset' });

    registry.reset();
    disposeLoop();
    disposeProfile();
    disposePlugin();
    expect(registry.getLoop(loop.id)).toBeUndefined();
    expect(registry.getProfile('profile:stale-reset')).toBeUndefined();
    expect(registry.getPlugin('plugin:stale-reset')).toBeUndefined();
  });

  it('does not reactivate runtime plugins for every profile runner and filters their tool capabilities', async () => {
    const registry = new LoopRegistryImpl();
    const install = vi.fn();
    const selectedTool = vi.fn();
    const hiddenTool = vi.fn();
    registry.registerLoop({
      id: 'loop:test',
      name: 'Test Loop',
      description: 'test',
      createRunner: context =>
        async function*() {
          const tools = context.tools as {
            getTool(id: string): unknown;
            listTools(): string[];
          };
          yield {
            type: 'message',
            data: {
              selected: tools.getTool('selected-tool'),
              hidden: tools.getTool('hidden-tool'),
              listed: tools.listTools(),
            },
          };
        },
    });
    registry.registerPlugin({
      id: 'plugin:selected',
      targetLoopId: 'loop:test',
      activationScope: 'runtime',
      providedToolIds: ['selected-tool'],
      install,
    });
    const tools = {
      registerTool: vi.fn(),
      getTool: (id: string) => id === 'selected-tool' ? selectedTool : hiddenTool,
      listTools: () => ['selected-tool', 'hidden-tool'],
    };

    const runner = registry.createRunnerForProfile(
      makeProfile({ loopId: 'loop:test', plugins: [{ id: 'plugin:selected' }] }),
      { tools, toolRegistry: tools },
    );
    const steps = [];
    for await (const step of runner?.({ conversationId: 'c', message: 'run' }) ?? []) steps.push(step);

    expect(install).not.toHaveBeenCalled();
    expect(steps[0]?.data).toEqual({
      selected: selectedTool,
      hidden: undefined,
      listed: ['selected-tool'],
    });
  });

  it('respects plugin target loop ids when installing profile plugins', () => {
    const calls: string[] = [];

    registry.registerPlugin({
      id: 'plugin:agent-agent-loop-only',
      targetLoopId: 'agent-agent-loop',
      install: () => {
        calls.push('agent-agent-loop');
        return undefined;
      },
    });
    registry.registerPlugin({
      id: 'plugin:any-loop',
      targetLoopId: '*',
      install: () => {
        calls.push('any-loop');
        return undefined;
      },
    });

    registry.installPluginsForProfile(
      makeProfile({
        loopId: 'agent-tool-loop',
        plugins: [{ id: 'plugin:agent-agent-loop-only' }, { id: 'plugin:any-loop' }],
      }),
      {},
    );

    expect(calls).toEqual(['any-loop']);
  });

  it('keeps installPluginsForLoop compatible with string selections', () => {
    const calls: string[] = [];

    registry.registerPlugin({
      id: 'plugin:alpha',
      targetLoopId: '*',
      install: () => {
        calls.push('alpha');
        return undefined;
      },
    });
    registry.registerPlugin({
      id: 'plugin:beta',
      targetLoopId: '*',
      install: () => {
        calls.push('beta');
        return undefined;
      },
    });

    registry.installPluginsForLoop('agent-tool-loop', {}, ['plugin:beta']);

    expect(calls).toEqual(['beta']);
  });

  it('isolates same-name runtime extensions and cleanup removes only its owner', () => {
    const firstRuntime = new LoopRegistryImpl();
    const secondRuntime = new LoopRegistryImpl();
    const firstLoop = {
      id: 'loop:extension',
      name: 'First runtime extension',
      description: 'first',
      createRunner: () =>
        async function*() {
          yield { type: 'message' as const, data: 'first' };
        },
    };
    const secondLoop = {
      ...firstLoop,
      name: 'Second runtime extension',
      createRunner: () =>
        async function*() {
          yield { type: 'message' as const, data: 'second' };
        },
    };

    const unloadFirst = firstRuntime.registerLoop(firstLoop);
    secondRuntime.registerLoop(secondLoop);
    expect(firstRuntime.getLoop(firstLoop.id)).toEqual(firstLoop);
    expect(secondRuntime.getLoop(secondLoop.id)).toEqual(secondLoop);

    unloadFirst();
    expect(firstRuntime.getLoop(firstLoop.id)).toBeUndefined();
    expect(secondRuntime.getLoop(secondLoop.id)).toEqual(secondLoop);
  });

  it('installs a runtime-scoped plugin once per owner and disposes every owner once', () => {
    const registry = new LoopRegistryImpl();
    const disposeFirst = vi.fn();
    const disposeSecond = vi.fn();
    const install = vi.fn((target: Record<string, unknown>) => target.owner === 'first' ? disposeFirst : disposeSecond);
    registry.registerPlugin({
      id: 'plugin:runtime-owned',
      targetLoopId: '*',
      activationScope: 'runtime',
      install,
    });
    const firstTools = { owner: 'first' };
    const secondTools = { owner: 'second' };

    registry.installPluginsForLoop('loop:test', { ...firstTools, tools: firstTools });
    registry.installPluginsForLoop('loop:test', { ...firstTools, tools: firstTools });
    registry.installPluginsForLoop('loop:test', { ...secondTools, tools: secondTools });
    expect(install).toHaveBeenCalledTimes(2);

    registry.reset();
    expect(disposeFirst).toHaveBeenCalledTimes(1);
    expect(disposeSecond).toHaveBeenCalledTimes(1);
    registry.reset();
    expect(disposeFirst).toHaveBeenCalledTimes(1);
    expect(disposeSecond).toHaveBeenCalledTimes(1);
  });

  it('does not let stale cleanup remove a later override', () => {
    const registry = new LoopRegistryImpl();
    const original = {
      id: 'loop:extension',
      name: 'Original',
      description: 'original',
      createRunner: () => async function*() {},
    };
    const replacement = { ...original, name: 'Replacement' };
    const unloadOriginal = registry.registerLoop(original);
    const unloadReplacement = registry.replaceLoop(replacement);

    unloadOriginal();
    expect(registry.getLoop(original.id)).toEqual(replacement);
    unloadReplacement();
    expect(registry.getLoop(original.id)).toBeUndefined();
  });

  it('fails closed when hostile registrations collide with builtins or other owners', () => {
    const registry = new LoopRegistryImpl();
    registerBuiltinLoops(registry);
    const hostile = {
      id: AGENT_TOOL_LOOP_ID,
      name: 'Hostile replacement',
      description: 'hostile',
      createRunner: () => async function*() {},
    };

    expect(() => registry.registerLoop(hostile)).toThrow('already registered');
    expect(registry.getLoop(AGENT_TOOL_LOOP_ID)?.name).not.toBe('Hostile replacement');
  });

  it('keeps trusted overrides intact when cleanup occurs out of order', () => {
    const registry = new LoopRegistryImpl();
    const original = {
      id: 'loop:extension',
      name: 'Original',
      description: 'original',
      createRunner: () => async function*() {},
    };
    const firstOverride = { ...original, name: 'First override' };
    const secondOverride = { ...original, name: 'Second override' };
    const unloadOriginal = registry.registerLoop(original);
    const unloadFirst = registry.replaceLoop(firstOverride);
    const unloadSecond = registry.replaceLoop(secondOverride);

    unloadFirst();
    unloadOriginal();
    expect(registry.getLoop(original.id)).toEqual(secondOverride);
    unloadSecond();
    expect(registry.getLoop(original.id)).toBeUndefined();
  });

  it('stores immutable registration snapshots instead of caller-owned shells', () => {
    const loop = {
      id: 'loop:snapshot',
      name: 'Snapshot',
      description: 'before',
      createRunner: () => async function*() {},
    };
    const profile = makeProfile({ id: 'profile:snapshot', tools: ['safe.tool'] });
    const plugin = {
      id: 'plugin:snapshot',
      providedToolIds: ['safe.tool'],
    };
    registry.registerLoop(loop);
    registry.registerProfile(profile);
    registry.registerPlugin(plugin);

    loop.description = 'after';
    profile.tools?.push('hostile.tool');
    plugin.providedToolIds.push('hostile.tool');

    expect(registry.getLoop(loop.id)?.description).toBe('before');
    expect(registry.getProfile(profile.id)?.tools).toEqual(['safe.tool']);
    expect(registry.getPlugin(plugin.id)?.providedToolIds).toEqual(['safe.tool']);
    expect(Object.isFrozen(registry.getLoop(loop.id))).toBe(true);
    expect(Object.isFrozen(registry.getProfile(profile.id)?.tools)).toBe(true);
    expect(Object.isFrozen(registry.getPlugin(plugin.id)?.providedToolIds)).toBe(true);
  });

  it('reference-counts shared runtime installation leases', () => {
    const cleanup = vi.fn();
    registry.registerPlugin({
      id: 'plugin:lease',
      activationScope: 'runtime',
      install: () => cleanup,
    });
    const tools = {};
    const releaseFirst = registry.installPluginsForLoop('*', { tools });
    const releaseSecond = registry.installPluginsForLoop('*', { tools });

    releaseFirst();
    expect(cleanup).not.toHaveBeenCalled();
    releaseFirst();
    expect(cleanup).not.toHaveBeenCalled();
    releaseSecond();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('passes only an explicit read/execute tool facade to profile runners', async () => {
    registry.registerLoop({
      id: 'loop:facade',
      name: 'Facade',
      description: 'test',
      createRunner: context =>
        async function*() {
          const tools = context.tools as Record<string, unknown>;
          yield {
            type: 'message',
            data: {
              keys: Object.keys(tools).sort(),
              secret: tools.secret,
              registerTool: tools.registerTool,
            },
          };
        },
    });
    const tools = {
      secret: 'host secret',
      registerTool: vi.fn(),
      getTool: (id: string) => id === 'safe.tool' ? vi.fn() : undefined,
      listTools: () => ['safe.tool'],
    };
    const runner = registry.createRunnerForProfile(
      makeProfile({ loopId: 'loop:facade', tools: ['safe.tool'] }),
      { tools },
    );
    const steps = [];
    for await (const step of runner?.({ conversationId: 'c', message: 'run' }) ?? []) steps.push(step);
    expect(steps[0]?.data).toEqual({
      keys: [
        'getTool',
        'getToolEffect',
        'getToolMetadata',
        'getToolParameterSchema',
        'hasTool',
        'listTools',
      ],
      secret: undefined,
      registerTool: undefined,
    });
  });

  it('validates and detaches plugin config before invoking install', () => {
    const install = vi.fn((_target: Record<string, unknown>, config?: Record<string, unknown>) => {
      expect(Object.isFrozen(config)).toBe(true);
      expect(config).toEqual({ mode: 'safe' });
      return undefined;
    });
    registry.registerPlugin({ id: 'plugin:config-snapshot', install });
    const config = { mode: 'safe' };
    registry.installPluginsForLoop('*', {}, [{ id: 'plugin:config-snapshot', config }]);
    config.mode = 'mutated';
    expect(install).toHaveBeenCalledTimes(1);

    let getterCalls = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'value', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'hostile';
      },
    });
    expect(() =>
      registry.installPluginsForLoop('*', {}, [{
        id: 'plugin:config-snapshot',
        config: hostile,
      }])
    ).toThrow();
    expect(getterCalls).toBe(0);
    expect(install).toHaveBeenCalledTimes(1);
  });
});
