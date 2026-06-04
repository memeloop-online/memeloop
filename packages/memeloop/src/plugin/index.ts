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
  loadPluginModule,
  loadPluginModules,
  unloadPlugin,
  listPlugins,
  getLoadedPlugin,
  isPluginLoaded,
  unloadAllPlugins,
  validatePluginManifest,
} from "./loader.js";
export type { LoadPluginModuleOptions } from "./loader.js";

export {
  createPluginAPI,
  registerPluginTools,
  registerPluginHooks,
  registerPluginSkills,
  getPluginRegistrations,
  clearPluginRegistrations,
} from "./registry.js";
export type { PluginAPIOptions } from "./registry.js";
