/**
 * Plugin registry: bridges plugin exports to memeloop's tool/hook/skill registries.
 *
 * Provides a `createPluginAPI()` factory that plugins call during `activate()`
 * to register their tools, hooks, and skills with the host runtime.
 */

import { registerSkill } from "../definitions/skillRegistry.js";
import type { SkillDefinition } from "../definitions/skillTypes.js";
import { registerHook } from "../hooks/registry.js";
import type { HookHandler, HookType } from "../hooks/types.js";
import { registerToolParameterSchema } from "../tools/schemaRegistry.js";
import type { PluginAPI } from "./types.js";

/** Plugin API factory options. */
export interface PluginAPIOptions {
  /**
   * Tool registry where plugin tools are stored.
   * Plugins register tools as `registry.registerTool(toolId, impl)`.
   */
  toolRegistry?: {
    registerTool(id: string, impl: unknown): void;
  };

  /**
   * Logger instance. Defaults to console if not provided.
   */
  logger?: PluginAPI["logger"];
}

/**
 * Track which tools/plugins belong to each plugin so we can clean up on unload.
 */
interface PluginRegistration {
  pluginName: string;
  tools: string[];
  hooks: Array<{ type: HookType; name: string }>;
  skills: string[];
}

/** Registry of per-plugin registrations, keyed by plugin name. */
const pluginRegistrations = new Map<string, PluginRegistration>();

function ensureRegistration(pluginName: string): PluginRegistration {
  const existing = pluginRegistrations.get(pluginName);
  if (existing) return existing;
  const reg: PluginRegistration = {
    pluginName,
    tools: [],
    hooks: [],
    skills: [],
  };
  pluginRegistrations.set(pluginName, reg);
  return reg;
}

/**
 * Create a PluginAPI instance that plugins use to register their capabilities.
 * The returned object is passed to each plugin's `activate(api)` call.
 */
export function createPluginAPI(options: PluginAPIOptions = {}): PluginAPI {
  const toolRegistry = options.toolRegistry;
  const logger = options.logger ?? {
    debug: (...arguments_: unknown[]) => {
      console.debug("[plugin]", ...arguments_);
    },
    info: (...arguments_: unknown[]) => {
      console.info("[plugin]", ...arguments_);
    },
    warn: (...arguments_: unknown[]) => {
      console.warn("[plugin]", ...arguments_);
    },
    error: (...arguments_: unknown[]) => {
      console.error("[plugin]", ...arguments_);
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

    registerSkill(skill: SkillDefinition) {
      registerSkill(skill);
    },
  };
}

/**
 * Register plugin tools, hooks, and skills with tracking for later cleanup.
 *
 * @param pluginName - Plugin name (from manifest)
 * @param tools - Array of [toolId, impl, schema?] tuples
 * @param hooks - Array of [hookType, handler, name?] tuples
 * @param skills - Array of SkillDefinition objects
 */
export function registerPluginTools(
  pluginName: string,
  tools: Array<readonly [string, (...arguments_: unknown[]) => unknown, unknown?]>,
): void {
  const reg = ensureRegistration(pluginName);
  for (const [toolId, , schema] of tools) {
    // Defer registration via the API – but we need a toolRegistry here.
    // Tools registered this way are tracked and can be deregistered later.
    if (schema) {
      registerToolParameterSchema(toolId, schema as object, {
        displayName: toolId,
        description: `Plugin tool: ${toolId}`,
      });
    }
    reg.tools.push(toolId);
  }
}

export function registerPluginHooks(
  pluginName: string,
  hooks: Array<readonly [HookType, HookHandler, string?]>,
): void {
  const reg = ensureRegistration(pluginName);
  for (const [type, handler, name] of hooks) {
    const hookName = name ?? `plugin-hook:${pluginName}:${type}:${reg.hooks.length}`;
    registerHook(type, handler, hookName);
    reg.hooks.push({ type, name: hookName });
  }
}

export function registerPluginSkills(pluginName: string, skills: SkillDefinition[]): void {
  const reg = ensureRegistration(pluginName);
  for (const skill of skills) {
    registerSkill(skill);
    reg.skills.push(skill.id);
  }
}

/**
 * Get all registrations for a plugin.
 */
export function getPluginRegistrations(pluginName: string): PluginRegistration | undefined {
  return pluginRegistrations.get(pluginName);
}

/**
 * Clear the plugin registration tracking.
 * Does NOT unregister from the underlying tool/hook/skill registries.
 * Use `unloadAllPlugins()` from loader.ts to perform full teardown.
 */
export function clearPluginRegistrations(): void {
  pluginRegistrations.clear();
}
