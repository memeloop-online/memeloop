import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentProfileRegistry } from '../agent/agentProfileRegistry.js';
import { ProviderRegistry } from '../llm/providerRegistry.js';
import { HookRegistry } from '../loopAPI/hooks/registry.js';
import { LoopRegistryImpl } from '../loopAPI/registry.js';
import { MEMELOOP_PLUGIN_API_VERSION, PluginLoader, PluginRegistryManager, validatePluginManifest } from '../plugin/index.js';
import type { LoadedPlugin, LoadPluginModuleOptions, PluginAPIOptions, PluginManifest, PluginModule } from '../plugin/index.js';

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: 'test-plugin',
    version: '0.1.0',
    description: 'Unit test plugin',
    ...overrides,
  };
}

function module(overrides: Partial<PluginModule> = {}): PluginModule {
  return {
    name: 'test-plugin',
    activate: vi.fn(),
    ...overrides,
  };
}

function ownedToolRegistry(tools = new Map<string, unknown>()) {
  const unregisterTool = vi.fn((id: string) => tools.delete(id));
  const registerOwnedTool = vi.fn((id: string, impl: unknown) => {
    tools.set(id, impl);
    return () => unregisterTool(id);
  });
  return {
    tools,
    registerTool: vi.fn((id: string, impl: unknown) => tools.set(id, impl)),
    registerOwnedTool,
    hasTool: (id: string) => tools.has(id),
    unregisterTool,
  };
}

let defaultManager: PluginRegistryManager;
let defaultLoader: PluginLoader;
const loadPluginModule = (options: LoadPluginModuleOptions) => defaultLoader.loadPluginModule(options);
const loadPluginModules = (plugins: LoadPluginModuleOptions[]) => defaultLoader.loadPluginModules(plugins);
const getLoadedPlugin = (name: string): LoadedPlugin | undefined => defaultLoader.getLoadedPlugin(name);
const isPluginLoaded = (name: string): boolean => defaultLoader.isPluginLoaded(name);
const listPlugins = (): LoadedPlugin[] => defaultLoader.listPlugins();
const unloadPlugin = (name: string): Promise<boolean> => defaultLoader.unloadPlugin(name);
const unloadAllPlugins = (): Promise<void> => defaultLoader.unloadAllPlugins();
const clearPluginRegistrations = (): void => {
  defaultManager.clearPluginRegistrations();
};
const getPluginRegistrations = (name: string) => defaultManager.getPluginRegistrations(name);
const registerPluginHooks = (
  name: string,
  hooks: Parameters<PluginRegistryManager['registerPluginHooks']>[1],
) => {
  defaultManager.registerPluginHooks(name, hooks);
};
const createPluginAPI = (options: Omit<PluginAPIOptions, 'pluginName'> = {}) => defaultManager.createPluginAPI({ ...options, pluginName: 'direct-api-test' });

beforeEach(async () => {
  defaultManager = new PluginRegistryManager();
  defaultLoader = new PluginLoader({ registryManager: defaultManager });
});

afterEach(async () => {
  await unloadAllPlugins();
  clearPluginRegistrations();
});

describe('validatePluginManifest', () => {
  it('keeps the plugin API compatibility version aligned with the package', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(MEMELOOP_PLUGIN_API_VERSION).toBe(packageJson.version);
  });

  it('accepts a valid manifest and normalizes optional fields', () => {
    expect(
      validatePluginManifest({
        name: ' plugin-a ',
        version: ' 1.0.0 ',
        description: 'desc',
        author: 'Alice',
        minMemeloopVersion: '0.1.0',
        exports: {
          tools: ['tool-a'],
          hooks: ['PreToolUse'],
        },
      }),
    ).toEqual({
      name: 'plugin-a',
      version: '1.0.0',
      description: 'desc',
      author: 'Alice',
      minMemeloopVersion: '0.1.0',
      exports: {
        tools: ['tool-a'],
        hooks: ['PreToolUse'],
      },
    });
  });

  it('rejects invalid required fields', () => {
    expect(validatePluginManifest(null)).toBeNull();
    expect(validatePluginManifest({ name: '', version: '1' })).toBeNull();
    expect(validatePluginManifest({ name: 'x', version: '' })).toBeNull();
    expect(validatePluginManifest({ name: 'x', version: '1.0.0', unknown: true })).toBeNull();
    expect(validatePluginManifest({
      name: 'x',
      version: '1.0.0',
      exports: { tools: ['bad\ntool'] },
    })).toBeNull();
  });
});

