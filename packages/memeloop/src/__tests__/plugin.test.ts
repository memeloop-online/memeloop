import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPluginRegistrations,
  createPluginAPI,
  getLoadedPlugin,
  getPluginRegistrations,
  isPluginLoaded,
  listPlugins,
  loadPluginModule,
  loadPluginModules,
  registerPluginHooks,
  registerPluginTools,
  unloadAllPlugins,
  unloadPlugin,
  validatePluginManifest,
} from "../plugin/index.js";
import type { PluginManifest, PluginModule } from "../plugin/index.js";

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "test-plugin",
    version: "0.1.0",
    description: "Unit test plugin",
    ...overrides,
  };
}

function module(overrides: Partial<PluginModule> = {}): PluginModule {
  return {
    name: "test-plugin",
    activate: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  unloadAllPlugins();
  clearPluginRegistrations();
});

afterEach(() => {
  unloadAllPlugins();
  clearPluginRegistrations();
});

describe("validatePluginManifest", () => {
  it("accepts a valid manifest and normalizes optional fields", () => {
    expect(
      validatePluginManifest({
        name: " plugin-a ",
        version: " 1.0.0 ",
        description: "desc",
        author: "Alice",
        minMemeloopVersion: "0.1.0",
        exports: {
          tools: ["tool-a", 1],
          hooks: ["PreToolUse", "ContextCompaction", "Nope"],
        },
      }),
    ).toEqual({
      name: "plugin-a",
      version: "1.0.0",
      description: "desc",
      author: "Alice",
      minMemeloopVersion: "0.1.0",
      exports: {
        tools: ["tool-a"],
        hooks: ["PreToolUse", "ContextCompaction"],
      },
    });
  });

  it("rejects invalid required fields", () => {
    expect(validatePluginManifest(null)).toBeNull();
    expect(validatePluginManifest({ name: "", version: "1" })).toBeNull();
    expect(validatePluginManifest({ name: "x", version: "" })).toBeNull();
  });
});

describe("loadPluginModule", () => {
  it("loads a plugin and calls activate", async () => {
    const activate = vi.fn((api: unknown) => {
      (api as { registerTool(id: string, impl: () => string): void }).registerTool(
        "test.tool",
        () => "ok",
      );
    });
    const mockRegistry = { registerTool: vi.fn() };
    const loaded = await loadPluginModule({
      manifest: manifest({ name: "loaded-plugin" }),
      module: module({ name: "loaded-plugin", activate }),
      api: createPluginAPI({ toolRegistry: mockRegistry }),
      source: "memory:test",
    });

    expect(loaded?.manifest.name).toBe("loaded-plugin");
    expect(loaded?.source).toBe("memory:test");
    expect(activate).toHaveBeenCalled();
    expect(mockRegistry.registerTool).toHaveBeenCalledWith("test.tool", expect.any(Function));
  });

  it("returns existing loaded plugin if already loaded", async () => {
    const first = await loadPluginModule({
      manifest: manifest({ name: "dup-plugin" }),
      module: module({ name: "dup-plugin" }),
    });
    const second = await loadPluginModule({
      manifest: manifest({ name: "dup-plugin" }),
      module: module({ name: "dup-plugin" }),
    });
    expect(second).toBe(first);
  });

  it("returns null for invalid manifests or modules", async () => {
    expect(
      await loadPluginModule({ manifest: manifest({ name: "" }), module: module() }),
    ).toBeNull();
    expect(
      await loadPluginModule({
        manifest: manifest(),
        module: { name: "bad", activate: undefined as never },
      }),
    ).toBeNull();
  });

  it("loads multiple plugin modules", async () => {
    const loaded = await loadPluginModules([
      { manifest: manifest({ name: "a" }), module: module({ name: "a" }) },
      { manifest: manifest({ name: "b" }), module: module({ name: "b" }) },
    ]);
    expect(loaded.map((plugin) => plugin.manifest.name)).toEqual(["a", "b"]);
  });
});

describe("plugin lifecycle", () => {
  it("tracks loaded plugins and unloads cleanup handlers", async () => {
    const cleanup = vi.fn();
    await loadPluginModule({
      manifest: manifest({ name: "cleanup-plugin" }),
      module: module({ name: "cleanup-plugin", activate: vi.fn(() => cleanup) }),
    });

    expect(isPluginLoaded("cleanup-plugin")).toBe(true);
    expect(getLoadedPlugin("cleanup-plugin")).toBeDefined();
    expect(listPlugins()).toHaveLength(1);
    expect(unloadPlugin("cleanup-plugin")).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(isPluginLoaded("cleanup-plugin")).toBe(false);
  });

  it("returns false for unknown plugins and clears all plugins", async () => {
    await loadPluginModules([
      { manifest: manifest({ name: "a" }), module: module({ name: "a" }) },
      { manifest: manifest({ name: "b" }), module: module({ name: "b" }) },
    ]);
    expect(unloadPlugin("missing")).toBe(false);
    unloadAllPlugins();
    expect(listPlugins()).toEqual([]);
  });
});

describe("createPluginAPI", () => {
  it("registerTool adds to toolRegistry when provided", () => {
    const mockRegistry = { registerTool: vi.fn() };
    const api = createPluginAPI({ toolRegistry: mockRegistry });

    api.registerTool("test.tool", () => "hello");
    expect(mockRegistry.registerTool).toHaveBeenCalledWith("test.tool", expect.any(Function));
  });

  it("accepts custom logger", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const api = createPluginAPI({ logger });
    api.logger.info("test");
    expect(logger.info).toHaveBeenCalledWith("test");
  });
});

describe("registerPluginTools/Hooks tracking", () => {
  it("tracks registered tools per plugin", () => {
    registerPluginTools("test-plugin", [
      ["tool-1", () => "a"],
      ["tool-2", () => "b"],
    ]);
    expect(getPluginRegistrations("test-plugin")?.tools).toEqual(["tool-1", "tool-2"]);
  });

  it("tracks registered hooks per plugin", () => {
    registerPluginHooks("test-plugin", [
      ["PreToolUse", async () => ({ allowed: true })],
      ["PostToolUse", async () => ({ allowed: true })],
    ]);
    expect(getPluginRegistrations("test-plugin")?.hooks).toHaveLength(2);
  });

  it("clears all tracking", () => {
    clearPluginRegistrations();
    expect(getPluginRegistrations("test-plugin")).toBeUndefined();
  });
});
