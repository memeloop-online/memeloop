/**
 * Agent loop registry.
 *
 * Discovers, registers, and resolves loop types, loop profiles, and loop plugins.
 * Core does NOT hard-import any loop implementation; all are registered by host or plugin.
 */

import type {
  AgentLoopDefinition,
  AgentLoopGenerator,
  AgentLoopInput,
  LoopPlugin,
  LoopProfile,
  LoopProfilePluginEntry,
} from "./types.js";

type LoopPluginSelection = string | LoopProfilePluginEntry;

function normalizePluginSelections(
  selected?: LoopPluginSelection[],
): Map<string, LoopProfilePluginEntry> | undefined {
  if (!selected) return undefined;

  const result = new Map<string, LoopProfilePluginEntry>();
  for (const entry of selected) {
    if (typeof entry === "string") {
      result.set(entry, { id: entry, enabled: true });
      continue;
    }
    if (entry.enabled === false) continue;
    result.set(entry.id, entry);
  }
  return result;
}

// ─── Loop Registry ─────────────────────────────────────────────────────

class LoopRegistryImpl {
  private readonly loops = new Map<string, AgentLoopDefinition>();
  private readonly profiles = new Map<string, LoopProfile>();
  private readonly plugins = new Map<string, LoopPlugin>();

  // ── Loop registration ──

  registerLoop(definition: AgentLoopDefinition): void {
    if (!definition.id) throw new Error("Loop definition must have an id");
    this.loops.set(definition.id, definition);
  }

  getLoop(id: string): AgentLoopDefinition | undefined {
    return this.loops.get(id);
  }

  listLoops(): AgentLoopDefinition[] {
    return Array.from(this.loops.values());
  }

  // ── Profile registration ──

  registerProfile(profile: LoopProfile): void {
    if (!profile.id) throw new Error("Loop profile must have an id");
    this.profiles.set(profile.id, profile);
  }

  getProfile(id: string): LoopProfile | undefined {
    return this.profiles.get(id);
  }

  listProfiles(): LoopProfile[] {
    return Array.from(this.profiles.values());
  }

  // ── Plugin registration ──

  registerPlugin(plugin: LoopPlugin): void {
    if (!plugin.id) throw new Error("Loop plugin must have an id");
    this.plugins.set(plugin.id, plugin);
  }

  getPlugin(id: string): LoopPlugin | undefined {
    return this.plugins.get(id);
  }

  listPlugins(): LoopPlugin[] {
    return Array.from(this.plugins.values());
  }

  installPluginsForLoop(
    loopId: string,
    target: { [key: string]: unknown },
    selected?: LoopPluginSelection[],
  ): void {
    const selectedEntries = normalizePluginSelections(selected);

    for (const plugin of this.plugins.values()) {
      const entry = selectedEntries?.get(plugin.id);
      if (selectedEntries && !entry) continue;
      if (plugin.targetLoopId && plugin.targetLoopId !== "*" && plugin.targetLoopId !== loopId)
        continue;
      if (plugin.install) {
        plugin.install(target, entry?.config);
      }
    }
  }

  installPluginsForProfile(profile: LoopProfile, target: { [key: string]: unknown }): void {
    this.installPluginsForLoop(profile.loopId ?? "llm-io", target, profile.plugins ?? []);
  }

  // ── Lifecycle ──

  createRunner(
    loopId: string,
    context: { [key: string]: unknown } = {},
  ): ((input: AgentLoopInput) => AgentLoopGenerator) | null {
    const definition = this.loops.get(loopId);
    if (!definition) return null;
    return definition.createRunner(context);
  }

  reset(): void {
    this.loops.clear();
    this.profiles.clear();
    this.plugins.clear();
  }
}

// ─── Global singleton ─────────────────────────────────────────────────

let defaultRegistry: LoopRegistryImpl | null = null;

export function getLoopRegistry(): LoopRegistryImpl {
  if (!defaultRegistry) {
    defaultRegistry = new LoopRegistryImpl();
  }
  return defaultRegistry;
}

export function resetLoopRegistry(): void {
  if (defaultRegistry) {
    defaultRegistry.reset();
  }
  defaultRegistry = null;
}

export type { LoopRegistryImpl };
