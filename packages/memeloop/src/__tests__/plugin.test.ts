import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPluginRegistrations,
  createPluginAPI,
  discoverPlugins,
  getLoadedPlugin,
  getPluginDirectories,
  getPluginRegistrations,
  isPluginLoaded,
  listPlugins,
  loadAllPlugins,
  loadPlugin,
  readPluginManifest,
  registerPluginHooks,
  registerPluginSkills,
  registerPluginTools,
  unloadAllPlugins,
  unloadPlugin,
} from "../plugin/index.js";

// ─── Test helpers ────────────────────────────────────────────────────

const TEST_TMP = resolve(process.cwd(), ".memeloop", "plugins", ".test-tmp");

function writeManifest(dir: string, overrides: Record<string, unknown> = {}) {
  const manifest = {
    name: "test-plugin",
    version: "0.1.0",
    description: "Unit test plugin",
    entry: "index.mjs",
    ...overrides,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memeloop-plugin.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

function writePluginEntry(dir: string, content: string, filename = "index.mjs") {
  writeFileSync(join(dir, filename), content);
}

function cleanTestDir() {
  try {
    rmSync(join(process.cwd(), ".memeloop", "plugins", ".test-tmp"), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

beforeEach(() => {
  vi.unstubAllEnvs();
  cleanTestDir();
  unloadAllPlugins();
  clearPluginRegistrations();
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanTestDir();
  unloadAllPlugins();
  clearPluginRegistrations();
});

// ─── Manifest Tests ──────────────────────────────────────────────────

describe("readPluginManifest", () => {
  it("reads a valid manifest", () => {
    const dir = join(TEST_TMP, "valid");
    writeManifest(dir);
    const result = readPluginManifest(dir);
    expect(result).toBeTruthy();
    expect(result!.name).toBe("test-plugin");
    expect(result!.version).toBe("0.1.0");
    expect(result!.entry).toBe("index.mjs");
  });

  it("returns null for missing manifest", () => {
    const dir = join(TEST_TMP, "no-manifest");
    mkdirSync(dir, { recursive: true });
    expect(readPluginManifest(dir)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const dir = join(TEST_TMP, "malformed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "memeloop-plugin.json"), "{invalid");
    expect(readPluginManifest(dir)).toBeNull();
  });

  it("returns null for empty name", () => {
    const dir = join(TEST_TMP, "no-name");
    writeManifest(dir, { name: "" });
    expect(readPluginManifest(dir)).toBeNull();
  });

  it("returns null for missing version", () => {
    const dir = join(TEST_TMP, "no-version");
    writeManifest(dir, { version: undefined });
    expect(readPluginManifest(dir)).toBeNull();
  });

  it("returns null for missing entry", () => {
    const dir = join(TEST_TMP, "no-entry");
    writeManifest(dir, { entry: "" });
    expect(readPluginManifest(dir)).toBeNull();
  });

  it("parses exports section", () => {
    const dir = join(TEST_TMP, "with-exports");
    writeManifest(dir, {
      exports: { tools: ["tool-a"], hooks: ["PreToolUse"], skills: ["skill-x"] },
    });
    const result = readPluginManifest(dir);
    expect(result!.exports).toEqual({
      tools: ["tool-a"],
      hooks: ["PreToolUse"],
      skills: ["skill-x"],
    });
  });

  it("handles author and minMemeloopVersion", () => {
    const dir = join(TEST_TMP, "with-meta");
    writeManifest(dir, { author: "Alice", minMemeloopVersion: "0.1.0" });
    const result = readPluginManifest(dir);
    expect(result!.author).toBe("Alice");
    expect(result!.minMemeloopVersion).toBe("0.1.0");
  });
});

// ─── Directory Resolution Tests ──────────────────────────────────────

describe("getPluginDirectories", () => {
  it("returns cwd and homedir plugin dirs", () => {
    const dirs = getPluginDirectories();
    expect(dirs.length).toBeGreaterThanOrEqual(2);
    expect(dirs).toContain(resolve(process.cwd(), ".memeloop", "plugins"));
    expect(dirs).toContain(resolve(homedir(), ".memeloop", "plugins"));
  });

  it("respects MEMELOOP_PLUGINS_DIR env var", () => {
    vi.stubEnv("MEMELOOP_PLUGINS_DIR", "/custom/plugins");
    const dirs = getPluginDirectories();
    expect(dirs[0]).toBe(resolve("/custom/plugins"));
  });

  it("accepts projectRoot parameter", () => {
    const dirs = getPluginDirectories("/some/project");
    expect(dirs).toContain(resolve("/some/project", ".memeloop", "plugins"));
  });
});

// ─── Discovery Tests ─────────────────────────────────────────────────

describe("discoverPlugins", () => {
  it("discovers plugin directories with manifests", () => {
    const base = join(TEST_TMP, "discovery-parent");
    const pluginA = join(base, "plugin-a");
    writeManifest(pluginA);

    const pluginB = join(base, "plugin-b");
    writeManifest(pluginB, { name: "plugin-b" });

    mkdirSync(join(base, "not-a-plugin"), { recursive: true });

    const discovered = discoverPlugins(base);
    expect(discovered.length).toBe(2);
    expect(discovered).toContain(pluginA);
    expect(discovered).toContain(pluginB);
  });

  it("returns empty for non-existent directory", () => {
    expect(discoverPlugins(join(TEST_TMP, "nonexistent"))).toEqual([]);
  });

  it("returns empty when no manifests present", () => {
    const base = join(TEST_TMP, "empty-dir");
    mkdirSync(base, { recursive: true });
    expect(discoverPlugins(base)).toEqual([]);
  });
});

// ─── Load / Unload Tests ─────────────────────────────────────────────

describe("loadPlugin", () => {
  it("loads a plugin and calls activate", async () => {
    const dir = join(TEST_TMP, "load-test");
    writeManifest(dir, { name: "loaded-plugin" });
    writePluginEntry(dir, `export default {
  name: "loaded-plugin",
  activate(api) {
    api.registerTool("loaded-plugin.test", () => "ok");
  }
};`);

    const api = createPluginAPI();
    const loaded = await loadPlugin(join(dir, "memeloop-plugin.json"), api);
    expect(loaded).toBeTruthy();
    expect(loaded!.manifest.name).toBe("loaded-plugin");
    expect(loaded!.module.name).toBe("loaded-plugin");
  });

  it("returns null when manifest is missing", async () => {
    expect(await loadPlugin(join(TEST_TMP, "nonexistent.json"))).toBeNull();
  });

  it("returns null when entry module does not exist", async () => {
    const dir = join(TEST_TMP, "load-no-entry");
    writeManifest(dir, { entry: "missing.mjs" });
    expect(await loadPlugin(join(dir, "memeloop-plugin.json"))).toBeNull();
  });

  it("returns null when module has no default export", async () => {
    const dir = join(TEST_TMP, "load-no-default");
    writeManifest(dir, { name: "no-default" });
    writePluginEntry(dir, `export const foo = 1;`);
    expect(await loadPlugin(join(dir, "memeloop-plugin.json"))).toBeNull();
  });

  it("returns null when default has no activate function", async () => {
    const dir = join(TEST_TMP, "load-no-activate");
    writeManifest(dir, { name: "no-activate" });
    writePluginEntry(dir, `export default { name: "no-activate" };`);
    expect(await loadPlugin(join(dir, "memeloop-plugin.json"))).toBeNull();
  });

  it("returns existing loaded plugin if already loaded", async () => {
    const dir = join(TEST_TMP, "dup-load");
    writeManifest(dir, { name: "dup-plugin" });
    writePluginEntry(dir, `export default { name: "dup-plugin", activate() {} };`);

    const api = createPluginAPI();
    const first = await loadPlugin(join(dir, "memeloop-plugin.json"), api);
    const second = await loadPlugin(join(dir, "memeloop-plugin.json"), api);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("handles cleanup function returned by activate", async () => {
    const dir = join(TEST_TMP, "cleanup-test");
    writeManifest(dir, { name: "cleanup-plugin" });
    writePluginEntry(dir, `export default {
  name: "cleanup-plugin",
  activate() { return () => { globalThis.__cleanupRan = true; }; }
};`);

    const loaded = await loadPlugin(join(dir, "memeloop-plugin.json"), createPluginAPI());
    expect(loaded).toBeTruthy();
    unloadPlugin("cleanup-plugin");
    expect(isPluginLoaded("cleanup-plugin")).toBe(false);
  });
});

describe("unloadPlugin", () => {
  it("removes plugin from loaded list", async () => {
    const dir = join(TEST_TMP, "unload-test");
    writeManifest(dir, { name: "unload-me" });
    writePluginEntry(dir, `export default { name: "unload-me", activate() {} };`);

    const api = createPluginAPI();
    await loadPlugin(join(dir, "memeloop-plugin.json"), api);
    expect(isPluginLoaded("unload-me")).toBe(true);

    expect(unloadPlugin("unload-me")).toBe(true);
    expect(isPluginLoaded("unload-me")).toBe(false);
  });

  it("returns false for unknown plugin", () => {
    expect(unloadPlugin("ghost-plugin")).toBe(false);
  });
});

describe("listPlugins / getLoadedPlugin / isPluginLoaded", () => {
  it("tracks loaded plugins", async () => {
    const dir = join(TEST_TMP, "list-test");
    writeManifest(dir, { name: "list-plugin" });
    writePluginEntry(dir, `export default { name: "list-plugin", activate() {} };`);

    const api = createPluginAPI();
    await loadPlugin(join(dir, "memeloop-plugin.json"), api);

    expect(isPluginLoaded("list-plugin")).toBe(true);
    expect(getLoadedPlugin("list-plugin")).toBeTruthy();
    expect(listPlugins()).toHaveLength(1);
    expect(listPlugins()[0].manifest.name).toBe("list-plugin");

    unloadPlugin("list-plugin");
    expect(isPluginLoaded("list-plugin")).toBe(false);
    expect(getLoadedPlugin("list-plugin")).toBeUndefined();
    expect(listPlugins()).toHaveLength(0);
  });
});

describe("unloadAllPlugins", () => {
  it("unloads all loaded plugins", async () => {
    for (const name of ["all-a", "all-b"]) {
      const dir = join(TEST_TMP, `all-${name}`);
      writeManifest(dir, { name });
      writePluginEntry(dir, `export default { name: "${name}", activate() {} };`);
      await loadPlugin(join(dir, "memeloop-plugin.json"), createPluginAPI());
    }

    expect(listPlugins()).toHaveLength(2);
    unloadAllPlugins();
    expect(listPlugins()).toHaveLength(0);
  });
});

// ─── loadAllPlugins Integration Tests ────────────────────────────────

describe("loadAllPlugins", () => {
  it("loads plugins from configured directories", async () => {
    const scanDir = join(TEST_TMP, "scan-dir");
    const pluginDir = join(scanDir, "loadall-plugin");
    writeManifest(pluginDir, { name: "loadall-plugin" });
    writePluginEntry(pluginDir, `export default { name: "loadall-plugin", activate() {} };`);

    vi.stubEnv("MEMELOOP_PLUGINS_DIR", scanDir);

    const loaded = await loadAllPlugins(createPluginAPI());
    expect(loaded.length).toBeGreaterThanOrEqual(1);
    expect(loaded.some((p) => p.manifest.name === "loadall-plugin")).toBe(true);
  });

  it("handles missing directories gracefully", async () => {
    vi.stubEnv("MEMELOOP_PLUGINS_DIR", "/nonexistent/path");

    const loaded = await loadAllPlugins(createPluginAPI());
    expect(loaded).toBeDefined();
  });

  it("respects projectRoot parameter", async () => {
    const projectBase = join(TEST_TMP, "fake-project");
    const projectPlugins = join(projectBase, ".memeloop", "plugins", "project-scoped");
    mkdirSync(projectPlugins, { recursive: true });
    writeFileSync(
      join(projectPlugins, "memeloop-plugin.json"),
      JSON.stringify({ name: "project-plugin", version: "1.0.0", entry: "index.mjs" }),
    );
    writeFileSync(
      join(projectPlugins, "index.mjs"),
      `export default { name: "project-plugin", activate() {} };`,
    );

    vi.stubEnv("MEMELOOP_PLUGINS_DIR", "/nonexistent");

    const loaded = await loadAllPlugins(createPluginAPI(), projectBase);
    const found = loaded.filter((p) => p.manifest.name === "project-plugin");
    expect(found.length).toBe(1);
  });
});

// ─── Plugin API Tests ────────────────────────────────────────────────

describe("createPluginAPI", () => {
  it("creates API with default console logger", () => {
    const api = createPluginAPI();
    expect(api.logger).toBeDefined();
    expect(typeof api.registerTool).toBe("function");
    expect(typeof api.registerHook).toBe("function");
    expect(typeof api.registerSkill).toBe("function");
  });

  it("registerTool adds to toolRegistry when provided", () => {
    const mockRegistry = { registerTool: vi.fn() };
    const api = createPluginAPI({ toolRegistry: mockRegistry });

    api.registerTool("test.tool", () => "hello");
    expect(mockRegistry.registerTool).toHaveBeenCalledWith("test.tool", expect.any(Function));
  });

  it("registerHook delegates to hook registry", () => {
    const api = createPluginAPI();
    expect(() =>
      api.registerHook("PreToolUse", async () => ({ allowed: true })),
    ).not.toThrow();
  });

  it("registerSkill delegates to skill registry", () => {
    const api = createPluginAPI();
    expect(() =>
      api.registerSkill({ id: "test-skill", name: "Test Skill", instructions: "Test instructions" }),
    ).not.toThrow();
  });

  it("accepts custom logger", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const api = createPluginAPI({ logger });
    api.logger.info("test");
    expect(logger.info).toHaveBeenCalledWith("test");
  });
});

// ─── Registration Tracking Tests ─────────────────────────────────────

describe("registerPluginTools/Hooks/Skills tracking", () => {
  it("tracks registered tools per plugin", () => {
    registerPluginTools("test-plugin", [["tool-1", () => "a"], ["tool-2", () => "b"]]);
    const reg = getPluginRegistrations("test-plugin");
    expect(reg).toBeTruthy();
    expect(reg!.tools).toEqual(["tool-1", "tool-2"]);
  });

  it("tracks registered hooks per plugin", () => {
    registerPluginHooks("test-plugin", [
      ["PreToolUse", async () => ({ allowed: true })],
      ["PostToolUse", async () => ({ allowed: true })],
    ]);
    const reg = getPluginRegistrations("test-plugin");
    expect(reg).toBeTruthy();
    expect(reg!.hooks.length).toBe(2);
  });

  it("tracks registered skills per plugin", () => {
    registerPluginSkills("test-plugin", [
      { id: "skill-a", name: "A", instructions: "do a" },
      { id: "skill-b", name: "B", instructions: "do b" },
    ]);
    const reg = getPluginRegistrations("test-plugin");
    expect(reg).toBeTruthy();
    expect(reg!.skills).toEqual(["skill-a", "skill-b"]);
  });

  it("accumulates registrations", () => {
    registerPluginTools("acc-plugin", [["t1", () => {}]]);
    registerPluginTools("acc-plugin", [["t2", () => {}]]);
    registerPluginSkills("acc-plugin", [{ id: "s1", name: "S1", instructions: "x" }]);

    const reg = getPluginRegistrations("acc-plugin");
    expect(reg!.tools).toEqual(["t1", "t2"]);
    expect(reg!.skills).toEqual(["s1"]);
  });

  it("clearPluginRegistrations clears all tracking", () => {
    registerPluginTools("clear-me", [["t", () => {}]]);
    expect(getPluginRegistrations("clear-me")).toBeTruthy();
    clearPluginRegistrations();
    expect(getPluginRegistrations("clear-me")).toBeUndefined();
  });
});

// ─── Example Plugin Integration Test ─────────────────────────────────

describe("Example plugin-hello integration", () => {
  it("loads and registers the hello tool", async () => {
    const exampleDir = resolve(__dirname, "../../examples/plugin-hello");
    const manifestPath = join(exampleDir, "memeloop-plugin.json");

    const manifest = readPluginManifest(exampleDir);
    expect(manifest).toBeTruthy();
    expect(manifest!.name).toBe("plugin-hello");
    expect(manifest!.exports?.tools).toContain("plugin-hello.hello");

    const mockRegistry = { registerTool: vi.fn() };
    const api = createPluginAPI({ toolRegistry: mockRegistry });

    const loaded = await loadPlugin(manifestPath, api);
    expect(loaded).toBeTruthy();
    expect(loaded!.manifest.name).toBe("plugin-hello");
    expect(mockRegistry.registerTool).toHaveBeenCalledWith("plugin-hello.hello", expect.any(Function));

    const impl = mockRegistry.registerTool.mock.calls.find((c: any) => c[0] === "plugin-hello.hello")[1];
    expect(impl({ name: "MemeLoop" })).toBe("Hello, MemeLoop! Welcome to memeloop plugin marketplace.");
    expect(impl({})).toBe("Hello, World! Welcome to memeloop plugin marketplace.");

    unloadPlugin("plugin-hello");
  });
});
