/**
 * Plugin marketplace architecture.
 * Supports loading third-party plugins with tools, hooks, and skills.
 */
export type {
  PluginManifest,
  PluginExports,
  PluginModule,
  PluginAPI,
  LoadedPlugin,
} from "./types.js";

export {
  loadPlugin,
  unloadPlugin,
  listPlugins,
  getLoadedPlugin,
  isPluginLoaded,
  unloadAllPlugins,
  loadAllPlugins,
  getPluginDirectories,
  discoverPlugins,
  readPluginManifest,
} from "./loader.js";

export {
  createPluginAPI,
  registerPluginTools,
  registerPluginHooks,
  registerPluginSkills,
  getPluginRegistrations,
  clearPluginRegistrations,
} from "./registry.js";
export type { PluginAPIOptions } from "./registry.js";
