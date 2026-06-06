/**
 * Plugin marketplace architecture.
 * Supports loading third-party plugins with tools, hooks, and skills.
 */
export type { LoadedPlugin, PluginAPI, PluginExports, PluginManifest, PluginModule } from './types.js';

export { getLoadedPlugin, isPluginLoaded, listPlugins, loadPluginModule, loadPluginModules, unloadAllPlugins, unloadPlugin, validatePluginManifest } from './loader.js';
export type { LoadPluginModuleOptions } from './loader.js';

export { clearPluginRegistrations, createPluginAPI, getPluginRegistrations, registerPluginHooks, registerPluginSkills, registerPluginTools } from './registry.js';
export type { PluginAPIOptions } from './registry.js';
