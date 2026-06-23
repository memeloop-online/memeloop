import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createPluginAPI, unloadAllPlugins } from 'memeloop';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverPlugins, getPluginDirectories, loadAllPlugins, loadPlugin, readPluginManifest } from '../filePluginLoader.js';

function writeManifest(dir: string, overrides: Record<string, unknown> = {}) {
  const manifest = {
    name: 'test-plugin',
    version: '0.1.0',
    description: 'Unit test plugin',
    entry: 'index.mjs',
    ...overrides,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'memeloop-plugin.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function writePluginEntry(dir: string, content: string, filename = 'index.mjs') {
  writeFileSync(join(dir, filename), content);
}

describe('file plugin loader', () => {
  let testRoot: string;

  beforeEach(() => {
    vi.unstubAllEnvs();
    testRoot = resolve(tmpdir(), `memeloop-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testRoot, { recursive: true });
    unloadAllPlugins();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    unloadAllPlugins();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('reads manifests and discovers plugin directories', () => {
    const pluginA = join(testRoot, 'plugins', 'plugin-a');
    writeManifest(pluginA);
    mkdirSync(join(testRoot, 'plugins', 'not-plugin'), { recursive: true });

    expect(readPluginManifest(pluginA)?.entry).toBe('index.mjs');
    expect(discoverPlugins(join(testRoot, 'plugins'))).toEqual([pluginA]);
    expect(readPluginManifest(join(testRoot, 'missing'))).toBeNull();
  });

  it('resolves plugin directories from env, project, and home', () => {
    vi.stubEnv('MEMELOOP_PLUGINS_DIR', '/custom/plugins');
    const dirs = getPluginDirectories('/project');
    expect(dirs[0]).toBe(resolve('/custom/plugins'));
    expect(dirs).toContain(resolve('/project', '.memeloop', 'plugins'));
  });

  it('loads a plugin module from disk', async () => {
    const pluginDir = join(testRoot, 'plugins', 'hello');
    writeManifest(pluginDir, { name: 'plugin-hello' });
    writePluginEntry(
      pluginDir,
      `export default {
  name: "plugin-hello",
  activate(api) {
    api.registerTool("plugin-hello.hello", () => "hello");
  }
};`,
    );
    const mockRegistry = { registerTool: vi.fn() };
    const loaded = await loadPlugin(join(pluginDir, 'memeloop-plugin.json'), createPluginAPI({ toolRegistry: mockRegistry }));

    expect(loaded?.manifest.name).toBe('plugin-hello');
    expect(loaded?.source).toBe(resolve(pluginDir, 'index.mjs'));
    expect(mockRegistry.registerTool).toHaveBeenCalledWith('plugin-hello.hello', expect.any(Function));
  });

  it('loads all plugins from configured directories', async () => {
    const scanDir = join(testRoot, 'scan');
    const pluginDir = join(scanDir, 'loadall-plugin');
    writeManifest(pluginDir, { name: 'loadall-plugin' });
    writePluginEntry(pluginDir, `export default { name: "loadall-plugin", activate() {} };`);
    vi.stubEnv('MEMELOOP_PLUGINS_DIR', scanDir);

    const loaded = await loadAllPlugins(createPluginAPI());

    expect(loaded.map((plugin) => plugin.manifest.name)).toEqual(['loadall-plugin']);
  });
});
