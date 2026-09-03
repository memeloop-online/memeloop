/**
 * Agent loop registry.
 *
 * Discovers, registers, and resolves loop types, loop profiles, and loop plugins.
 * Core does NOT hard-import any loop implementation; all are registered by host or plugin.
 */

import { canonicalJsonString } from '../encoding/canonicalJson.js';
import type { AgentLoopDefinition, AgentLoopGenerator, AgentLoopInput, LoopPlugin, LoopProfile, LoopProfilePluginEntry } from './types.js';

export type LoopPluginSelection = string | LoopProfilePluginEntry;

interface LoopPluginInstall {
  plugin: LoopPlugin;
  dispose: () => void;
  active: boolean;
  scope: 'runtime' | 'profile';
  owner?: object;
  configFingerprint: string;
  leases: number;
}

const STRUCTURED_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 16_384,
  maxStringCodeUnits: 65_536,
  maxStringBytes: 65_536,
  maxBytes: 524_288,
});
const LOOP_KEYS = new Set(['id', 'name', 'description', 'createRunner']);
const PLUGIN_KEYS = new Set([
  'id',
  'targetLoopId',
  'schema',
  'activationScope',
  'providedToolIds',
  'install',
]);
const PROFILE_KEYS = new Set([
  'id',
  'name',
  'description',
  'loopId',
  'scriptReference',
  'systemPrompt',
  'tools',
  'agentTools',
  'agentFrameworkConfig',
  'prompts',
  'plugins',
  'hookPlugins',
  'modelConfig',
  'heartbeat',
  'agentFrameworkID',
  'avatarUrl',
  'permissions',
  'schema',
  'metadata',
  'version',
]);
const textEncoder = new TextEncoder();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function assertDataObject(value: unknown, allowed: ReadonlySet<string>, field: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${field} must be a plain object`);
  const properties = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(key => typeof key === 'symbol') ||
    Object.entries(properties).some(([key, descriptor]) =>
      !allowed.has(key) || descriptor.get !== undefined || descriptor.set !== undefined ||
      !descriptor.enumerable
    )
  ) throw new TypeError(`${field} has invalid fields`);
  return value;
}

function requireIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' || value.trim().length === 0 ||
    textEncoder.encode(value).byteLength > 1_024
  ) throw new TypeError(`${field} must be a bounded non-empty string`);
  return value;
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' || (!allowEmpty && value.length === 0) ||
    textEncoder.encode(value).byteLength > 65_536
  ) throw new TypeError(`${field} must be a bounded string`);
  return value;
}

function freezePlainData<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freezePlainData(child);
    Object.freeze(value);
  }
  return value;
}

function normalizePlainData(value: unknown): unknown {
  return freezePlainData(JSON.parse(canonicalJsonString(value, STRUCTURED_LIMITS)) as unknown);
}

function normalizeLoopDefinition(value: AgentLoopDefinition): AgentLoopDefinition {
  const definition = assertDataObject(value, LOOP_KEYS, 'Loop definition');
  const id = requireIdentifier(definition.id, 'Loop definition id');
  const name = requireString(definition.name, 'Loop definition name');
  const description = requireString(definition.description, 'Loop definition description', true);
  if (typeof definition.createRunner !== 'function') {
    throw new TypeError('Loop definition createRunner must be callable');
  }
  return Object.freeze({ id, name, description, createRunner: definition.createRunner }) as AgentLoopDefinition;
}

function normalizeLoopPlugin(value: LoopPlugin): LoopPlugin {
  const plugin = assertDataObject(value, PLUGIN_KEYS, 'Loop plugin');
  const id = requireIdentifier(plugin.id, 'Loop plugin id');
  const targetLoopId = plugin.targetLoopId === undefined
    ? undefined
    : requireIdentifier(plugin.targetLoopId, 'Loop plugin targetLoopId');
  if (
    plugin.activationScope !== undefined &&
    plugin.activationScope !== 'runtime' && plugin.activationScope !== 'profile'
  ) throw new TypeError('Loop plugin activationScope is invalid');
  if (plugin.install !== undefined && typeof plugin.install !== 'function') {
    throw new TypeError('Loop plugin install must be callable');
  }
  let providedToolIds: readonly string[] | undefined;
  if (plugin.providedToolIds !== undefined) {
    if (!Array.isArray(plugin.providedToolIds) || plugin.providedToolIds.length > 1_024) {
      throw new TypeError('Loop plugin providedToolIds must be a bounded array');
    }
    providedToolIds = Object.freeze(plugin.providedToolIds.map(toolId => requireIdentifier(toolId, 'Loop plugin provided tool id')));
    if (new Set(providedToolIds).size !== providedToolIds.length) {
      throw new TypeError('Loop plugin providedToolIds must be unique');
    }
  }
  const schema = plugin.schema === undefined
    ? undefined
    : normalizePlainData(plugin.schema) as Record<string, unknown>;
  return Object.freeze({
    id,
    ...(targetLoopId === undefined ? {} : { targetLoopId }),
    ...(schema === undefined ? {} : { schema }),
    ...(plugin.activationScope === undefined ? {} : { activationScope: plugin.activationScope }),
    ...(providedToolIds === undefined ? {} : { providedToolIds }),
    ...(plugin.install === undefined ? {} : { install: plugin.install as LoopPlugin['install'] }),
  }) as LoopPlugin;
}

function normalizeLoopProfile(value: LoopProfile): LoopProfile {
  const normalized = normalizePlainData(value);
  const profile = assertDataObject(normalized, PROFILE_KEYS, 'Loop profile');
  requireIdentifier(profile.id, 'Loop profile id');
  requireString(profile.name, 'Loop profile name');
  requireString(profile.description, 'Loop profile description', true);
  if (profile.loopId !== undefined) requireIdentifier(profile.loopId, 'Loop profile loopId');
  for (const field of ['tools'] as const) {
    const items = profile[field];
    if (items !== undefined) {
      if (!Array.isArray(items) || items.length > 1_024) throw new TypeError(`Loop profile ${field} must be a bounded array`);
      for (const item of items) requireIdentifier(item, `Loop profile ${field} item`);
    }
  }
  for (const field of ['plugins', 'hookPlugins'] as const) {
    const entries = profile[field];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.length > 1_024) {
      throw new TypeError(`Loop profile ${field} must be a bounded array`);
    }
    for (const entry of entries) {
      const item = assertDataObject(entry, new Set(['id', 'enabled', 'config']), `Loop profile ${field} entry`);
      requireIdentifier(item.id, `Loop profile ${field} id`);
      if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
        throw new TypeError(`Loop profile ${field} enabled must be boolean`);
      }
      if (item.config !== undefined && !isPlainRecord(item.config)) {
        throw new TypeError(`Loop profile ${field} config must be an object`);
      }
    }
  }
  return normalized as LoopProfile;
}

function normalizePluginConfig(config?: Record<string, unknown>): {
  config: Record<string, unknown> | undefined;
  fingerprint: string;
} {
  if (config === undefined) return { config: undefined, fingerprint: 'null' };
  const normalized = normalizePlainData(config);
  if (!isPlainRecord(normalized)) throw new TypeError('Loop plugin config must be a plain object');
  return { config: normalized, fingerprint: canonicalJsonString(normalized, STRUCTURED_LIMITS) };
}

export interface LoopRegistry {
  registerLoop(definition: AgentLoopDefinition): () => void;
  replaceLoop(definition: AgentLoopDefinition): () => void;
  getLoop(id: string): AgentLoopDefinition | undefined;
  listLoops(): AgentLoopDefinition[];
  registerProfile(profile: LoopProfile): () => void;
  replaceProfile(profile: LoopProfile): () => void;
  getProfile(id: string): LoopProfile | undefined;
  listProfiles(): LoopProfile[];
  registerPlugin(plugin: LoopPlugin): () => void;
  replacePlugin(plugin: LoopPlugin): () => void;
  getPlugin(id: string): LoopPlugin | undefined;
  listPlugins(): LoopPlugin[];
  installPluginsForLoop(
    loopId: string,
    target: { [key: string]: unknown },
    selected?: LoopPluginSelection[],
  ): () => void;
  installPluginsForProfile(profile: LoopProfile, target: { [key: string]: unknown }): () => void;
  createRunnerForProfile(
    profile: string | LoopProfile,
    context?: { [key: string]: unknown },
  ): ((input: AgentLoopInput) => AgentLoopGenerator) | null;
  createRunner(
    loopId: string,
    context?: { [key: string]: unknown },
  ): ((input: AgentLoopInput) => AgentLoopGenerator) | null;
  reset(): void;
}

function normalizePluginSelections(
  selected?: LoopPluginSelection[],
): Map<string, LoopProfilePluginEntry> | undefined {
  if (!selected) return undefined;

  const result = new Map<string, LoopProfilePluginEntry>();
  for (const entry of selected) {
    if (typeof entry === 'string') {
      result.set(entry, { id: entry, enabled: true });
      continue;
    }
    if (entry.enabled === false) continue;
    result.set(entry.id, entry);
  }
  return result;
}

// ─── Loop Registry ─────────────────────────────────────────────────────

export class LoopRegistryImpl implements LoopRegistry {
  private readonly loops = new Map<string, AgentLoopDefinition>();
  private readonly profiles = new Map<string, LoopProfile>();
  private readonly plugins = new Map<string, LoopPlugin>();
  private readonly loopRegistrations = new Map<string, Array<{ value: AgentLoopDefinition; active: boolean }>>();
  private readonly profileRegistrations = new Map<string, Array<{ value: LoopProfile; active: boolean }>>();
  private readonly pluginRegistrations = new Map<string, Array<{ value: LoopPlugin; active: boolean }>>();
  private readonly runtimeInstallsByOwner = new WeakMap<object, Map<string, LoopPluginInstall>>();
  private readonly runtimeInstalls = new Set<LoopPluginInstall>();
  private readonly profileInstalls = new Set<LoopPluginInstall>();

  // ── Loop registration ──

  registerLoop(definition: AgentLoopDefinition): () => void {
    const stored = normalizeLoopDefinition(definition);
    if (this.loops.has(stored.id)) {
      throw new Error(`Loop definition is already registered: ${stored.id}`);
    }
    return this.addRegistration(this.loops, this.loopRegistrations, stored.id, stored);
  }

  /** Trusted host-only override capability. Ordinary registration is collision-safe. */
  replaceLoop(definition: AgentLoopDefinition): () => void {
    const stored = normalizeLoopDefinition(definition);
    return this.addRegistration(this.loops, this.loopRegistrations, stored.id, stored);
  }

  getLoop(id: string): AgentLoopDefinition | undefined {
    return this.loops.get(id);
  }

  listLoops(): AgentLoopDefinition[] {
    return Array.from(this.loops.values());
  }

  // ── Profile registration ──

  registerProfile(profile: LoopProfile): () => void {
    const stored = normalizeLoopProfile(profile);
    if (this.profiles.has(stored.id)) {
      throw new Error(`Loop profile is already registered: ${stored.id}`);
    }
    return this.addRegistration(this.profiles, this.profileRegistrations, stored.id, stored);
  }

  /** Trusted host-only override capability. Ordinary registration is collision-safe. */
  replaceProfile(profile: LoopProfile): () => void {
    const stored = normalizeLoopProfile(profile);
    return this.addRegistration(this.profiles, this.profileRegistrations, stored.id, stored);
  }

  getProfile(id: string): LoopProfile | undefined {
    return this.profiles.get(id);
  }

  listProfiles(): LoopProfile[] {
    return Array.from(this.profiles.values());
  }

  // ── Plugin registration ──

  registerPlugin(plugin: LoopPlugin): () => void {
    const stored = normalizeLoopPlugin(plugin);
    if (this.plugins.has(stored.id)) {
      throw new Error(`Loop plugin is already registered: ${stored.id}`);
    }
    return this.addPluginRegistration(stored);
  }

  /** Trusted host-only override capability. Ordinary registration is collision-safe. */
  replacePlugin(plugin: LoopPlugin): () => void {
    const stored = normalizeLoopPlugin(plugin);
    const previous = this.plugins.get(stored.id);
    if (previous) this.disposeInstallsForPlugin(previous);
    return this.addPluginRegistration(stored);
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
  ): () => void {
    const selectedEntries = normalizePluginSelections(selected);
    const installed: Array<() => void> = [];

    try {
      for (const plugin of this.plugins.values()) {
        const entry = selectedEntries?.get(plugin.id);
        if (selectedEntries && !entry) continue;
        if (plugin.targetLoopId && plugin.targetLoopId !== '*' && plugin.targetLoopId !== loopId) {
          continue;
        }
        if (plugin.install) {
          if (plugin.activationScope === 'runtime') {
            installed.push(this.installRuntimePlugin(plugin, target, entry?.config));
          } else {
            installed.push(this.installProfilePlugin(plugin, target, entry?.config));
          }
        }
      }
    } catch (error) {
      this.disposeCallbacks(installed);
      throw error;
    }
    return this.onceDisposer(installed);
  }

  installPluginsForProfile(profile: LoopProfile, target: { [key: string]: unknown }): () => void {
    const storedProfile = normalizeLoopProfile(profile);
    const loopId = storedProfile.loopId ?? 'agent-tool-loop';
    const selectedEntries = normalizePluginSelections(storedProfile.plugins ?? []);
    const installed: Array<() => void> = [];
    try {
      for (const plugin of this.plugins.values()) {
        const entry = selectedEntries?.get(plugin.id);
        if (!entry || plugin.activationScope === 'runtime') continue;
        if (plugin.targetLoopId && plugin.targetLoopId !== '*' && plugin.targetLoopId !== loopId) {
          continue;
        }
        if (plugin.install) installed.push(this.installProfilePlugin(plugin, target, entry.config));
      }
    } catch (error) {
      this.disposeCallbacks(installed);
      throw error;
    }
    return this.onceDisposer(installed);
  }

  createRunnerForProfile(
    profile: string | LoopProfile,
    context: { [key: string]: unknown } = {},
  ): ((input: AgentLoopInput) => AgentLoopGenerator) | null {
    const storedProfile = typeof profile === 'string'
      ? this.profiles.get(profile)
      : normalizeLoopProfile(profile);
    if (!storedProfile) return null;
    const loopId = storedProfile.loopId ?? 'agent-tool-loop';
    const definition = this.loops.get(loopId);
    if (!definition) return null;
    const installProfilePlugins = this.installPluginsForProfile.bind(this);
    const assertProfileToolCapabilities = this.assertProfileToolCapabilities.bind(this);
    const scopeContextForProfile = this.scopeContextForProfile.bind(this);
    return async function* profileRunner(input: AgentLoopInput): AgentLoopGenerator {
      const dispose = installProfilePlugins(storedProfile, context);
      try {
        assertProfileToolCapabilities(storedProfile, context);
        const scopedContext = {
          ...scopeContextForProfile(storedProfile, context),
          profile: storedProfile,
        };
        const runner = definition.createRunner(scopedContext);
        yield* runner(input);
      } finally {
        dispose();
      }
    };
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
    const errors: unknown[] = [];
    for (const install of [...this.profileInstalls, ...this.runtimeInstalls].reverse()) {
      try {
        this.disposeInstall(install);
      } catch (error) {
        errors.push(error);
      }
    }
    for (
      const registrations of [
        this.loopRegistrations,
        this.profileRegistrations,
        this.pluginRegistrations,
      ]
    ) {
      for (const entries of registrations.values()) {
        for (const entry of entries) entry.active = false;
      }
    }
    this.loops.clear();
    this.profiles.clear();
    this.plugins.clear();
    this.loopRegistrations.clear();
    this.profileRegistrations.clear();
    this.pluginRegistrations.clear();
    if (errors.length > 0) throw new AggregateError(errors, 'Loop plugin cleanup failed');
  }

  private installRuntimePlugin(
    plugin: LoopPlugin,
    target: { [key: string]: unknown },
    config?: Record<string, unknown>,
  ): () => void {
    const candidate = target.toolRegistry ?? target.tools ?? target;
    const owner = candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function')
      ? candidate
      : target;
    const installs = this.runtimeInstallsByOwner.get(owner) ?? new Map<string, LoopPluginInstall>();
    const existing = installs.get(plugin.id);
    const normalized = normalizePluginConfig(config);
    const configFingerprint = normalized.fingerprint;
    if (existing?.plugin === plugin && existing.active) {
      if (existing.configFingerprint !== configFingerprint) {
        throw new Error(`Loop plugin configuration conflict: ${plugin.id}`);
      }
      existing.leases += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.releaseInstall(existing);
      };
    }
    if (existing) this.disposeInstall(existing);
    const cleanup = this.invokePluginInstall(plugin, target, normalized.config);
    const install: LoopPluginInstall = {
      owner,
      plugin,
      dispose: cleanup,
      active: true,
      scope: 'runtime',
      configFingerprint,
      leases: 1,
    };
    installs.set(plugin.id, install);
    this.runtimeInstallsByOwner.set(owner, installs);
    this.runtimeInstalls.add(install);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseInstall(install);
    };
  }

  private installProfilePlugin(
    plugin: LoopPlugin,
    target: { [key: string]: unknown },
    config?: Record<string, unknown>,
  ): () => void {
    const normalized = normalizePluginConfig(config);
    const install: LoopPluginInstall = {
      plugin,
      dispose: this.invokePluginInstall(plugin, target, normalized.config),
      active: true,
      scope: 'profile',
      configFingerprint: normalized.fingerprint,
      leases: 1,
    };
    this.profileInstalls.add(install);
    return () => {
      this.disposeInstall(install);
    };
  }

  private invokePluginInstall(
    plugin: LoopPlugin,
    target: { [key: string]: unknown },
    config?: Record<string, unknown>,
  ): () => void {
    const cleanup = plugin.install?.(target, config);
    if (cleanup !== undefined && typeof cleanup !== 'function') {
      throw new TypeError(`Loop plugin returned an invalid disposer: ${plugin.id}`);
    }
    return cleanup ?? (() => undefined);
  }

  private disposeInstall(install: LoopPluginInstall): void {
    if (!install.active) return;
    install.active = false;
    if (install.scope === 'runtime') {
      this.runtimeInstalls.delete(install);
      if (install.owner) {
        const installs = this.runtimeInstallsByOwner.get(install.owner);
        if (installs?.get(install.plugin.id) === install) installs.delete(install.plugin.id);
      }
    } else {
      this.profileInstalls.delete(install);
    }
    install.dispose();
  }

  private releaseInstall(install: LoopPluginInstall): void {
    if (!install.active || install.leases <= 0) return;
    install.leases -= 1;
    if (install.leases === 0) this.disposeInstall(install);
  }

  private disposeInstallsForPlugin(plugin: LoopPlugin): void {
    const errors: unknown[] = [];
    for (const install of [...this.profileInstalls, ...this.runtimeInstalls].reverse()) {
      if (install.plugin !== plugin) continue;
      try {
        this.disposeInstall(install);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `Loop plugin cleanup failed: ${plugin.id}`);
  }

  private addPluginRegistration(plugin: LoopPlugin): () => void {
    const unregister = this.addRegistration(
      this.plugins,
      this.pluginRegistrations,
      plugin.id,
      plugin,
    );
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      try {
        this.disposeInstallsForPlugin(plugin);
      } finally {
        unregister();
      }
    };
  }

  private onceDisposer(callbacks: Array<() => void>): () => void {
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.disposeCallbacks(callbacks);
    };
  }

  private disposeCallbacks(callbacks: Array<() => void>): void {
    const errors: unknown[] = [];
    for (const callback of [...callbacks].reverse()) {
      try {
        callback();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Loop plugin cleanup failed');
  }

  private scopeContextForProfile(
    profile: LoopProfile,
    context: { [key: string]: unknown },
  ): { [key: string]: unknown } {
    const allowed = this.profileToolIds(profile);

    const cache = new Map<object, object>();
    const scope = (candidate: unknown): unknown => {
      if (candidate === null || typeof candidate !== 'object') return candidate;
      const cached = cache.get(candidate);
      if (cached) return cached;
      const getTool = this.findDataMethod(candidate, 'getTool');
      const listTools = this.findDataMethod(candidate, 'listTools');
      let scoped: object;
      if (getTool && listTools) {
        const hasTool = this.findDataMethod(candidate, 'hasTool');
        const getSchema = this.findDataMethod(candidate, 'getToolParameterSchema');
        const getMetadata = this.findDataMethod(candidate, 'getToolMetadata');
        const getEffect = this.findDataMethod(candidate, 'getToolEffect');
        scoped = Object.freeze({
          getTool: (id: string): unknown => allowed.has(id) ? getTool.call(candidate, id) : undefined,
          listTools: (): string[] => {
            const listed = listTools.call(candidate);
            return Array.isArray(listed)
              ? listed.filter((id): id is string => typeof id === 'string' && allowed.has(id))
              : [];
          },
          hasTool: (id: string): boolean =>
            allowed.has(id) && (
              hasTool ? hasTool.call(candidate, id) === true : getTool.call(candidate, id) !== undefined
            ),
          getToolParameterSchema: (id: string): unknown => allowed.has(id) ? getSchema?.call(candidate, id) : undefined,
          getToolMetadata: (id: string): unknown => allowed.has(id) ? getMetadata?.call(candidate, id) : undefined,
          getToolEffect: (id: string): unknown => allowed.has(id) ? getEffect?.call(candidate, id) : undefined,
        });
      } else {
        const map = Object.create(null) as Record<string, unknown>;
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        for (const id of allowed) {
          const descriptor = descriptors[id];
          if (descriptor && descriptor.get === undefined && descriptor.set === undefined && descriptor.enumerable) {
            map[id] = descriptor.value;
          }
        }
        scoped = Object.freeze(map);
      }
      cache.set(candidate, scoped);
      return scoped;
    };

    return {
      ...context,
      ...(context.tools === undefined ? {} : { tools: scope(context.tools) }),
      ...(context.toolRegistry === undefined ? {} : { toolRegistry: scope(context.toolRegistry) }),
    };
  }

  private profileToolIds(profile: LoopProfile): Set<string> {
    const allowed = new Set<string>(profile.tools ?? []);
    for (const tool of profile.agentTools ?? []) {
      if (tool.enabled !== false) allowed.add(tool.toolId);
    }
    const selected = normalizePluginSelections(profile.plugins ?? []);
    for (const pluginId of selected?.keys() ?? []) {
      for (const toolId of this.plugins.get(pluginId)?.providedToolIds ?? []) allowed.add(toolId);
    }
    return allowed;
  }

  private assertProfileToolCapabilities(
    profile: LoopProfile,
    context: { [key: string]: unknown },
  ): void {
    const required = this.profileToolIds(profile);
    if (required.size === 0) return;
    const candidate = context.toolRegistry ?? context.tools;
    if (candidate === null || typeof candidate !== 'object') {
      throw new Error(`Loop profile tools are unavailable: ${[...required].join(', ')}`);
    }
    const hasTool = this.findDataMethod(candidate, 'hasTool');
    const listTools = this.findDataMethod(candidate, 'listTools');
    const listed = listTools?.call(candidate);
    const listedSet = Array.isArray(listed)
      ? new Set(listed.filter((id): id is string => typeof id === 'string'))
      : undefined;
    const descriptors = hasTool || listedSet ? undefined : Object.getOwnPropertyDescriptors(candidate);
    const missing = [...required].filter(id =>
      hasTool ? hasTool.call(candidate, id) !== true : listedSet
        ? !listedSet.has(id)
        : descriptors?.[id]?.value === undefined
    );
    if (missing.length > 0) {
      throw new Error(`Loop profile tools are unavailable: ${missing.join(', ')}`);
    }
  }

  private findDataMethod(
    candidate: object,
    property: string,
  ): ((...arguments_: unknown[]) => unknown) | undefined {
    let current: object | null = candidate;
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, property);
      if (descriptor) {
        return typeof descriptor.value === 'function'
          ? descriptor.value as (...arguments_: unknown[]) => unknown
          : undefined;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    return undefined;
  }

  private addRegistration<T>(
    current: Map<string, T>,
    registrations: Map<string, Array<{ value: T; active: boolean }>>,
    id: string,
    value: T,
  ): () => void {
    const entries = registrations.get(id) ?? [];
    const entry = { value, active: true };
    entries.push(entry);
    registrations.set(id, entries);
    current.set(id, value);
    let cleaned = false;
    return () => {
      if (cleaned || !entry.active) {
        cleaned = true;
        return;
      }
      cleaned = true;
      entry.active = false;
      let next: { value: T; active: boolean } | undefined;
      for (let index = entries.length - 1; index >= 0; index--) {
        if (entries[index]?.active) {
          next = entries[index];
          break;
        }
      }
      if (next) current.set(id, next.value);
      else current.delete(id);
      while (entries.length > 0 && entries.at(-1)?.active === false) entries.pop();
      if (entries.length === 0) registrations.delete(id);
    };
  }
}
