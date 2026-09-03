import { canonicalJsonString } from '../encoding/canonicalJson.js';
import type { AgentProfile, AgentProfileType } from './agentProfiles.js';
import { BUILTIN_AGENT_PROFILES } from './agentProfiles.js';
import { assertAgentModelConfig } from './types.js';

const PROFILE_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 8_192,
  maxStringCodeUnits: 65_536,
  maxStringBytes: 65_536,
  maxBytes: 262_144,
});
const PROFILE_KEYS = new Set([
  'id',
  'name',
  'type',
  'role',
  'prompt',
  'permissions',
  'modelConfig',
  'protocolDef',
]);
const ROLE_KEYS = new Set(['id', 'displayName', 'description', 'category']);
const PERMISSION_KEYS = new Set(['default', 'rules']);
const PERMISSION_RULE_KEYS = new Set(['pattern', 'action']);
const DEFINITION_KEYS = new Set([
  'id',
  'name',
  'description',
  'systemPrompt',
  'tools',
  'modelConfig',
  'promptSchema',
  'agentFrameworkConfig',
  'agentTools',
  'avatarUrl',
  'agentFrameworkID',
  'heartbeat',
  'version',
]);
const AGENT_TOOL_KEYS = new Set(['toolId', 'enabled', 'parameters', 'tags']);
const HEARTBEAT_KEYS = new Set([
  'enabled',
  'intervalSeconds',
  'message',
  'activeHoursStart',
  'activeHoursEnd',
]);
const ACTIONS = new Set(['allow', 'ask', 'deny']);
const textEncoder = new TextEncoder();
type PermissionAction = AgentProfile['permissions']['default'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new TypeError(`${field} has unknown fields`);
  }
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' || (!allowEmpty && value.trim().length === 0) ||
    textEncoder.encode(value).byteLength > 65_536
  ) throw new TypeError(`${field} must be a bounded${allowEmpty ? '' : ' non-empty'} string`);
  return value;
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 1_024) throw new TypeError(`${field} must be a bounded array`);
  for (const item of value) requireString(item, `${field} item`);
}

function assertAgentTools(value: unknown): void {
  if (!Array.isArray(value) || value.length > 1_024) throw new TypeError('agent tools must be a bounded array');
  for (const item of value) {
    if (!isRecord(item)) throw new TypeError('agent tool must be an object');
    assertOnlyKeys(item, AGENT_TOOL_KEYS, 'agent tool');
    requireString(item.toolId, 'agent toolId');
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
      throw new TypeError('agent tool enabled must be boolean');
    }
    if (item.parameters !== undefined && !isRecord(item.parameters)) {
      throw new TypeError('agent tool parameters must be an object');
    }
    if (item.tags !== undefined) assertStringArray(item.tags, 'agent tool tags');
  }
}

function assertHeartbeat(value: unknown): void {
  if (!isRecord(value)) throw new TypeError('agent heartbeat must be an object');
  assertOnlyKeys(value, HEARTBEAT_KEYS, 'agent heartbeat');
  if (typeof value.enabled !== 'boolean') throw new TypeError('agent heartbeat enabled must be boolean');
  if (
    typeof value.intervalSeconds !== 'number' || !Number.isSafeInteger(value.intervalSeconds) ||
    value.intervalSeconds <= 0 || value.intervalSeconds > 31_536_000
  ) throw new TypeError('agent heartbeat intervalSeconds is invalid');
  requireString(value.message, 'agent heartbeat message');
  if (value.activeHoursStart !== undefined) requireString(value.activeHoursStart, 'agent heartbeat activeHoursStart');
  if (value.activeHoursEnd !== undefined) requireString(value.activeHoursEnd, 'agent heartbeat activeHoursEnd');
}

