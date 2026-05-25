/**
 * Layered permission system types.
 *
 * Permissions are resolved by merging rule sets from multiple layers
 * (default → agent → user → session), where later layers override earlier ones.
 */

/** Permission action for a tool invocation. */
export type PermissionAction = "allow" | "deny" | "ask";

/** A single permission rule: matches a tool name pattern to an action. */
export interface PermissionRule {
  /** Wildcard-capable pattern, e.g. `"file.*"`, `"shell(rm)"`, `"*"`. */
  toolPattern: string;
  action: PermissionAction;
}

/** A set of permission rules belonging to a specific source/layer. */
export interface PermissionSet {
  rules: PermissionRule[];
  /** Human-readable source identifier for debugging (e.g. "default", "agent:cli-buddy", "user"). */
  source: string;
}

/**
 * Result of merging multiple `PermissionSet` layers.
 * Each array contains flattened, deduplicated tool patterns for that action.
 */
export interface MergedPermissions {
  allow: string[];
  deny: string[];
  ask: string[];
}