describe('loadPluginModule', () => {
  it('loads a plugin and calls activate', async () => {
    type Activate = import('../plugin/types.js').PluginModule['activate'];
    const activate = vi.fn((api: import('../plugin/types.js').PluginAPI) => {
      api.registerTool('test.tool', () => 'ok' as const);
    }) as unknown as Activate;

    const mockRegistry = ownedToolRegistry();
    const loaded = await loadPluginModule({
      manifest: manifest({ name: 'loaded-plugin', exports: { tools: ['test.tool'] } }),
      module: module({ name: 'loaded-plugin', activate }),
      apiOptions: { toolRegistry: mockRegistry },
      source: 'memory:test',
    });

    expect(loaded?.manifest.name).toBe('loaded-plugin');
    expect(loaded?.source).toBe('memory:test');
    expect(activate).toHaveBeenCalled();
    expect(mockRegistry.registerOwnedTool).toHaveBeenCalledWith(
      'test.tool',
      expect.any(Function),
      undefined,
    );
  });

  it('refuses a duplicate loaded plugin', async () => {
    const first = await loadPluginModule({
      manifest: manifest({ name: 'dup-plugin' }),
      module: module({ name: 'dup-plugin' }),
    });
    await expect(loadPluginModule({
      manifest: manifest({ name: 'dup-plugin' }),
      module: module({ name: 'dup-plugin' }),
    })).rejects.toThrow('already loaded');
    expect(first?.manifest.name).toBe('dup-plugin');
  });

  it('returns null for invalid manifests or modules', async () => {
    expect(
      await loadPluginModule({ manifest: manifest({ name: '' }), module: module() }),
    ).toBeNull();
    expect(
      await loadPluginModule({
        manifest: manifest({ name: 'manifest-name' }),
        module: module({ name: 'different-module-name' }),
      }),
    ).toBeNull();
    expect(
      await loadPluginModule({
        manifest: manifest(),
        module: { name: 'bad', activate: undefined as never },
      }),
    ).toBeNull();
  });

  it('loads multiple plugin modules', async () => {
    const loaded = await loadPluginModules([
      { manifest: manifest({ name: 'a' }), module: module({ name: 'a' }) },
      { manifest: manifest({ name: 'b' }), module: module({ name: 'b' }) },
    ]);
    expect(loaded.map((plugin) => plugin.manifest.name)).toEqual(['a', 'b']);
  });

  it('enforces memeloop semver compatibility before activation', async () => {
    const activate = vi.fn();
    await expect(loadPluginModule({
      manifest: manifest({ name: 'future', minMemeloopVersion: '>=99.0.0' }),
      module: module({ name: 'future', activate }),
    })).rejects.toThrow('requires memeloop');
    expect(activate).not.toHaveBeenCalled();
  });

  it('rolls back when declared exports do not match actual registrations', async () => {
    const toolRegistry = ownedToolRegistry();
    await expect(loadPluginModule({
      manifest: manifest({ name: 'export-drift', exports: { tools: ['declared.tool'] } }),
      module: module({
        name: 'export-drift',
        activate: api => {
          api.registerTool('actual.tool', () => undefined);
          return undefined;
        },
      }),
      apiOptions: {
        toolRegistry,
      },
    })).rejects.toThrow('exports do not match registrations');
    expect(toolRegistry.tools.has('actual.tool')).toBe(false);
    expect(toolRegistry.registerOwnedTool).not.toHaveBeenCalled();
  });
});

