/**
 * Plugin registry: bridges plugin exports to memeloop's tool and hook registries.
 *
 * Provides a `createPluginAPI()` factory that plugins call during `activate()`
 * to register their tools and hooks with the host runtime.
 *
 * Converted from module-level singletons to an instance class for test isolation
 * and multi-runtime support.
 */

import type { AgentProfile } from '../agent/agentProfiles.js';
import type { ProviderConfig, ProviderRegistration } from '../llm/providerRegistry.js';
import { HookRegistry } from '../loopAPI/hooks/registry.js';
import type { HookHandler, HookRegistrationRegistry, HookType } from '../loopAPI/hooks/types.js';
import type { AgentLoopDefinition, LoopPlugin, LoopProfile } from '../loopAPI/types.js';
import type { ToolOperationEffect } from '../orchestration/resources.js';
import { ToolSchemaRegistry } from '../tools/schemaRegistry.js';
import type { OwnedToolSchemaRegistry } from '../tools/schemaRegistry.js';
import type { ILLMProvider } from '../types.js';
import type { PluginAPI } from './types.js';

/** Tool-registry capabilities required by an unloadable plugin host. */
export interface PluginToolRegistry {
  registerTool(
    id: string,
    impl: unknown,
    schema?: unknown,
    effect?: ToolOperationEffect,
  ): void;
  /** Permission-independent registration lookup. */
  hasTool(id: string): boolean;
  unregisterTool(id: string): boolean;
  registerOwnedTool(
    id: string,
    impl: unknown,
    schema?: unknown,
    effect?: ToolOperationEffect,
  ): () => boolean;
}

export interface PluginAgentProfileRegistry {
  registerAgentProfile(profile: AgentProfile): () => boolean;
}

export interface PluginLoopRegistry {
  registerLoop(definition: AgentLoopDefinition): () => void;
  registerProfile(profile: LoopProfile): () => void;
  registerPlugin(plugin: LoopPlugin): () => void;
}

export interface PluginProviderRegistry {
  register(
    owner: { ownerId: string; kind: 'plugin' },
    provider: ILLMProvider,
    config: Omit<ProviderConfig, 'name'>,
  ): ProviderRegistration;
}

/** Plugin API factory options. */
export interface PluginAPIOptions {
  /** Stable manifest name used to own and later remove every registration. */
  pluginName: string;
  toolRegistry?: PluginToolRegistry;
  agentProfileRegistry?: PluginAgentProfileRegistry;
  loopRegistry?: PluginLoopRegistry;
  providerRegistry?: PluginProviderRegistry;
  logger?: PluginAPI['logger'];
}

export interface PluginRegistryManagerOptions {
  hookRegistry?: HookRegistrationRegistry;
  schemaRegistry?: OwnedToolSchemaRegistry;
}

/**
 * Track which tools/plugins belong to each plugin so we can clean up on unload.
 */
interface PluginRegistration {
  pluginName: string;
  tools: string[];
  hooks: Array<{ type: HookType; name: string }>;
  agentProfiles: string[];
  loopDefinitions: string[];
  loopProfiles: string[];
  loopPlugins: string[];
  modelProviders: string[];
  staged: Array<() => () => void>;
  cleanup: Array<() => void>;
  registering: boolean;
  accepting: boolean;
  inFlight: Set<Promise<unknown>>;
  detached: boolean;
}

export class PluginUnavailableError extends Error {
  readonly code = 'PLUGIN_UNAVAILABLE' as const;

  constructor(readonly pluginName: string) {
    super(`Plugin is not accepting requests: ${pluginName}`);
    this.name = 'PluginUnavailableError';
  }
}

export interface PluginRegistrationSnapshot {
  pluginName: string;
  tools: string[];
  hooks: Array<{ type: HookType; name: string }>;
  agentProfiles: string[];
  loopDefinitions: string[];
  loopProfiles: string[];
  loopPlugins: string[];
  modelProviders: string[];
}

/**
 * Instance-level plugin registration manager.
 */
