import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PluginLoader } from 'memeloop';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverPlugins, getPluginDirectories, loadAllPlugins, loadPlugin, pluginEntryImportSpecifier, readPluginManifest } from '../filePluginLoader.js';

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
  let loader: PluginLoader;

  beforeEach(() => {
    vi.unstubAllEnvs();
    testRoot = resolve(tmpdir(), `memeloop-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testRoot, { recursive: true });
    loader = new PluginLoader();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await loader.unloadAllPlugins();
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
    writeManifest(pluginDir, {
      name: 'plugin-hello',
      exports: { tools: ['plugin-hello.hello'] },
    });
    writePluginEntry(
      pluginDir,
      `export default {
  name: "plugin-hello",
  activate(api) {
    api.registerTool("plugin-hello.hello", () => "hello");
  }
};`,
    );
    const mockRegistry = {
      registerTool: vi.fn(),
      registerOwnedTool: vi.fn(() => () => true),
      hasTool: vi.fn(() => false),
      unregisterTool: vi.fn(() => true),
    };
    const onError = vi.fn();
    expect(readPluginManifest(pluginDir)).not.toBeNull();
    const loaded = await loadPlugin(join(pluginDir, 'memeloop-plugin.json'), {
      loader,
      toolRegistry: mockRegistry,
      onError,
    });

    expect(onError).not.toHaveBeenCalled();
    expect(loaded?.manifest.name).toBe('plugin-hello');
    expect(loaded?.source).toBe(resolve(pluginDir, 'index.mjs'));
    expect(mockRegistry.registerOwnedTool).toHaveBeenCalledWith(
      'plugin-hello.hello',
      expect.any(Function),
      undefined,
    );
  });

  it('loads all plugins from configured directories', async () => {
    const scanDir = join(testRoot, 'scan');
    const pluginDir = join(scanDir, 'loadall-plugin');
    writeManifest(pluginDir, { name: 'loadall-plugin' });
    writePluginEntry(pluginDir, `export default { name: "loadall-plugin", activate() {} };`);
    vi.stubEnv('MEMELOOP_PLUGINS_DIR', scanDir);

    const loaded = await loadAllPlugins({ loader, allowedPluginPaths: [pluginDir] });

    expect(loaded.map((plugin) => plugin.manifest.name)).toEqual(['loadall-plugin']);
  });

  it('converts plugin entry paths to portable file URLs', () => {
    const entryPath = join(testRoot, 'plugins', 'portable # plugin', 'index.mjs');

    expect(pluginEntryImportSpecifier(entryPath)).toMatch(/^file:\/\//);
    expect(pluginEntryImportSpecifier(entryPath)).toContain('portable%20%23%20plugin');
  });

  it('deduplicates overlapping environment and project plugin roots', async () => {
    const scanDir = join(testRoot, '.memeloop', 'plugins');
    const pluginDir = join(scanDir, 'deduplicated');
    writeManifest(pluginDir, { name: 'deduplicated-plugin' });
    writePluginEntry(pluginDir, `export default { name: "deduplicated-plugin", activate() {} };`);
    vi.stubEnv('MEMELOOP_PLUGINS_DIR', scanDir);

    const loaded = await loadAllPlugins({ loader, allowedPluginPaths: [pluginDir] }, testRoot);

    expect(loaded.map(plugin => plugin.manifest.name)).toEqual(['deduplicated-plugin']);
  });

  it('enforces an exact canonical plugin-directory allowlist', async () => {
    const scanDir = join(testRoot, 'policy-scan');
    const allowedDir = join(scanDir, 'allowed');
    const deniedDir = join(scanDir, 'denied');
    writeManifest(allowedDir, { name: 'allowed-plugin' });
    writePluginEntry(allowedDir, `export default { name: "allowed-plugin", activate() {} };`);
    writeManifest(deniedDir, { name: 'denied-plugin' });
    writePluginEntry(deniedDir, `export default { name: "denied-plugin", activate() {} };`);
    vi.stubEnv('MEMELOOP_PLUGINS_DIR', scanDir);

    const loaded = await loadAllPlugins({ loader, allowedPluginPaths: [allowedDir] }, testRoot);

    expect(loaded.map(plugin => plugin.manifest.name)).toEqual(['allowed-plugin']);
  });

  it('does not import an untrusted project plugin without an explicit allowlist', async () => {
    const pluginDir = join(testRoot, '.memeloop', 'plugins', 'untrusted');
    writeManifest(pluginDir, { name: 'untrusted-plugin' });
    writePluginEntry(
      pluginDir,
      `globalThis.__memeloopUntrustedPluginExecuted = true;
export default { name: "untrusted-plugin", activate() {} };`,
    );
    delete (globalThis as { __memeloopUntrustedPluginExecuted?: boolean })
      .__memeloopUntrustedPluginExecuted;

    const loaded = await loadAllPlugins({ loader }, testRoot);

    expect(loaded).toEqual([]);
    expect(
      (globalThis as { __memeloopUntrustedPluginExecuted?: boolean })
        .__memeloopUntrustedPluginExecuted,
    ).toBeUndefined();
  });

  it('rejects oversized manifests and control-character entries', () => {
    const oversized = join(testRoot, 'plugins', 'oversized');
    writeManifest(oversized, { description: 'x'.repeat(70 * 1024) });
    expect(readPluginManifest(oversized)).toBeNull();

    const controlled = join(testRoot, 'plugins', 'controlled');
    writeManifest(controlled, { entry: 'index\n.mjs' });
    expect(readPluginManifest(controlled)).toBeNull();
  });
});