describe('plugin lifecycle', () => {
  it('keeps every executable capability staged until activation commits', async () => {
    let release!: () => void;
    let registered!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const registrationReached = new Promise<void>(resolve => {
      registered = resolve;
    });
    const tools = ownedToolRegistry();
    const hooks = new HookRegistry();
    const providers = new ProviderRegistry();
    const agentProfiles = new AgentProfileRegistry();
    const loops = new LoopRegistryImpl();
    const loader = new PluginLoader({
      registryManager: new PluginRegistryManager({ hookRegistry: hooks }),
      apiOptions: {
        toolRegistry: tools,
        providerRegistry: providers,
        agentProfileRegistry: agentProfiles,
        loopRegistry: loops,
      },
    });
    const loading = loader.loadPluginModule({
      manifest: manifest({
        name: 'staged-plugin',
        exports: {
          tools: ['staged.tool'],
          hooks: ['PreToolUse'],
          agentProfiles: ['staged:agent'],
          loopDefinitions: ['staged:loop'],
          loopProfiles: ['staged:profile'],
          loopPlugins: ['staged:loop-plugin'],
          modelProviders: ['staged-provider'],
        },
      }),
      module: module({
        name: 'staged-plugin',
        activate: async api => {
          api.registerTool('staged.tool', () => 'ok');
          api.registerOwnedHook('PreToolUse', async () => ({ allowed: true }));
          api.registerAgentProfile({
            id: 'staged:agent',
            name: 'Staged agent',
            type: 'plugin-role',
            prompt: 'Staged prompt',
            permissions: { default: 'deny', rules: [] },
            protocolDef: {
              id: 'staged:agent',
              name: 'Staged agent',
              description: 'Staged agent',
              systemPrompt: 'Staged prompt',
              tools: [],
              version: '1.0.0',
            },
          });
          api.registerLoopDefinition({
            id: 'staged:loop',
            name: 'Staged loop',
            description: 'Staged loop',
            createRunner: () => async function*() {},
          });
          api.registerLoopProfile({
            id: 'staged:profile',
            name: 'Staged profile',
            description: 'Staged profile',
            loopId: 'staged:loop',
          });
          api.registerLoopPlugin({ id: 'staged:loop-plugin', targetLoopId: 'staged:loop' });
          api.registerModelProvider({
            name: 'staged-provider',
            chat: async () => 'ok',
          }, {
            models: [{
              modelId: 'staged-model',
              wireModelId: 'staged-model',
              apiMode: 'chat-completions',
            }],
          });
          registered();
          await gate;
        },
      }),
    });

    await registrationReached;
    expect(tools.tools.has('staged.tool')).toBe(false);
    expect(hooks.getHookCount('PreToolUse')).toBe(0);
    expect(agentProfiles.getAgentProfile('staged:agent')).toBeUndefined();
    expect(loops.getLoop('staged:loop')).toBeUndefined();
    expect(loops.getProfile('staged:profile')).toBeUndefined();
    expect(loops.getPlugin('staged:loop-plugin')).toBeUndefined();
    expect(providers.get('staged-provider')).toBeUndefined();

    release();
    await expect(loading).resolves.toMatchObject({ manifest: { name: 'staged-plugin' } });
    expect(tools.tools.has('staged.tool')).toBe(true);
    expect(hooks.getHookCount('PreToolUse')).toBe(1);
    expect(agentProfiles.getAgentProfile('staged:agent')).toBeDefined();
    expect(loops.getLoop('staged:loop')).toBeDefined();
    expect(loops.getProfile('staged:profile')).toBeDefined();
    expect(loops.getPlugin('staged:loop-plugin')).toBeDefined();
    expect(providers.get('staged-provider')).toBeDefined();
    await loader.unloadAllPlugins();
  });

  it('owns every executable extension category and removes it on unload', async () => {
    const agentProfileRegistry = new AgentProfileRegistry();
    const loopRegistry = new LoopRegistryImpl();
    const providerRegistry = new ProviderRegistry();
    const loader = new PluginLoader({
      apiOptions: { agentProfileRegistry, loopRegistry, providerRegistry },
    });
    await loader.loadPluginModule({
      manifest: manifest({
        name: 'ocp-plugin',
        exports: {
          agentProfiles: ['plugin:agent'],
          loopDefinitions: ['plugin:loop'],
          loopProfiles: ['plugin:profile'],
          loopPlugins: ['plugin:loop-extension'],
          modelProviders: ['plugin-provider'],
        },
      }),
      module: module({
        name: 'ocp-plugin',
        activate: api => {
          api.registerAgentProfile({
            id: 'plugin:agent',
            name: 'Plugin agent',
            type: 'plugin-role',
            prompt: 'Plugin prompt',
            permissions: { default: 'deny', rules: [] },
            protocolDef: {
              id: 'plugin:agent',
              name: 'Plugin agent',
              description: 'Plugin agent',
              systemPrompt: 'Plugin prompt',
              tools: [],
              version: '1.0.0',
            },
          });
          api.registerLoopDefinition({
            id: 'plugin:loop',
            name: 'Plugin loop',
            description: 'Plugin loop',
            createRunner: () => async function*() {},
          });
          api.registerLoopProfile({
            id: 'plugin:profile',
            name: 'Plugin profile',
            description: 'Plugin profile',
            loopId: 'plugin:loop',
          });
          api.registerLoopPlugin({ id: 'plugin:loop-extension', targetLoopId: 'plugin:loop' });
          api.registerModelProvider({
            name: 'plugin-provider',
            chat: async () => 'ok',
          }, {
            models: [{
              modelId: 'plugin-model',
              wireModelId: 'plugin-model',
              apiMode: 'chat-completions',
            }],
          });
        },
      }),
    });

    expect(agentProfileRegistry.getAgentProfile('plugin:agent')).toBeDefined();
    expect(loopRegistry.getLoop('plugin:loop')).toBeDefined();
    expect(loopRegistry.getProfile('plugin:profile')).toBeDefined();
    expect(loopRegistry.getPlugin('plugin:loop-extension')).toBeDefined();
    expect(providerRegistry.get('plugin-provider')).toBeDefined();
    expect(await loader.unloadPlugin('ocp-plugin')).toBe(true);
    expect(agentProfileRegistry.getAgentProfile('plugin:agent')).toBeUndefined();
    expect(loopRegistry.getLoop('plugin:loop')).toBeUndefined();
    expect(loopRegistry.getProfile('plugin:profile')).toBeUndefined();
    expect(loopRegistry.getPlugin('plugin:loop-extension')).toBeUndefined();
    expect(providerRegistry.get('plugin-provider')).toBeUndefined();
  });

  it('isolates non-tool extensions across runtimes with the same IDs', async () => {
    const createHost = () => {
      const loopRegistry = new LoopRegistryImpl();
      return {
        loopRegistry,
        loader: new PluginLoader({ apiOptions: { loopRegistry } }),
      };
    };
    const first = createHost();
    const second = createHost();
    const extensionModule = module({
      name: 'shared-extension-plugin',
      activate: api => {
        api.registerLoopDefinition({
          id: 'shared:loop',
          name: 'Shared loop',
          description: 'Shared loop',
          createRunner: () => async function*() {},
        });
      },
    });
    const extensionManifest = manifest({
      name: 'shared-extension-plugin',
      exports: { loopDefinitions: ['shared:loop'] },
    });
    await first.loader.loadPluginModule({ manifest: extensionManifest, module: extensionModule });
    await second.loader.loadPluginModule({ manifest: extensionManifest, module: extensionModule });
    expect(first.loopRegistry.getLoop('shared:loop')).toBeDefined();
    expect(second.loopRegistry.getLoop('shared:loop')).toBeDefined();
    await first.loader.unloadAllPlugins();
    expect(first.loopRegistry.getLoop('shared:loop')).toBeUndefined();
    expect(second.loopRegistry.getLoop('shared:loop')).toBeDefined();
    await second.loader.unloadAllPlugins();
  });

  it('rolls back earlier extension registrations when a later collision fails', async () => {
    const agentProfileRegistry = new AgentProfileRegistry();
    const loopRegistry = new LoopRegistryImpl();
    loopRegistry.registerLoop({
      id: 'host:loop',
      name: 'Host loop',
      description: 'Host loop',
      createRunner: () => async function*() {},
    });
    const loader = new PluginLoader({ apiOptions: { agentProfileRegistry, loopRegistry } });
    await expect(loader.loadPluginModule({
      manifest: manifest({
        name: 'partial-extension',
        exports: {
          agentProfiles: ['plugin:partial-agent'],
          loopDefinitions: ['host:loop'],
        },
      }),
      module: module({
        name: 'partial-extension',
        activate: api => {
          api.registerAgentProfile({
            id: 'plugin:partial-agent',
            name: 'Partial agent',
            type: 'plugin-role',
            prompt: 'Partial prompt',
            permissions: { default: 'deny', rules: [] },
            protocolDef: {
              id: 'plugin:partial-agent',
              name: 'Partial agent',
              description: 'Partial agent',
              systemPrompt: 'Partial prompt',
              tools: [],
              version: '1.0.0',
            },
          });
          api.registerLoopDefinition({
            id: 'host:loop',
            name: 'Hostile loop',
            description: 'Hostile loop',
            createRunner: () => async function*() {},
          });
        },
      }),
    })).rejects.toThrow('already registered');
    expect(agentProfileRegistry.getAgentProfile('plugin:partial-agent')).toBeUndefined();
    expect(loopRegistry.getLoop('host:loop')?.name).toBe('Host loop');
  });

  it('tracks loaded plugins and unloads cleanup handlers', async () => {
    const cleanup = vi.fn();
    await loadPluginModule({
      manifest: manifest({ name: 'cleanup-plugin' }),
      module: module({ name: 'cleanup-plugin', activate: vi.fn(() => cleanup) }),
    });

    expect(isPluginLoaded('cleanup-plugin')).toBe(true);
    expect(getLoadedPlugin('cleanup-plugin')).toBeDefined();
    expect(listPlugins()).toHaveLength(1);
    expect(await unloadPlugin('cleanup-plugin')).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(isPluginLoaded('cleanup-plugin')).toBe(false);
  });

  it('awaits asynchronous plugin cleanup', async () => {
    let cleaned = false;
    await loadPluginModule({
      manifest: manifest({ name: 'async-cleanup' }),
      module: module({
        name: 'async-cleanup',
        activate: () => async () => {
          await Promise.resolve();
          cleaned = true;
        },
      }),
    });

    expect(await unloadPlugin('async-cleanup')).toBe(true);
    expect(cleaned).toBe(true);
  });

  it('returns false for unknown plugins and clears all plugins', async () => {
    await loadPluginModules([
      { manifest: manifest({ name: 'a' }), module: module({ name: 'a' }) },
      { manifest: manifest({ name: 'b' }), module: module({ name: 'b' }) },
    ]);
    expect(await unloadPlugin('missing')).toBe(false);
    await unloadAllPlugins();
    expect(listPlugins()).toEqual([]);
  });

  it('owns tool and hook registrations and removes them on unload', async () => {
    const toolRegistry = ownedToolRegistry();
    const { tools } = toolRegistry;
    await loadPluginModule({
      manifest: manifest({
        name: 'owned-plugin',
        exports: { tools: ['owned.tool'], hooks: ['PreToolUse'] },
      }),
      module: module({
        name: 'owned-plugin',
        activate: api => {
          api.registerTool('owned.tool', () => 'ok');
          api.registerOwnedHook('PreToolUse', async () => ({ allowed: true }));
          return undefined;
        },
      }),
      apiOptions: { toolRegistry },
    });

    expect(getPluginRegistrations('owned-plugin')).toMatchObject({
      tools: ['owned.tool'],
      hooks: [expect.objectContaining({ type: 'PreToolUse' })],
    });
    expect(tools.has('owned.tool')).toBe(true);
    expect(await unloadPlugin('owned-plugin')).toBe(true);
    expect(toolRegistry.unregisterTool).toHaveBeenCalledWith('owned.tool');
    expect(getPluginRegistrations('owned-plugin')).toBeUndefined();
  });

  it('rolls back partial registrations when activation fails', async () => {
    const toolRegistry = ownedToolRegistry();
    await expect(loadPluginModule({
      manifest: manifest({ name: 'failing-plugin', exports: { tools: ['failing.tool'] } }),
      module: module({
        name: 'failing-plugin',
        activate: api => {
          api.registerTool('failing.tool', () => undefined);
          throw new Error('activation failed');
        },
      }),
      apiOptions: {
        toolRegistry,
      },
    })).rejects.toThrow('activation failed');
    expect(toolRegistry.tools.has('failing.tool')).toBe(false);
    expect(toolRegistry.registerOwnedTool).not.toHaveBeenCalled();
    expect(getPluginRegistrations('failing-plugin')).toBeUndefined();
  });

  it('uses permission-independent registration state to refuse host-tool replacement', async () => {
    const registerTool = vi.fn();
    const toolRegistry = {
      registerTool,
      hasTool: (id: string) => id === 'host.hidden',
      unregisterTool: vi.fn(() => true),
      registerOwnedTool: vi.fn(() => () => true),
      // An execution lookup may hide a registered tool, but plugins must not
      // use it as the ownership check.
      getTool: () => undefined,
    };

    await expect(loadPluginModule({
      manifest: manifest({ name: 'conflicting-plugin', exports: { tools: ['host.hidden'] } }),
      module: module({
        name: 'conflicting-plugin',
        activate: api => {
          api.registerTool('host.hidden', () => 'replacement');
          return undefined;
        },
      }),
      apiOptions: { toolRegistry },
    })).rejects.toThrow('conflicts with an existing tool');
    expect(registerTool).not.toHaveBeenCalled();
  });

  it('isolates same-name plugins and hooks across runtime-scoped loaders', async () => {
    const createHost = () => {
      const tools = new Map<string, unknown>();
      const hookRegistry = new HookRegistry();
      const loader = new PluginLoader({
        registryManager: new PluginRegistryManager({ hookRegistry }),
        apiOptions: {
          toolRegistry: ownedToolRegistry(tools),
        },
      });
      return { hookRegistry, loader, tools };
    };
    const first = createHost();
    const second = createHost();
    const pluginModule = module({
      name: 'shared-name',
      activate: api => {
        api.registerTool('shared.tool', () => 'ok');
        api.registerOwnedHook('PreToolUse', async () => ({ allowed: true }));
        return undefined;
      },
    });

    await first.loader.loadPluginModule({
      manifest: manifest({
        name: 'shared-name',
        exports: { tools: ['shared.tool'], hooks: ['PreToolUse'] },
      }),
      module: pluginModule,
    });
    await second.loader.loadPluginModule({
      manifest: manifest({
        name: 'shared-name',
        exports: { tools: ['shared.tool'], hooks: ['PreToolUse'] },
      }),
      module: pluginModule,
    });

    expect(first.tools.has('shared.tool')).toBe(true);
    expect(second.tools.has('shared.tool')).toBe(true);
    expect(first.hookRegistry.getHookCount('PreToolUse')).toBe(1);
    expect(second.hookRegistry.getHookCount('PreToolUse')).toBe(1);
    await first.loader.unloadAllPlugins();
    expect(first.tools.has('shared.tool')).toBe(false);
    expect(second.tools.has('shared.tool')).toBe(true);
    expect(first.hookRegistry.getHookCount('PreToolUse')).toBe(0);
    expect(second.hookRegistry.getHookCount('PreToolUse')).toBe(1);
    await second.loader.unloadAllPlugins();
  });

  it('runs every disposer and finalizes loader state when cleanup fails', async () => {
    const hookRegistry = new HookRegistry();
    const unregisterTool = vi.fn((_toolName?: string) => {
      throw new Error('tool disposer failed');
    });
    const loader = new PluginLoader({
      registryManager: new PluginRegistryManager({ hookRegistry }),
      apiOptions: {
        toolRegistry: {
          registerTool: vi.fn(),
          hasTool: () => false,
          unregisterTool,
          registerOwnedTool: vi.fn((_name, _handler, _schema) => () => unregisterTool('cleanup.tool')),
        },
      },
    });
    await loader.loadPluginModule({
      manifest: manifest({
        name: 'cleanup-failure',
        exports: { tools: ['cleanup.tool'], hooks: ['PreToolUse'] },
      }),
      module: module({
        name: 'cleanup-failure',
        activate: api => {
          api.registerTool('cleanup.tool', () => undefined);
          api.registerOwnedHook('PreToolUse', async () => ({ allowed: true }));
          return () => {
            throw new Error('module cleanup failed');
          };
        },
      }),
    });

    await expect(loader.unloadPlugin('cleanup-failure')).rejects.toThrow('Plugin cleanup failed');
    expect(unregisterTool).toHaveBeenCalledWith('cleanup.tool');
    expect(hookRegistry.getHookCount('PreToolUse')).toBe(0);
    expect(loader.isPluginLoaded('cleanup-failure')).toBe(false);
  });

  it('bounds activation and rolls back registrations from a hung plugin', async () => {
    const toolRegistry = ownedToolRegistry();
    const loader = new PluginLoader({
      activationTimeoutMs: 5,
      apiOptions: { toolRegistry },
    });

    await expect(loader.loadPluginModule({
      manifest: manifest({ name: 'hung-activate', exports: { tools: ['hung.tool'] } }),
      module: module({
        name: 'hung-activate',
        activate: api => {
          api.registerTool('hung.tool', () => undefined);
          return new Promise(() => undefined);
        },
      }),
    })).rejects.toMatchObject({ code: 'PLUGIN_LIFECYCLE_TIMEOUT', phase: 'activate' });

    expect(toolRegistry.tools.has('hung.tool')).toBe(false);
    expect(loader.isPluginLoaded('hung-activate')).toBe(false);

    await expect(loader.loadPluginModule({
      manifest: manifest({ name: 'hung-activate' }),
      module: module({ name: 'hung-activate' }),
    })).resolves.toMatchObject({ manifest: { name: 'hung-activate' } });
  });

  it('stops new tool requests and drains an in-flight call before unload', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const toolRegistry = ownedToolRegistry();
    const loader = new PluginLoader({ apiOptions: { toolRegistry } });
    await loader.loadPluginModule({
      manifest: manifest({ name: 'drained-plugin', exports: { tools: ['drain.tool'] } }),
      module: module({
        name: 'drained-plugin',
        activate: api => {
          api.registerTool('drain.tool', async () => {
            await gate;
            return 'done';
          });
          return undefined;
        },
      }),
    });
    const tool = toolRegistry.tools.get('drain.tool') as () => Promise<string>;
    const inFlight = tool();
    const unloading = loader.unloadPlugin('drained-plugin');

    expect(() => tool()).toThrow(expect.objectContaining({ code: 'PLUGIN_UNAVAILABLE' }));
    expect(toolRegistry.tools.has('drain.tool')).toBe(false);
    release();
    await expect(inFlight).resolves.toBe('done');
    await expect(unloading).resolves.toBe(true);
    expect(toolRegistry.tools.has('drain.tool')).toBe(false);
  });

  it('detaches hooks immediately and drains a hook already in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const hooks = new HookRegistry();
    const loader = new PluginLoader({
      registryManager: new PluginRegistryManager({ hookRegistry: hooks }),
    });
    await loader.loadPluginModule({
      manifest: manifest({ name: 'hook-drain', exports: { hooks: ['PreToolUse'] } }),
      module: module({
        name: 'hook-drain',
        activate: api => {
          api.registerOwnedHook('PreToolUse', async () => {
            await gate;
            return { allowed: true };
          });
        },
      }),
    });

    const inFlight = hooks.executeHooks('PreToolUse', {} as never, {});
    const unloading = loader.unloadPlugin('hook-drain');
    expect(hooks.getHookCount('PreToolUse')).toBe(0);
    await expect(hooks.executeHooks('PreToolUse', {} as never, {}))
      .resolves.toEqual({ allowed: true });
    release();
    await expect(inFlight).resolves.toEqual({ allowed: true });
    await expect(unloading).resolves.toBe(true);
  });

  it('drains an active provider stream and rejects stale provider references', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const providers = new ProviderRegistry();
    const loader = new PluginLoader({ apiOptions: { providerRegistry: providers } });
    await loader.loadPluginModule({
      manifest: manifest({
        name: 'provider-drain',
        exports: { modelProviders: ['stream-provider'] },
      }),
      module: module({
        name: 'provider-drain',
        activate: api => {
          api.registerModelProvider({
            name: 'stream-provider',
            chat: () =>
              (async function*() {
                await gate;
                yield { type: 'text-delta' as const, id: 'provider-stream', text: 'done' };
              })(),
          }, {
            models: [{
              modelId: 'stream-model',
              wireModelId: 'stream-model',
              apiMode: 'chat-completions',
            }],
          });
        },
      }),
    });

    const provider = providers.get('stream-provider')!;
    const stream = provider.chat({ messages: [] } as never) as AsyncIterable<unknown>;
    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();
    const unloading = loader.unloadPlugin('provider-drain');
    expect(providers.get('stream-provider')).toBeUndefined();
    expect(() => provider.chat({ messages: [] } as never))
      .toThrow(expect.objectContaining({ code: 'PLUGIN_UNAVAILABLE' }));
    release();
    await expect(first).resolves.toMatchObject({ done: false });
    await iterator.return?.();
    await expect(unloading).resolves.toBe(true);
  });

  it('bounds hung cleanup while still removing owned registrations', async () => {
    const toolRegistry = ownedToolRegistry();
    const loader = new PluginLoader({
      cleanupTimeoutMs: 5,
      apiOptions: { toolRegistry },
    });
    await loader.loadPluginModule({
      manifest: manifest({ name: 'hung-cleanup', exports: { tools: ['cleanup.hung'] } }),
      module: module({
        name: 'hung-cleanup',
        activate: api => {
          api.registerTool('cleanup.hung', () => undefined);
          return () => new Promise(() => undefined);
        },
      }),
    });

    await expect(loader.unloadPlugin('hung-cleanup')).rejects.toThrow('Plugin cleanup failed');
    expect(toolRegistry.tools.has('cleanup.hung')).toBe(false);
    expect(loader.isPluginLoaded('hung-cleanup')).toBe(false);
  });

  it('quarantines a drain timeout and cleans up only after the late call settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const cleanup = vi.fn();
    const toolRegistry = ownedToolRegistry();
    const loader = new PluginLoader({
      apiOptions: { toolRegistry },
      drainTimeoutMs: 5,
    });
    await loader.loadPluginModule({
      manifest: manifest({ name: 'quarantined', exports: { tools: ['quarantine.tool'] } }),
      module: module({
        name: 'quarantined',
        activate: api => {
          api.registerTool('quarantine.tool', async () => gate);
          return cleanup;
        },
      }),
    });
    const tool = toolRegistry.tools.get('quarantine.tool') as () => Promise<void>;
    const inFlight = tool();

    await expect(loader.unloadPlugin('quarantined')).rejects.toMatchObject({
      code: 'PLUGIN_LIFECYCLE_TIMEOUT',
      phase: 'drain',
    });
    expect(toolRegistry.tools.has('quarantine.tool')).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(loader.isPluginLoaded('quarantined')).toBe(true);

    release();
    await inFlight;
    await vi.waitFor(() => {
      expect(cleanup).toHaveBeenCalledOnce();
    });
    expect(loader.isPluginLoaded('quarantined')).toBe(false);
  });

  it('does not expose executable module or cleanup handles through introspection', async () => {
    const cleanup = vi.fn();
    await loadPluginModule({
      manifest: manifest({ name: 'metadata-only' }),
      module: module({ name: 'metadata-only', activate: () => cleanup }),
      source: 'fixture',
    });

    const info = getLoadedPlugin('metadata-only')!;
    expect(info).toMatchObject({ source: 'fixture', loadedAt: expect.any(String) });
    expect(info).not.toHaveProperty('module');
    expect(info).not.toHaveProperty('cleanup');
    expect(Object.isFrozen(info)).toBe(true);
    expect(Object.isFrozen(info.manifest)).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
  });
});

