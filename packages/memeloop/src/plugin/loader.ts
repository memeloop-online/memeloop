/**
 * Plugin loader: discovers and loads plugin modules from plugin directories.
 *
 * Plugin directory resolution order:
 *   1. `MEMELOOP_PLUGINS_DIR` env var (if set)
 *   2. `./.memeloop/plugins/` (project-local, relative to cwd)
 *   3. `~/.memeloop/plugins/` (user-global)
 *
 * Each plugin directory must contain a `memeloop-plugin.json` manifest.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { LoadedPlugin, PluginManifest, PluginModule } from "./types.js";

/** In-memory registry of loaded plugins, keyed by plugin name. */
const loadedPlugins = new Map<string, LoadedPlugin>();

/**
 * Resolve the list of plugin directories to scan, in priority order.
 * Returns absolute paths.
 */
export function getPluginDirectories(projectRoot?: string): string[] {
  const dirs: string[] = [];

  // 1. Env override
  if (process.env.MEMELOOP_PLUGINS_DIR) {
    dirs.push(resolve(process.env.MEMELOOP_PLUGINS_DIR));
  }

  // 2. Project-local
  const cwd = projectRoot ?? process.cwd();
  dirs.push(resolve(cwd, ".memeloop", "plugins"));

  // 3. User-global
  dirs.push(resolve(homedir(), ".memeloop", "plugins"));

  return dirs;
}

/**
 * Read and validate a plugin manifest from the given directory.
 * Returns null if no valid manifest is found.
 */
export function readPluginManifest(dir: string): PluginManifest | null {
  const manifestPath = join(dir, "memeloop-plugin.json");
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest: unknown = JSON.parse(raw);
    return validateManifest(manifest);
  } catch {
    return null;
  }
}

/**
 * Validate a parsed manifest object against PluginManifest shape.
 * Returns the typed manifest or null if invalid.
 */
function validateManifest(obj: unknown): PluginManifest | null {
  if (!obj || typeof obj !== "object") return null;
  const m = obj as Record<string, unknown>;
  if (
    typeof m.name !== "string" ||
    m.name.trim().length === 0 ||
    typeof m.version !== "string" ||
    m.version.trim().length === 0 ||
    typeof m.entry !== "string" ||
    m.entry.trim().length === 0
  ) {
    return null;
  }
  return {
    name: m.name.trim(),
    version: m.version.trim(),
    description: typeof m.description === "string" ? m.description : "",
    entry: m.entry.trim(),
    exports: validateExports(m.exports),
    author: typeof m.author === "string" ? m.author : undefined,
    minMemeloopVersion:
      typeof m.minMemeloopVersion === "string" ? m.minMemeloopVersion : undefined,
  };
}

function validateExports(obj: unknown): PluginManifest["exports"] {
  if (!obj || typeof obj !== "object") return undefined;
  const e = obj as Record<string, unknown>;
  return {
    tools: Array.isArray(e.tools) ? e.tools.filter((s): s is string => typeof s === "string") : undefined,
    hooks: Array.isArray(e.hooks) ? e.hooks.filter((s): s is string => typeof s === "string") : undefined,
    skills: Array.isArray(e.skills) ? e.skills.filter((s): s is string => typeof s === "string") : undefined,
  };
}

/**
 * Discover all plugin directories within a parent plugins directory.
 * Each subdirectory that contains a `memeloop-plugin.json` is a candidate.
 */
export function discoverPlugins(parentDir: string): string[] {
  const pluginsDir = resolve(parentDir);
  if (!existsSync(pluginsDir)) return [];

  let entries;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      // Symlinks: check if target is a directory
      if (entry.isSymbolicLink()) {
        try {
          const target = resolve(pluginsDir, entry.name);
          return statSync(target).isDirectory();
        } catch {
          return false;
        }
      }
      return true;
    })
    .map((entry) => resolve(pluginsDir, entry.name))
    .filter((dir) => existsSync(join(dir, "memeloop-plugin.json")));
}

