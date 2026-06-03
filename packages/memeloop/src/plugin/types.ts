/**
 * Plugin marketplace architecture types.
 * Plugins can provide tools, hooks, and skills to extend memeloop.
 */

import type { SkillDefinition } from "../definitions/skillTypes.js";
import type { HookHandler, HookType } from "../hooks/types.js";

/**
 * Plugin manifest schema.
 * Each plugin directory must contain a `memeloop-plugin.json` manifest.
 */
export interface PluginManifest {
  /** Unique plugin identifier (e.g. "plugin-hello", "@scope/my-plugin") */
  name: string;
  /** Semantic version */
  version: string;
  /** Human-readable description */
  description: string;
  /** Path to the plugin entry module (relative to manifest dir, e.g. "index.js" or "index.ts") */
  entry: string;
  /** Declared exports: what the plugin provides */
  exports?: PluginExports;
  /** Plugin author */
  author?: string;
  /** Minimum memeloop version requirement (semver range) */
  minMemeloopVersion?: string;
}

/** Declared capabilities a plugin may export. */
export interface PluginExports {
  /** Tool IDs this plugin implements */
  tools?: string[];
  /** Hook types this plugin listens for */
  hooks?: HookType[];
  /** Skill IDs this plugin provides */
  skills?: string[];
}

/**
 * Shape of a loaded plugin module's default export.
 * Plugins must export default an object conforming to this interface.
 */
export interface PluginModule {
  /** Plugin identity (must match manifest name) */
  name: string;
  /**
   * Called when the plugin is loaded. Receives the PluginAPI for registering
   * tools, hooks, and skills. Return a cleanup function for teardown.
   */
  activate: (api: PluginAPI) => (() => void) | Promise<() => void> | undefined;
}

/**
 * API surface exposed to plugins. Plugins call these methods in their
 * `activate` function to register their capabilities.
 */
export interface PluginAPI {
  /**
   * Register a tool implementation.
   * @param toolId - Unique tool ID (e.g. "plugin-hello.sayHi")
   * @param impl - Tool implementation function
   * @param schema - Optional parameter schema (Zod type)
   */
  registerTool(toolId: string, impl: (...arguments_: unknown[]) => unknown, schema?: unknown): void;

  /**
   * Register a lifecycle hook handler.
   * @param type - Hook event type
   * @param handler - Async handler function
   * @param name - Optional handler name (enables dedup/unregistration)
   */
  registerHook(type: HookType, handler: HookHandler, name?: string): void;

  /**
   * Register a skill definition.
   * @param skill - Skill definition (id, name, instructions)
   */
  registerSkill(skill: SkillDefinition): void;

  /** Log to memeloop's logger (falls back to console). */
  logger: {
    debug: (message: string, ...arguments_: unknown[]) => void;
    info: (message: string, ...arguments_: unknown[]) => void;
    warn: (message: string, ...arguments_: unknown[]) => void;
    error: (message: string, ...arguments_: unknown[]) => void;
  };
}

/** Metadata about a loaded plugin instance. */
export interface LoadedPlugin {
  /** Manifest data */
  manifest: PluginManifest;
  /** Absolute path to the plugin directory */
  directory: string;
  /** The loaded plugin module */
  module: PluginModule;
  /** Cleanup function returned by activate(), if any */
  cleanup: (() => void) | undefined;
  /** When the plugin was loaded */
  loadedAt: Date;
}
