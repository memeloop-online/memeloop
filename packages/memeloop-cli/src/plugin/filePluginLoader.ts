import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type LoadedPlugin, type PluginAPIOptions, PluginLoader, type PluginManifest, type PluginModule, validatePluginManifest } from 'memeloop';

const MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export interface FilePluginManifest extends PluginManifest {
  entry: string;
}

export interface FilePluginLoadOptions extends Omit<PluginAPIOptions, 'pluginName'> {
  /** Runtime-scoped lifecycle owner. The caller must unload it during shutdown. */
  loader: PluginLoader;
  /** Exact plugin directories allowed by the host policy. */
  allowedPluginPaths?: readonly string[];
  onError?: (error: unknown, source: string) => void;
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

export function pluginEntryImportSpecifier(entryPath: string): string {
  return pathToFileURL(entryPath).href;
}

export function getPluginDirectories(projectRoot?: string): string[] {
  const directories: string[] = [];

  if (process.env.MEMELOOP_PLUGINS_DIR) {
    directories.push(resolve(process.env.MEMELOOP_PLUGINS_DIR));
  }

  const cwd = projectRoot ?? process.cwd();
  directories.push(resolve(cwd, '.memeloop', 'plugins'));
  directories.push(resolve(homedir(), '.memeloop', 'plugins'));

  return [...new Set(directories)];
}

export function readPluginManifest(directory: string): FilePluginManifest | null {
  const manifestPath = join(directory, 'memeloop-plugin.json');
  if (!existsSync(manifestPath)) return null;

  try {
    const stats = statSync(manifestPath);
    if (!stats.isFile() || stats.size > MAX_PLUGIN_MANIFEST_BYTES) return null;
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
  if (
    typeof record.entry !== 'string' ||
    record.entry.trim().length === 0 ||
    record.entry.trim().length > 4096 ||
    hasControlCharacters(record.entry)
  ) return null;
  const coreManifest = { ...record };
  delete coreManifest.entry;
  const manifest = validatePluginManifest(coreManifest);
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

  return [
    ...new Set(
      entries
        .filter((entry) => {
          if (entry.isDirectory()) return true;
          if (!entry.isSymbolicLink()) return false;
          try {
            return statSync(resolve(pluginsDirectory, entry.name)).isDirectory();
          } catch {
            return false;
          }
        })
        .map((entry) => canonicalPath(resolve(pluginsDirectory, entry.name)))
        .filter((directory) => existsSync(join(directory, 'memeloop-plugin.json'))),
    ),
  ]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export async function loadPlugin(
  manifestPath: string,
  options: FilePluginLoadOptions,
): Promise<LoadedPlugin | null> {
  const manifestFile = resolve(manifestPath);
  const directory = dirname(manifestFile);
  const manifest = readPluginManifest(directory);
  if (!manifest) return null;

  const entryPath = resolve(directory, manifest.entry);
  if (!existsSync(entryPath)) return null;

  try {
    const canonicalDirectory = canonicalPath(directory);
    const canonicalEntryPath = canonicalPath(entryPath);
    const relativeEntryPath = relative(canonicalDirectory, canonicalEntryPath);
    if (relativeEntryPath.startsWith('..') || isAbsolute(relativeEntryPath)) {
      throw new Error(`Plugin entry escapes its plugin directory: ${manifest.entry}`);
    }
    const mod = (await import(pluginEntryImportSpecifier(canonicalEntryPath))) as { default?: PluginModule };
    if (!mod.default || typeof mod.default.activate !== 'function') return null;
    const apiOptions: Omit<PluginAPIOptions, 'pluginName'> = {
      ...(options.toolRegistry === undefined ? {} : { toolRegistry: options.toolRegistry }),
      ...(options.agentProfileRegistry === undefined
        ? {}
        : { agentProfileRegistry: options.agentProfileRegistry }),
      ...(options.loopRegistry === undefined ? {} : { loopRegistry: options.loopRegistry }),
      ...(options.providerRegistry === undefined
        ? {}
        : { providerRegistry: options.providerRegistry }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    };
    const pluginManifest: PluginManifest & { entry?: string } = { ...manifest };
    delete pluginManifest.entry;
    return await options.loader.loadPluginModule({
      manifest: pluginManifest,
      module: mod.default,
      apiOptions,
      source: canonicalEntryPath,
    });
  } catch (error) {
    options.onError?.(error, manifestFile);
    return null;
  }
}

export async function loadAllPlugins(
  options: FilePluginLoadOptions,
  projectRoot?: string,
): Promise<LoadedPlugin[]> {
  // Discovery imports and executes arbitrary JavaScript. Never interpret an
  // omitted/empty allowlist as "trust every plugin under cwd or home".
  if (!options.allowedPluginPaths || options.allowedPluginPaths.length === 0) return [];
  const loaded: LoadedPlugin[] = [];
  const seenDirectories = new Set<string>();
  const allowedPaths = options.allowedPluginPaths.map(canonicalPath);

  for (const directory of getPluginDirectories(projectRoot)) {
    for (const pluginDirectory of discoverPlugins(directory)) {
      const canonicalDirectory = canonicalPath(pluginDirectory);
      if (seenDirectories.has(canonicalDirectory)) continue;
      seenDirectories.add(canonicalDirectory);
      if (!allowedPaths.includes(canonicalDirectory)) continue;
      const plugin = await loadPlugin(join(canonicalDirectory, 'memeloop-plugin.json'), options);
      if (plugin) loaded.push(plugin);
    }
  }

  return loaded;
}
