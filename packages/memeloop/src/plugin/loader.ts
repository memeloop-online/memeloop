import type { HookType } from "../agentLoops/hooks/types.js";
import type { LoadedPlugin, PluginManifest, PluginModule } from "./types.js";

const loadedPlugins = new Map<string, LoadedPlugin>();

const hookTypes = new Set<string>([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "ContextCompaction",
  "AgentStart",
  "AgentStop",
]);

function isHookType(value: unknown): value is HookType {
  return typeof value === "string" && hookTypes.has(value);
}

export function validatePluginManifest(object: unknown): PluginManifest | null {
  if (!object || typeof object !== "object") return null;
  const manifest = object as Record<string, unknown>;
  if (
    typeof manifest.name !== "string" ||
    manifest.name.trim().length === 0 ||
    typeof manifest.version !== "string" ||
    manifest.version.trim().length === 0
  ) {
    return null;
  }
  return {
    name: manifest.name.trim(),
    version: manifest.version.trim(),
    description: typeof manifest.description === "string" ? manifest.description : "",
    exports: validateExports(manifest.exports),
    author: typeof manifest.author === "string" ? manifest.author : undefined,
    minMemeloopVersion:
      typeof manifest.minMemeloopVersion === "string" ? manifest.minMemeloopVersion : undefined,
  };
}

function validateExports(object: unknown): PluginManifest["exports"] {
  if (!object || typeof object !== "object") return undefined;
  const exportsRecord = object as Record<string, unknown>;
  return {
    tools: Array.isArray(exportsRecord.tools)
      ? exportsRecord.tools.filter((tool): tool is string => typeof tool === "string")
      : undefined,
    hooks: Array.isArray(exportsRecord.hooks) ? exportsRecord.hooks.filter(isHookType) : undefined,
  };
}

export interface LoadPluginModuleOptions {
  manifest: PluginManifest;
  module: PluginModule;
  api?: unknown;
  source?: string;
}

export async function loadPluginModule(
  options: LoadPluginModuleOptions,
): Promise<LoadedPlugin | null> {
  const { manifest, module, api, source = "" } = options;
  const validManifest = validatePluginManifest(manifest);
  if (!validManifest) return null;

  if (loadedPlugins.has(validManifest.name)) {
    return loadedPlugins.get(validManifest.name) ?? null;
  }

  if (!module || typeof module.activate !== "function") {
    return null;
  }

  const cleanup = await module.activate(api as never);
  const loaded: LoadedPlugin = {
    manifest: validManifest,
    source,
    module,
    cleanup: typeof cleanup === "function" ? cleanup : undefined,
    loadedAt: new Date(),
  };

  loadedPlugins.set(validManifest.name, loaded);
  return loaded;
}

export async function loadPluginModules(
  plugins: LoadPluginModuleOptions[],
): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];
  for (const plugin of plugins) {
    const result = await loadPluginModule(plugin);
    if (result) loaded.push(result);
  }
  return loaded;
}

export function unloadPlugin(name: string): boolean {
  const loaded = loadedPlugins.get(name);
  if (!loaded) return false;

  try {
    loaded.cleanup?.();
  } catch (error) {
    console.warn(`[plugin] Error during cleanup of "${name}":`, error);
  }

  loadedPlugins.delete(name);
  return true;
}

export function listPlugins(): LoadedPlugin[] {
  return Array.from(loadedPlugins.values());
}

export function getLoadedPlugin(name: string): LoadedPlugin | undefined {
  return loadedPlugins.get(name);
}

export function isPluginLoaded(name: string): boolean {
  return loadedPlugins.has(name);
}

export function unloadAllPlugins(): void {
  for (const name of loadedPlugins.keys()) {
    unloadPlugin(name);
  }
}
