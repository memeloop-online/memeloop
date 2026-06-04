import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  loadPluginModule,
  validatePluginManifest,
  type LoadedPlugin,
  type PluginManifest,
  type PluginModule,
} from "memeloop";

export interface FilePluginManifest extends PluginManifest {
  entry: string;
}

export function getPluginDirectories(projectRoot?: string): string[] {
  const dirs: string[] = [];

  if (process.env.MEMELOOP_PLUGINS_DIR) {
    dirs.push(resolve(process.env.MEMELOOP_PLUGINS_DIR));
  }

  const cwd = projectRoot ?? process.cwd();
  dirs.push(resolve(cwd, ".memeloop", "plugins"));
  dirs.push(resolve(homedir(), ".memeloop", "plugins"));

  return dirs;
}

export function readPluginManifest(dir: string): FilePluginManifest | null {
  const manifestPath = join(dir, "memeloop-plugin.json");
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return validateFilePluginManifest(parsed);
  } catch {
    return null;
  }
}

export function validateFilePluginManifest(obj: unknown): FilePluginManifest | null {
  if (!obj || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;
  if (typeof record.entry !== "string" || record.entry.trim().length === 0) return null;
  const manifest = validatePluginManifest(record);
  if (!manifest) return null;
  return {
    ...manifest,
    entry: record.entry.trim(),
  };
}

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
      if (entry.isDirectory()) return true;
      if (!entry.isSymbolicLink()) return false;
      try {
        return statSync(resolve(pluginsDir, entry.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => resolve(pluginsDir, entry.name))
    .filter((dir) => existsSync(join(dir, "memeloop-plugin.json")));
}

export async function loadPlugin(
  manifestPath: string,
  api?: unknown,
): Promise<LoadedPlugin | null> {
  const manifestFile = resolve(manifestPath);
  const directory = dirname(manifestFile);
  const manifest = readPluginManifest(directory);
  if (!manifest) return null;

  const entryPath = resolve(directory, manifest.entry);
  if (!existsSync(entryPath)) return null;

  try {
    const mod = (await import(entryPath)) as { default?: PluginModule };
    if (!mod.default || typeof mod.default.activate !== "function") return null;
    return loadPluginModule({ manifest, module: mod.default, api, source: entryPath });
  } catch {
    return null;
  }
}

export async function loadAllPlugins(
  api?: unknown,
  projectRoot?: string,
): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];

  for (const dir of getPluginDirectories(projectRoot)) {
    for (const pluginDir of discoverPlugins(dir)) {
      const plugin = await loadPlugin(join(pluginDir, "memeloop-plugin.json"), api);
      if (plugin) loaded.push(plugin);
    }
  }

  return loaded;
}