function assertProtocolDefinition(value: unknown): void {
  if (!isRecord(value)) throw new TypeError('Agent profile must have a protocolDef object');
  assertOnlyKeys(value, DEFINITION_KEYS, 'Agent protocolDef');
  requireString(value.id, 'Agent protocolDef id');
  requireString(value.name, 'Agent protocolDef name');
  requireString(value.description, 'Agent protocolDef description', true);
  requireString(value.systemPrompt, 'Agent protocolDef systemPrompt', true);
  assertStringArray(value.tools, 'Agent protocolDef tools');
  requireString(value.version, 'Agent protocolDef version');
  if (value.modelConfig !== undefined) assertAgentModelConfig(value.modelConfig);
  if (value.agentTools !== undefined) assertAgentTools(value.agentTools);
  if (value.avatarUrl !== undefined) requireString(value.avatarUrl, 'Agent avatarUrl');
  if (value.agentFrameworkID !== undefined) requireString(value.agentFrameworkID, 'Agent framework ID');
  if (value.heartbeat !== undefined) assertHeartbeat(value.heartbeat);
  if (value.agentFrameworkConfig !== undefined) {
    const framework = value.agentFrameworkConfig;
    if (!isRecord(framework)) throw new TypeError('Agent framework config must be an object');
    assertOnlyKeys(framework, new Set(['prompts', 'response', 'plugins']), 'Agent framework config');
    if (!Array.isArray(framework.prompts) || !Array.isArray(framework.plugins)) {
      throw new TypeError('Agent framework config prompts/plugins must be arrays');
    }
    if (framework.response !== undefined && !Array.isArray(framework.response)) {
      throw new TypeError('Agent framework config response must be an array');
    }
  }
}

function isPermissionAction(value: unknown): value is PermissionAction {
  return typeof value === 'string' && ACTIONS.has(value);
}

/** Validate the complete profile shape before it crosses into the registry. */
function assertAgentProfile(value: unknown): asserts value is AgentProfile {
  if (!isRecord(value)) throw new TypeError('Agent profile must be an object');
  const normalized = value;
  assertOnlyKeys(normalized, PROFILE_KEYS, 'Agent profile');
  try {
    requireString(normalized.id, 'Agent profile id');
  } catch {
    throw new TypeError('Agent profile must have a non-empty id');
  }
  try {
    requireString(normalized.name, 'Agent profile name');
  } catch {
    throw new TypeError('Agent profile must have a name');
  }
  try {
    requireString(normalized.type, 'Agent profile type');
  } catch {
    throw new TypeError('Agent profile must have a type');
  }
  try {
    requireString(normalized.prompt, 'Agent profile prompt');
  } catch {
    throw new TypeError('Agent profile must have a prompt');
  }
  if (normalized.role !== undefined) {
    if (!isRecord(normalized.role)) throw new TypeError('Agent profile role must be an object');
    assertOnlyKeys(normalized.role, ROLE_KEYS, 'Agent profile role');
    requireString(normalized.role.id, 'Agent profile role id');
    requireString(normalized.role.displayName, 'Agent profile role displayName');
    if (normalized.role.description !== undefined) requireString(normalized.role.description, 'Agent profile role description', true);
    if (normalized.role.category !== undefined) requireString(normalized.role.category, 'Agent profile role category');
  }
  if (!isRecord(normalized.permissions)) throw new TypeError('Agent profile must have valid permissions');
  assertOnlyKeys(normalized.permissions, PERMISSION_KEYS, 'Agent profile permissions');
  if (!isPermissionAction(normalized.permissions.default)) {
    throw new TypeError('Agent profile permission default is invalid');
  }
  if (!Array.isArray(normalized.permissions.rules) || normalized.permissions.rules.length > 1_024) {
    throw new TypeError('Agent profile permission rules must be a bounded array');
  }
  for (const rule of normalized.permissions.rules) {
    if (!isRecord(rule)) throw new TypeError('Agent profile permission rule must be an object');
    assertOnlyKeys(rule, PERMISSION_RULE_KEYS, 'Agent profile permission rule');
    requireString(rule.pattern, 'Agent profile permission rule pattern');
    if (!isPermissionAction(rule.action)) throw new TypeError('Agent profile permission rule action is invalid');
  }
  if (normalized.modelConfig !== undefined) assertAgentModelConfig(normalized.modelConfig);
  assertProtocolDefinition(normalized.protocolDef);
}

