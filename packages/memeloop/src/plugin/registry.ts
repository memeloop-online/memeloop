/**
 * Plugin registry: bridges plugin exports to memeloop's tool and hook registries.
 *
 * Provides a `createPluginAPI()` factory that plugins call during `activate()`
 * to register their tools and hooks with the host runtime.
 *
 * Converted from module-level singletons to an instance class for test isolation
 * and multi-runtime support.
 */

import { registerHook } from '../agentLoops/hooks/registry.js';
import type { HookHandler, HookType } from '../agentLoops/hooks/types.js';
import { registerToolParameterSchema } from '../tools/schemaRegistry.js';
import type { PluginAPI } from './types.js';

/** Plugin API factory options. */
export interface PluginAPIOptions {
  toolRegistry?: {
    registerTool(id: string, impl: unknown): void;
  };
  logger?: PluginAPI['logger'];
}

/**
 * Track which tools/plugins belong to each plugin so we can clean up on unload.
 */
interface PluginRegistration {
  pluginName: string;
  tools: string[];
  hooks: Array<{ type: HookType; name: string }>;
}

/**
 * Instance-level plugin registration manager.
 */
export class PluginRegistryManager {
  private readonly pluginRegistrations = new Map<string, PluginRegistration>();

  private ensureRegistration(pluginName: string): PluginRegistration {
    const existing = this.pluginRegistrations.get(pluginName);
    if (existing) return existing;
    const reg: PluginRegistration = {
      pluginName,
      tools: [],
      hooks: [],
    };
    this.pluginRegistrations.set(pluginName, reg);
    return reg;
  }

  /**
   * Create a PluginAPI instance that plugins use to register their capabilities.
   */
  createPluginAPI(options: PluginAPIOptions = {}): PluginAPI {
    const toolRegistry = options.toolRegistry;
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

    return {
      logger,

      registerTool(toolId: string, impl: (...arguments_: unknown[]) => unknown, schema?: unknown) {
        toolRegistry?.registerTool(toolId, impl);
        if (schema) {
          registerToolParameterSchema(toolId, schema as object, {
            displayName: toolId,
            description: `Plugin tool: ${toolId}`,
          });
        }
      },

      registerHook(type: HookType, handler: HookHandler, name?: string) {
        const hookName = name ?? `plugin-hook:${type}:${Date.now().toString(36)}`;
        registerHook(type, handler, hookName);
      },
    };
  }

  registerPluginTools(
    pluginName: string,
    tools: Array<readonly [string, (...arguments_: unknown[]) => unknown, unknown?]>,
  ): void {
    const reg = this.ensureRegistration(pluginName);
    for (const [toolId, , schema] of tools) {
      if (schema) {
        registerToolParameterSchema(toolId, schema as object, {
          displayName: toolId,
          description: `Plugin tool: ${toolId}`,
        });
      }
      reg.tools.push(toolId);
    }
  }

  registerPluginHooks(
    pluginName: string,
    hooks: Array<readonly [HookType, HookHandler, string?]>,
  ): void {
    const reg = this.ensureRegistration(pluginName);
    for (const [type, handler, name] of hooks) {
      const hookName = name ?? `plugin-hook:${pluginName}:${type}:${reg.hooks.length}`;
      registerHook(type, handler, hookName);
      reg.hooks.push({ type, name: hookName });
    }
  }

  getPluginRegistrations(pluginName: string): PluginRegistration | undefined {
    return this.pluginRegistrations.get(pluginName);
  }

  clearPluginRegistrations(): void {
    this.pluginRegistrations.clear();
  }
}

// ─── Default global instance + backward-compatible function exports ───

const defaultPluginRegistryManager = new PluginRegistryManager();

export function getDefaultPluginRegistryManager(): PluginRegistryManager {
  return defaultPluginRegistryManager;
}

export function createPluginAPI(options: PluginAPIOptions = {}): PluginAPI {
  return defaultPluginRegistryManager.createPluginAPI(options);
}

export function registerPluginTools(
  pluginName: string,
  tools: Array<readonly [string, (...arguments_: unknown[]) => unknown, unknown?]>,
): void {
  defaultPluginRegistryManager.registerPluginTools(pluginName, tools);
}

export function registerPluginHooks(
  pluginName: string,
  hooks: Array<readonly [HookType, HookHandler, string?]>,
): void {
  defaultPluginRegistryManager.registerPluginHooks(pluginName, hooks);
}

export function getPluginRegistrations(pluginName: string): PluginRegistration | undefined {
  return defaultPluginRegistryManager.getPluginRegistrations(pluginName);
}

export function clearPluginRegistrations(): void {
  defaultPluginRegistryManager.clearPluginRegistrations();
}