/**
 * Load a plugin from its manifest path.
 * Reads the manifest, loads the entry module, and calls activate().
 *
 * @param manifestPath - Absolute path to `memeloop-plugin.json`
 * @param api - Plugin API instance passed to the plugin's `activate()` call
 * @returns LoadedPlugin metadata, or null if loading failed
 */
export async function loadPlugin(
  manifestPath: string,
  api?: unknown,
): Promise<LoadedPlugin | null> {
  const manifestFile = resolve(manifestPath);
  // Read the manifest from the directory containing the manifest file
  const dir = dirname(manifestFile);
  const manifest = readPluginManifest(dir);
  if (!manifest) return null;

  // Already loaded?
  if (loadedPlugins.has(manifest.name)) {
    return loadedPlugins.get(manifest.name) ?? null;
  }

  const entryPath = resolve(dir, manifest.entry);
  if (!existsSync(entryPath)) {
    console.warn(`[plugin] Entry module not found: ${entryPath}`);
    return null;
  }

  try {
    // Dynamic import works with ESM and CJS (via transpilation)
    const mod: { default?: PluginModule } = await import(entryPath);

    if (!mod.default || typeof mod.default.activate !== "function") {
      console.warn(`[plugin] ${manifest.name}: module must export default { activate, name }`);
      return null;
    }

    const pluginModule = mod.default;
    if (pluginModule.name !== manifest.name) {
      console.warn(
        `[plugin] ${manifest.name}: module name "${pluginModule.name}" != manifest name, using manifest name`,
      );
    }

    const cleanup = await pluginModule.activate(api as any);

    const loaded: LoadedPlugin = {
      manifest,
      directory: dir,
      module: pluginModule,
      cleanup:
        typeof cleanup === "function" ? cleanup : undefined,
      loadedAt: new Date(),
    };

    loadedPlugins.set(manifest.name, loaded);
    return loaded;
  } catch (err) {
    console.error(`[plugin] Failed to load "${manifest.name}":`, err);
    return null;
  }
}

/**
 * Unload a plugin by name.
 * Calls the cleanup function returned by activate() and removes the plugin from the registry.
 *
 * @returns true if the plugin was found and unloaded
 */
export function unloadPlugin(name: string): boolean {
  const loaded = loadedPlugins.get(name);
  if (!loaded) return false;

  try {
    loaded.cleanup?.();
  } catch (err) {
    console.warn(`[plugin] Error during cleanup of "${name}":`, err);
  }

  loadedPlugins.delete(name);
  return true;
}

/**
 * List all currently loaded plugins.
 */
export function listPlugins(): LoadedPlugin[] {
  return Array.from(loadedPlugins.values());
}

/**
 * Get a loaded plugin by name.
 */
export function getLoadedPlugin(name: string): LoadedPlugin | undefined {
  return loadedPlugins.get(name);
}

/**
 * Check if a plugin is loaded.
 */
export function isPluginLoaded(name: string): boolean {
  return loadedPlugins.has(name);
}

/**
 * Unload all plugins and clear the registry.
 */
export function unloadAllPlugins(): void {
  for (const name of loadedPlugins.keys()) {
    unloadPlugin(name);
  }
}

/**
 * Load all plugins from all configured plugin directories.
 * This is the main entry point called during node runtime startup.
 *
 * @param api - Plugin API to pass to each plugin's activate()
 * @param projectRoot - Optional project root for relative path resolution
 * @returns Array of successfully loaded plugins
 */
export async function loadAllPlugins(
  api?: unknown,
  projectRoot?: string,
): Promise<LoadedPlugin[]> {
  const dirs = getPluginDirectories(projectRoot);
  const loaded: LoadedPlugin[] = [];

  for (const dir of dirs) {
    const pluginDirs = discoverPlugins(dir);
    for (const pluginDir of pluginDirs) {
      const manifestPath = join(pluginDir, "memeloop-plugin.json");
      const result = await loadPlugin(manifestPath, api);
      if (result) {
        loaded.push(result);
      }
    }
  }

  return loaded;
}
