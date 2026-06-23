import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { type LoadedPlugin, loadPluginModule, type PluginManifest, type PluginModule, validatePluginManifest } from 'memeloop';

export interface FilePluginManifest extends PluginManifest {
  entry: string;
}

export function getPluginDirectories(projectRoot?: string): string[] {
  const directories: string[] = [];

  if (process.env.MEMELOOP_PLUGINS_DIR) {
    directories.push(resolve(process.env.MEMELOOP_PLUGINS_DIR));
  }

  const cwd = projectRoot ?? process.cwd();
  directories.push(resolve(cwd, '.memeloop', 'plugins'));
  directories.push(resolve(homedir(), '.memeloop', 'plugins'));

  return directories;
}

export function readPluginManifest(directory: string): FilePluginManifest | null {
  const manifestPath = join(directory, 'memeloop-plugin.json');
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return validateFilePluginManifest(parsed);
  } catch {
    return null;
  }
}

export function validateFilePluginManifest(object: unknown): FilePluginManifest | null {
  if (!object || typeof object !== 'object') return null;
  const record = object as Record<string, unknown>;
  if (typeof record.entry !== 'string' || record.entry.trim().length === 0) return null;
  const manifest = validatePluginManifest(record);
  if (!manifest) return null;
  return {
    ...manifest,
    entry: record.entry.trim(),
  };
}

export function discoverPlugins(parentDirectory: string): string[] {
  const pluginsDirectory = resolve(parentDirectory);
  if (!existsSync(pluginsDirectory)) return [];

  let entries;
  try {
    entries = readdirSync(pluginsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => {
      if (entry.isDirectory()) return true;
      if (!entry.isSymbolicLink()) return false;
      try {
        return statSync(resolve(pluginsDirectory, entry.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => resolve(pluginsDirectory, entry.name))
    .filter((directory) => existsSync(join(directory, 'memeloop-plugin.json')));
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
    if (!mod.default || typeof mod.default.activate !== 'function') return null;
    return await loadPluginModule({ manifest, module: mod.default, api, source: entryPath });
  } catch {
    return null;
  }
}

export async function loadAllPlugins(
  api?: unknown,
  projectRoot?: string,
): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];

  for (const directory of getPluginDirectories(projectRoot)) {
    for (const pluginDirectory of discoverPlugins(directory)) {
      const plugin = await loadPlugin(join(pluginDirectory, 'memeloop-plugin.json'), api);
      if (plugin) loaded.push(plugin);
    }
  }

  return loaded;
}
