/**
 * Plugin marketplace architecture.
 * Supports loading runtime-owned third-party executable capabilities.
 */
export type { LoadedPlugin, PluginAPI, PluginCleanup, PluginExports, PluginManifest, PluginModule } from './types.js';

export { MEMELOOP_PLUGIN_API_VERSION, PluginLifecycleTimeoutError, PluginLoader, validatePluginManifest } from './loader.js';
export type { LoadPluginModuleOptions, PluginLoaderOptions } from './loader.js';

export { PluginRegistryManager, PluginUnavailableError } from './registry.js';
export type {
  PluginAgentProfileRegistry,
  PluginAPIOptions,
  PluginLoopRegistry,
  PluginProviderRegistry,
  PluginRegistrationSnapshot,
  PluginRegistryManagerOptions,
  PluginToolRegistry,
} from './registry.js';