function normalizeAgentProfile(value: unknown): AgentProfile {
  // Canonical encoding rejects cycles, accessors, sparse arrays, exotic
  // prototypes, symbols, unsupported values, and over-budget input before any
  // host-owned value is retained.
  const normalized: unknown = JSON.parse(canonicalJsonString(value, PROFILE_LIMITS));
  assertAgentProfile(normalized);
  return normalized;
}

function cloneProfile(profile: AgentProfile): AgentProfile {
  return structuredClone(profile);
}

/**
 * Registry for agent profiles used by task delegation.
 * Pre-seeded with built-in profiles (build, plan, explore, oracle, librarian).
 */
export class AgentProfileRegistry {
  private readonly profiles = new Map<string, AgentProfile>();
  private readonly registrations = new Map<string, Array<{ profile: AgentProfile; active: boolean; builtin: boolean }>>();

  constructor() {
    this.seedDefaults();
  }

  /** Seed the registry with built-in agent profiles. */
  private seedDefaults(): void {
    for (const profile of BUILTIN_AGENT_PROFILES) {
      const stored = normalizeAgentProfile(profile);
      this.profiles.set(stored.id, stored);
      this.registrations.set(stored.id, [{ profile: stored, active: true, builtin: true }]);
    }
  }

  /**
   * Register a new agent profile or override an existing one.
   * Throws if the profile is invalid.
   */
  registerAgentProfile(profile: AgentProfile): () => boolean {
    const stored = normalizeAgentProfile(profile);
    if (this.profiles.has(stored.id)) throw new Error(`Agent profile already registered: ${stored.id}`);
    const entries = this.registrations.get(stored.id) ?? [];
    const entry = { profile: stored, active: true, builtin: false };
    entries.push(entry);
    this.registrations.set(stored.id, entries);
    this.profiles.set(stored.id, stored);
    return () => this.cleanupOwnedProfile(stored.id, entry);
  }

  /** Trusted host replacement; builtins cannot be replaced through plugin registration. */
  replaceAgentProfile(profile: AgentProfile): () => boolean {
    const stored = normalizeAgentProfile(profile);
    const entries = this.registrations.get(stored.id) ?? [];
    const entry = { profile: stored, active: true, builtin: false };
    entries.push(entry);
    this.registrations.set(stored.id, entries);
    this.profiles.set(stored.id, stored);
    return () => this.cleanupOwnedProfile(stored.id, entry);
  }

  /**
   * Get an agent profile by ID.
   * Returns undefined if not found.
   */
  getAgentProfile(id: string): AgentProfile | undefined {
    const profile = this.profiles.get(id);
    return profile ? cloneProfile(profile) : undefined;
  }

  /**
   * List all registered agent profiles.
   */
  listAgentProfiles(): AgentProfile[] {
    return Array.from(this.profiles.values(), cloneProfile);
  }

  /**
   * List agent profiles filtered by type.
   */
  listAgentProfilesByType(type: AgentProfileType): AgentProfile[] {
    return this.listAgentProfiles().filter((profile) => profile.type === type);
  }

  /**
   * Remove an agent profile by ID.
   */
  unregisterAgentProfile(id: string): boolean {
    const entries = this.registrations.get(id);
    if (!entries || entries.some(entry => entry.builtin && entry.active)) return false;
    this.registrations.delete(id);
    return this.profiles.delete(id);
  }

  /**
   * Reset the registry to only built-in defaults.
   */
  reset(): void {
    this.profiles.clear();
    this.registrations.clear();
    this.seedDefaults();
  }

  private cleanupOwnedProfile(id: string, owned: { profile: AgentProfile; active: boolean; builtin: boolean }): boolean {
    if (!owned.active) return false;
    owned.active = false;
    const entries = this.registrations.get(id) ?? [];
    let next: typeof owned | undefined;
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index]?.active) {
        next = entries[index];
        break;
      }
    }
    if (next) this.profiles.set(id, next.profile);
    else this.profiles.delete(id);
    while (entries.at(-1)?.active === false) entries.pop();
    if (entries.length === 0) this.registrations.delete(id);
    return true;
  }
}