export class PluginRegistryManager {
  private readonly pluginRegistrations = new Map<string, PluginRegistration>();
  private readonly hookRegistry: HookRegistrationRegistry;
  private readonly schemaRegistry: OwnedToolSchemaRegistry;

  constructor(options: PluginRegistryManagerOptions = {}) {
    this.hookRegistry = options.hookRegistry ?? new HookRegistry();
    this.schemaRegistry = options.schemaRegistry ?? new ToolSchemaRegistry();
  }

  private ensureRegistration(pluginName: string): PluginRegistration {
    const existing = this.pluginRegistrations.get(pluginName);
    if (existing) return existing;
    const reg: PluginRegistration = {
      pluginName,
      tools: [],
      hooks: [],
      agentProfiles: [],
      loopDefinitions: [],
      loopProfiles: [],
      loopPlugins: [],
      modelProviders: [],
      staged: [],
      cleanup: [],
      registering: true,
      accepting: false,
      inFlight: new Set(),
      detached: false,
    };
    this.pluginRegistrations.set(pluginName, reg);
    return reg;
  }

  /**
   * Create a PluginAPI instance that plugins use to register their capabilities.
   */
  createPluginAPI(options: PluginAPIOptions): PluginAPI {
    const toolRegistry = options.toolRegistry;
    const hookRegistry = this.hookRegistry;
    const schemaRegistry = this.schemaRegistry;
    const agentProfileRegistry = options.agentProfileRegistry;
    const loopRegistry = options.loopRegistry;
    const providerRegistry = options.providerRegistry;
    const logger = options.logger ?? {
      debug: (...arguments_: unknown[]) => {
        console.debug('[plugin]', ...arguments_);
      },
      info: (...arguments_: unknown[]) => {
        console.info('[plugin]', ...arguments_);
      },
      warn: (...arguments_: unknown[]) => {
        console.warn('[plugin]', ...arguments_);
      },
      error: (...arguments_: unknown[]) => {
        console.error('[plugin]', ...arguments_);
      },
    };
    const pluginName = options.pluginName?.trim();
    if (!pluginName || hasControlCharacters(pluginName)) {
      throw new TypeError('Plugin API requires a stable pluginName');
    }
    const registration = this.ensureRegistration(pluginName);
    let hookIndex = registration.hooks.length;
    const trackPromise = <T>(promise: Promise<T>): Promise<T> => {
      registration.inFlight.add(promise);
      void promise.then(
        () => registration.inFlight.delete(promise),
        () => registration.inFlight.delete(promise),
      );
      return promise;
    };
    const guardAsyncIterable = <T>(source: AsyncIterable<T>): AsyncIterable<T> => ({
      async *[Symbol.asyncIterator]() {
        if (!registration.accepting) {
          throw new PluginUnavailableError(registration.pluginName);
        }
        let release!: () => void;
        const lease = new Promise<void>(resolve => {
          release = resolve;
        });
        registration.inFlight.add(lease);
        try {
          yield* source;
        } finally {
          registration.inFlight.delete(lease);
          release();
        }
      },
    });
    const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
      value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
    const guardResult = (result: unknown): unknown => {
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        typeof (result as PromiseLike<unknown>).then === 'function'
      ) {
        return trackPromise(Promise.resolve(result).then(value => isAsyncIterable(value) ? guardAsyncIterable(value) : value));
      }
      return isAsyncIterable(result) ? guardAsyncIterable(result) : result;
    };
    const invokeCapability = (invoke: () => unknown): unknown => {
      if (!registration.accepting) {
        throw new PluginUnavailableError(registration.pluginName);
      }
      return guardResult(invoke());
    };
    const ownRegistration = (
      id: string,
      registrations: string[],
      capability: string,
      register: () => () => void,
    ): void => {
      if (!registration.registering) throw new PluginUnavailableError(registration.pluginName);
      if (registrations.includes(id)) {
        throw new Error(`Plugin ${capability} is already registered by this plugin: ${id}`);
      }
      registrations.push(id);
      registration.staged.push(register);
    };

