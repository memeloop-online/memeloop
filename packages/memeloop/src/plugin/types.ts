/**
 * Plugin marketplace architecture types.
 * Plugins can provide tools and hooks to extend memeloop.
 */
import type { HookHandler, HookType } from "../agentLoops/hooks/types.js";

/**
 * Plugin manifest schema.
 * Host adapters may read this from files or construct it programmatically.
 */
export interface PluginManifest {
  /** Unique plugin identifier (e.g. "plugin-hello", "@scope/my-plugin") */
  name: string;
  /** Semantic version */
  version: string;
  /** Human-readable description */
  description: string;
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
   * tools and hooks. Return a cleanup function for teardown.
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
  /** Optional host-provided source identifier, e.g. package name or file path. */
  source: string;
  /** The loaded plugin module */
  module: PluginModule;
  /** Cleanup function returned by activate(), if any */
  cleanup: (() => void) | undefined;
  /** When the plugin was loaded */
  loadedAt: Date;
}
