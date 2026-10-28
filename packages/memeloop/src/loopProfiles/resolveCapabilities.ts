import { canonicalJsonString } from '../encoding/canonicalJson.js';
import type { LoopRegistry } from '../loopAPI/registry.js';
import type { LoopProfile } from '../loopAPI/types.js';
import type { IToolRegistry } from '../types.js';

export const LOOP_PROFILE_NOT_FOUND = 'LOOP_PROFILE_NOT_FOUND' as const;
export const LOOP_PROFILE_TOOL_CAPABILITY_MISSING = 'LOOP_PROFILE_TOOL_CAPABILITY_MISSING' as const;

export class LoopProfileNotFoundError extends Error {
  readonly code = LOOP_PROFILE_NOT_FOUND;

  constructor(readonly profileId: string) {
    super(`Loop profile is not registered: ${profileId}`);
    this.name = 'LoopProfileNotFoundError';
  }
}

export class MissingLoopProfileToolCapabilityError extends Error {
  readonly code = LOOP_PROFILE_TOOL_CAPABILITY_MISSING;
  readonly missingToolIds: readonly string[];

  constructor(
    readonly profileId: string,
    missingToolIds: readonly string[],
  ) {
    const immutableMissingToolIds = Object.freeze([...missingToolIds]);
    super(
      `Loop profile ${profileId} requires unavailable tools: ${immutableMissingToolIds.join(', ')}`,
    );
    this.name = 'MissingLoopProfileToolCapabilityError';
    this.missingToolIds = immutableMissingToolIds;
  }
}

export interface ResolveLoopProfileCapabilitiesOptions {
  profileId: string;
  loopRegistry: Pick<LoopRegistry, 'getProfile'>;
  toolRegistry: Pick<IToolRegistry, 'hasTool' | 'listTools'>;
}

const LOOP_PROFILE_SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 16_384,
  maxStringCodeUnits: 65_536,
  maxStringBytes: 65_536,
  maxBytes: 512 * 1_024,
});

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredToolIds(profile: LoopProfile): string[] {
  const ids = new Set<string>();
  for (const toolId of profile.tools ?? []) ids.add(toolId);
  for (const entry of profile.agentTools ?? []) {
    if (entry.enabled !== false) ids.add(entry.toolId);
  }
  return [...ids].sort(compareCodeUnits);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function snapshotLoopProfile(profile: LoopProfile): LoopProfile {
  return deepFreeze(
    JSON.parse(canonicalJsonString(profile, LOOP_PROFILE_SNAPSHOT_LIMITS)) as LoopProfile,
  );
}

/**
 * Resolve a registered profile only after its exact runtime tool capabilities exist.
 *
 * The returned profile is a detached, deeply immutable snapshot. Resolution is
 * deliberately fail-closed: a profile is never silently degraded when a declared
 * tool is absent.
 */
export function resolveLoopProfileCapabilities(
  options: ResolveLoopProfileCapabilitiesOptions,
): Readonly<LoopProfile> {
  const registeredProfile = options.loopRegistry.getProfile(options.profileId);
  if (!registeredProfile) throw new LoopProfileNotFoundError(options.profileId);
  // LoopRegistry is a host port, not necessarily the built-in implementation.
  // Canonicalize before inspecting capabilities so third-party registries cannot
  // smuggle accessors, exotic prototypes, cycles, or unbounded profile data.
  const profile = snapshotLoopProfile(registeredProfile);

  const listedTools = new Set(options.toolRegistry.listTools());
  const hasTool = options.toolRegistry.hasTool
    ? (toolId: string): boolean => options.toolRegistry.hasTool?.(toolId) === true
    : (toolId: string): boolean => listedTools.has(toolId);
  const missingToolIds = requiredToolIds(profile).filter(toolId => !hasTool(toolId));
  if (missingToolIds.length > 0) {
    throw new MissingLoopProfileToolCapabilityError(profile.id, missingToolIds);
  }

  return profile;
}
