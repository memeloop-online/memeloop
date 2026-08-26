/**
 * Plugin marketplace architecture types.
 * Plugins can provide runtime-owned executable capabilities to extend memeloop.
 */
import type { AgentProfile } from '../agent/agentProfiles.js';
import type { ProviderConfig } from '../llm/providerRegistry.js';
import type { HookHandler, HookType } from '../loopAPI/hooks/types.js';
import type { AgentLoopDefinition, LoopPlugin, LoopProfile } from '../loopAPI/types.js';
import type { ToolOperationEffect } from '../orchestration/resources.js';
import type { ILLMProvider } from '../types.js';

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
  tools?: readonly string[];
  /** Hook types this plugin listens for */
  hooks?: readonly HookType[];
  /** Agent-profile IDs registered into this runtime. */
  agentProfiles?: readonly string[];
  /** Loop-definition IDs registered into this runtime. */
  loopDefinitions?: readonly string[];
  /** Loop-profile IDs registered into this runtime. */
  loopProfiles?: readonly string[];
  /** Loop-plugin IDs registered into this runtime. */
  loopPlugins?: readonly string[];
  /** Model-provider IDs registered into this runtime. */
  modelProviders?: readonly string[];
}

/** Cleanup returned by a plugin activation hook. Hosts await it during unload. */
export type PluginCleanup = () => void | Promise<void>;

export type PluginActivate =
  | ((api: PluginAPI) => void)
  | ((api: PluginAPI) => PluginCleanup)
  | ((api: PluginAPI) => Promise<void>)
  | ((api: PluginAPI) => Promise<PluginCleanup | undefined>);

/**
 * Shape of a loaded plugin module's default export.
 * Plugins must export default an object conforming to this interface.
 */
export interface PluginModule {
  /** Plugin identity (must match manifest name) */
  name: string;
  /**
   * Called when the plugin is loaded. Receives the PluginAPI for registering
   * executable capabilities. Return a cleanup function for teardown.
   */
  activate: PluginActivate;
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
  registerTool(
    toolId: string,
    impl: (...arguments_: unknown[]) => unknown,
    schema?: unknown,
    effect?: ToolOperationEffect,
  ): void;

  /**
   * Register a lifecycle hook handler.
   * @param type - Hook event type
   * @param handler - Async handler function
   * @param name - Optional handler name (enables dedup/unregistration)
   */
  registerHook(type: HookType, handler: HookHandler, name?: string): void;

  /** Register an unloadable runtime agent profile. */
  registerAgentProfile(profile: AgentProfile): void;

  /** Register an unloadable loop definition. */
  registerLoopDefinition(definition: AgentLoopDefinition): void;

  /** Register an unloadable loop profile. */
  registerLoopProfile(profile: LoopProfile): void;

  /** Register an unloadable loop plugin. */
  registerLoopPlugin(plugin: LoopPlugin): void;

  /** Register a model provider owned by this plugin. */
  registerModelProvider(
    provider: ILLMProvider,
    config: Omit<ProviderConfig, 'name'>,
  ): void;

  // Durable AgentDefinition records are intentionally excluded: they are user
  // data managed by storage and must not disappear when executable code unloads.

  /** Log to memeloop's logger (falls back to console). */
  logger: {
    debug: (message: string, ...arguments_: unknown[]) => void;
    info: (message: string, ...arguments_: unknown[]) => void;
    warn: (message: string, ...arguments_: unknown[]) => void;
    error: (message: string, ...arguments_: unknown[]) => void;
  };
}

/** Immutable public metadata about a loaded plugin instance. */
export interface LoadedPlugin {
  readonly manifest: Readonly<PluginManifest>;
  /** Optional host-provided source identifier, e.g. package name or file path. */
  readonly source: string;
  /** ISO timestamp. Executable module and cleanup handles are never exposed. */
  readonly loadedAt: string;
}