    return {
      logger,

      registerTool(
        toolId: string,
        impl: (...arguments_: unknown[]) => unknown,
        schema?: unknown,
        effect?: ToolOperationEffect,
      ) {
        if (!registration.registering) {
          throw new PluginUnavailableError(registration.pluginName);
        }
        if (typeof impl !== 'function') {
          throw new TypeError(`Plugin tool implementation must be callable: ${toolId}`);
        }
        if (
          !toolRegistry ||
          typeof toolRegistry.hasTool !== 'function' ||
          typeof toolRegistry.unregisterTool !== 'function' ||
          typeof toolRegistry.registerOwnedTool !== 'function'
        ) {
          throw new Error(`Plugin tool requires an unloadable tool registry: ${toolId}`);
        }
        if (registration.tools.includes(toolId) || toolRegistry.hasTool(toolId)) {
          throw new Error(`Plugin tool conflicts with an existing tool: ${toolId}`);
        }
        const ownedImplementation = (...arguments_: unknown[]): unknown => invokeCapability(() => impl(...arguments_));
        registration.tools.push(toolId);
        registration.staged.push(() => {
          const unregisterSchema = schema !== undefined
            ? schemaRegistry.registerOwnedToolParameterSchema(toolId, schema, {
              displayName: toolId,
              description: `Plugin tool: ${toolId}`,
            })
            : undefined;
          let unregisterTool: (() => boolean) | undefined;
          try {
            unregisterTool = effect === undefined
              ? toolRegistry.registerOwnedTool(toolId, ownedImplementation, schema)
              : toolRegistry.registerOwnedTool(toolId, ownedImplementation, schema, effect);
          } catch (error) {
            // A structural host may throw after mutating. Best-effort rollback
            // makes registration atomic from the plugin's perspective.
            toolRegistry.unregisterTool(toolId);
            unregisterSchema?.();
            throw error;
          }
          return () => {
            unregisterTool?.();
            unregisterSchema?.();
          };
        });
      },

      registerHook(type: HookType, handler: HookHandler, name?: string) {
        if (!registration.registering) {
          throw new PluginUnavailableError(registration.pluginName);
        }
        if (typeof handler !== 'function') {
          throw new TypeError(`Plugin hook handler must be callable: ${type}`);
        }
        const hookName = pluginName
          ? `plugin-hook:${pluginName}:${type}:${name ?? hookIndex++}`
          : name ?? `plugin-hook:anonymous:${type}:${hookIndex++}`;
        if (
          registration.hooks.some(hook => hook.type === type && hook.name === hookName) ||
          hookRegistry.hasHook(type, hookName)
        ) {
          throw new Error(`Plugin hook conflicts with an existing hook: ${hookName}`);
        }
        registration.hooks.push({ type, name: hookName });
        registration.staged.push(() => {
          if (hookRegistry.hasHook(type, hookName)) {
            throw new Error(`Plugin hook conflicts with an existing hook: ${hookName}`);
          }
          const guardedHandler: HookHandler = (context, data) => invokeCapability(() => handler(context, data)) as Promise<Awaited<ReturnType<HookHandler>>>;
          const unregisterHook = hookRegistry.registerOwnedHook(type, guardedHandler, hookName);
          return () => {
            unregisterHook();
          };
        });
      },

      registerAgentProfile(profile: AgentProfile) {
        const id = readDataIdentifier(profile, 'id', 'agent profile');
        if (!agentProfileRegistry) throw new Error(`Plugin agent profile registry is unavailable: ${id}`);
        ownRegistration(id, registration.agentProfiles, 'agent profile', () => {
          const dispose = agentProfileRegistry.registerAgentProfile(profile);
          return () => {
            dispose();
          };
        });
      },

      registerLoopDefinition(definition: AgentLoopDefinition) {
        const id = readDataIdentifier(definition, 'id', 'loop definition');
        if (!loopRegistry) throw new Error(`Plugin loop registry is unavailable: ${id}`);
        if (typeof definition.createRunner !== 'function') {
          throw new TypeError(`Plugin loop definition createRunner must be callable: ${id}`);
        }
        const guardedDefinition: AgentLoopDefinition = {
          ...definition,
          createRunner: loopContext => {
            const runner = invokeCapability(() => definition.createRunner(loopContext)) as ReturnType<AgentLoopDefinition['createRunner']>;
            return input => invokeCapability(() => runner(input)) as ReturnType<typeof runner>;
          },
        };
        ownRegistration(id, registration.loopDefinitions, 'loop definition', () => loopRegistry.registerLoop(guardedDefinition));
      },

      registerLoopProfile(profile: LoopProfile) {
        const id = readDataIdentifier(profile, 'id', 'loop profile');
        if (!loopRegistry) throw new Error(`Plugin loop registry is unavailable: ${id}`);
        ownRegistration(id, registration.loopProfiles, 'loop profile', () => loopRegistry.registerProfile(profile));
      },

      registerLoopPlugin(plugin: LoopPlugin) {
        const id = readDataIdentifier(plugin, 'id', 'loop plugin');
        if (!loopRegistry) throw new Error(`Plugin loop registry is unavailable: ${id}`);
        const guardedPlugin: LoopPlugin = plugin.install === undefined
          ? { ...plugin }
          : {
            ...plugin,
            install: (loopContext, config) => invokeCapability(() => plugin.install!(loopContext, config)) as ReturnType<NonNullable<LoopPlugin['install']>>,
          };
        ownRegistration(id, registration.loopPlugins, 'loop plugin', () => loopRegistry.registerPlugin(guardedPlugin));
      },

      registerModelProvider(provider: ILLMProvider, config: Omit<ProviderConfig, 'name'>) {
        const id = readDataIdentifier(provider, 'name', 'model provider');
        if (!providerRegistry) throw new Error(`Plugin provider registry is unavailable: ${id}`);
        if (typeof provider.chat !== 'function') {
          throw new TypeError(`Plugin model provider chat must be callable: ${id}`);
        }
        const guardedProvider: ILLMProvider = {
          name: id,
          ...(provider.modelId === undefined ? {} : { modelId: provider.modelId }),
          ...(provider.model === undefined ? {} : { model: provider.model }),
          chat: request => invokeCapability(() => provider.chat(request)) as ReturnType<ILLMProvider['chat']>,
        };
        ownRegistration(id, registration.modelProviders, 'model provider', () => {
          const owned = providerRegistry.register(
            { ownerId: pluginName, kind: 'plugin' },
            guardedProvider,
            config,
          );
          return () => {
            owned.dispose();
          };
        });
      },
    };
  }

  registerPluginHooks(
    pluginName: string,
    hooks: Array<readonly [HookType, HookHandler, string?]>,
  ): void {
    const reg = this.ensureRegistration(pluginName);
    if (!reg.registering) throw new PluginUnavailableError(pluginName);
    const hookCount = reg.hooks.length;
    const stagedCount = reg.staged.length;
    try {
      for (const [type, handler, name] of hooks) {
        if (typeof handler !== 'function') {
          throw new TypeError(`Plugin hook handler must be callable: ${type}`);
        }
        const hookName = `plugin-hook:${pluginName}:${type}:${name ?? reg.hooks.length}`;
        if (this.hookRegistry.hasHook(type, hookName)) {
          throw new Error(`Plugin hook conflicts with an existing hook: ${hookName}`);
        }
        reg.hooks.push({ type, name: hookName });
        reg.staged.push(() => {
          if (this.hookRegistry.hasHook(type, hookName)) {
            throw new Error(`Plugin hook conflicts with an existing hook: ${hookName}`);
          }
          const guardedHandler: HookHandler = async (context, data) => {
            if (!reg.accepting) throw new PluginUnavailableError(pluginName);
            const result = Promise.resolve(handler(context, data));
            reg.inFlight.add(result);
            try {
              return await result;
            } finally {
              reg.inFlight.delete(result);
            }
          };
          const unregisterHook = this.hookRegistry.registerOwnedHook(type, guardedHandler, hookName);
          return () => {
            unregisterHook();
          };
        });
      }
      this.activatePluginRegistrations(pluginName);
    } catch (error) {
      reg.hooks.splice(hookCount);
      reg.staged.splice(stagedCount);
      throw error;
    }
  }

  getPluginRegistrations(pluginName: string): PluginRegistrationSnapshot | undefined {
    const registration = this.pluginRegistrations.get(pluginName);
    if (!registration) return undefined;
    return {
      pluginName: registration.pluginName,
      tools: [...registration.tools],
      hooks: registration.hooks.map(hook => ({ ...hook })),
      agentProfiles: [...registration.agentProfiles],
      loopDefinitions: [...registration.loopDefinitions],
      loopProfiles: [...registration.loopProfiles],
      loopPlugins: [...registration.loopPlugins],
      modelProviders: [...registration.modelProviders],
    };
  }

  /** Stop accepting new registrations and tool requests before unload. */
  suspendPluginRegistrations(pluginName: string): boolean {
    const registration = this.pluginRegistrations.get(pluginName);
    if (!registration) return false;
    registration.registering = false;
    registration.accepting = false;
    return true;
  }

  /** Atomically publish registrations only after activation and manifest validation succeed. */
  activatePluginRegistrations(pluginName: string): boolean {
    const registration = this.pluginRegistrations.get(pluginName);
    if (!registration || !registration.registering || registration.detached) return false;
    const published: Array<() => void> = [];
    try {
      for (const publish of registration.staged) published.push(publish());
    } catch (error) {
      for (const cleanup of published.reverse()) {
        try {
          cleanup();
        } catch {
          // Preserve the commit failure; the loader will perform final teardown.
        }
      }
      throw error;
    }
    registration.staged.length = 0;
    registration.cleanup.push(...published);
    registration.registering = false;
    registration.accepting = true;
    return true;
  }

  /** Wait for the plugin's already-started asynchronous tool calls to settle. */
  async drainPluginRegistrations(pluginName: string): Promise<void> {
    const registration = this.pluginRegistrations.get(pluginName);
    if (!registration || registration.inFlight.size === 0) return;
    await Promise.allSettled([...registration.inFlight]);
  }

  clearPluginRegistrations(): void {
    const errors: unknown[] = [];
    for (const pluginName of [...this.pluginRegistrations.keys()]) {
      try {
        this.unregisterPluginRegistrations(pluginName);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more plugin registrations failed to clean up');
    }
  }

  unregisterPluginRegistrations(pluginName: string): boolean {
    const detached = this.detachPluginRegistrations(pluginName);
    if (!detached) return false;
    this.finalizePluginRegistrations(pluginName);
    return true;
  }

  /** Remove routes/hooks immediately while retaining in-flight tracking for drain. */
  detachPluginRegistrations(pluginName: string): boolean {
    const registration = this.pluginRegistrations.get(pluginName);
    if (!registration) return false;
    registration.registering = false;
    registration.accepting = false;
    if (registration.detached) return true;
    registration.detached = true;
    registration.staged.length = 0;
    const errors: unknown[] = [];
    for (const cleanup of [...registration.cleanup].reverse()) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    registration.cleanup.length = 0;
    if (errors.length > 0) {
      throw new AggregateError(errors, `Plugin registration cleanup failed: ${pluginName}`);
    }
    return true;
  }

  /** Forget a detached plugin only after all started work has drained. */
  finalizePluginRegistrations(pluginName: string): boolean {
    const registration = this.pluginRegistrations.get(pluginName);
    if (!registration) return false;
    if (!registration.detached || registration.inFlight.size > 0) return false;
    this.pluginRegistrations.delete(pluginName);
    return true;
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function readDataIdentifier(value: object, property: string, field: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  if (
    !descriptor || descriptor.get !== undefined || descriptor.set !== undefined ||
    typeof descriptor.value !== 'string' || descriptor.value.trim().length === 0 ||
    descriptor.value.length > 1_024 || hasControlCharacters(descriptor.value)
  ) throw new TypeError(`Plugin ${field} must have a bounded data-property ${property}`);
  return descriptor.value;
}