describe('createPluginAPI', () => {
  it('refuses anonymous activation APIs that cannot be unloaded', () => {
    expect(() => defaultManager.createPluginAPI({} as never)).toThrow('stable pluginName');
  });
  it('registerTool adds to toolRegistry when provided', () => {
    const mockRegistry = ownedToolRegistry();
    const api = createPluginAPI({ toolRegistry: mockRegistry });

    api.registerTool('test.tool', () => 'hello');
    defaultManager.activatePluginRegistrations('direct-api-test');
    expect(mockRegistry.registerOwnedTool).toHaveBeenCalledWith(
      'test.tool',
      expect.any(Function),
      undefined,
    );
  });

  it('refuses a registry that cannot guarantee plugin unload', () => {
    const api = createPluginAPI({
      toolRegistry: { registerTool: vi.fn() } as never,
    });
    expect(() => {
      api.registerTool('leaked.tool', () => undefined);
    }).toThrow(
      'requires an unloadable tool registry',
    );
  });

  it('accepts custom logger', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const api = createPluginAPI({ logger });
    api.logger.info('test');
    expect(logger.info).toHaveBeenCalledWith('test');
  });
});

describe('registerPluginHooks tracking', () => {
  it('tracks registered hooks per plugin', () => {
    registerPluginHooks('test-plugin', [
      ['PreToolUse', async () => ({ allowed: true })],
      ['PostToolUse', async () => ({ allowed: true })],
    ]);
    expect(getPluginRegistrations('test-plugin')?.hooks).toHaveLength(2);
  });

  it('clears all tracking', () => {
    clearPluginRegistrations();
    expect(getPluginRegistrations('test-plugin')).toBeUndefined();
  });
});
