import type { MergedPermissions, PermissionAction, PermissionSet } from "./types.js";

/**
 * Test whether a tool name matches a wildcard pattern.
 *
 * Supported patterns:
 * - `*`       → matches everything
 * - `file.*`   → matches any tool starting with `file.`
 * - `shell(*)` → matches tools like `shell(rm)`, `shell(ls)` (literal parens)
 * - exact name → matches only that exact tool name
 *
 * Patterns are converted to anchored regexes internally.
 */
export function matchPattern(toolName: string, pattern: string): boolean {
  // Exact match short-circuit
  if (pattern === toolName) return true;
  if (pattern === "*") return true;

  // Escape all regex special characters, then convert escaped * back to wildcard .*
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, ".*");

  return new RegExp(`^${escaped}$`).test(toolName);
}

/**
 * Merge multiple permission sets from lowest to highest priority.
 *
 * Sets are processed in order; later rules override earlier ones for the same tool pattern.
 * Within a single set, rules are processed in order (last wins).
 *
 * @param sets - Ordered from lowest to highest priority (e.g. default → agent → user → session)
 * @returns Flattened `MergedPermissions` with all unique patterns per action.
 */
export function mergePermissionSets(sets: PermissionSet[]): MergedPermissions {
  // Map from action to a Map of pattern → action (deduplicated by pattern, last wins)
  const merged = new Map<PermissionAction, Map<string, PermissionAction>>();
  merged.set("allow", new Map());
  merged.set("deny", new Map());
  merged.set("ask", new Map());

  for (const set of sets) {
    for (const rule of set.rules) {
      // Remove this pattern from any OTHER action maps (to avoid contradictions)
      for (const [action, map] of merged) {
        if (action !== rule.action) {
          map.delete(rule.toolPattern);
        }
      }
      // Set pattern in its action map
      merged.get(rule.action)!.set(rule.toolPattern, rule.action);
    }
  }

  return {
    allow: [...merged.get("allow")!.keys()],
    deny: [...merged.get("deny")!.keys()],
    ask: [...merged.get("ask")!.keys()],
  };
}

/**
 * Check what action applies to a given tool name under merged permissions.
 *
 * Precedence: exact patterns always beat wildcards.
 * Within same specificity: deny > ask > allow.
 */
export function checkPermission(
  toolName: string,
  merged: MergedPermissions,
): PermissionAction {
  const isWildcard = (p: string) => p.includes("*");

  // Exact patterns first: deny > ask > allow
  for (const pattern of merged.deny) {
    if (!isWildcard(pattern) && matchPattern(toolName, pattern)) return "deny";
  }
  for (const pattern of merged.ask) {
    if (!isWildcard(pattern) && matchPattern(toolName, pattern)) return "ask";
  }
  for (const pattern of merged.allow) {
    if (!isWildcard(pattern) && matchPattern(toolName, pattern)) return "allow";
  }

  // Wildcard patterns: deny > ask > allow
  for (const pattern of merged.deny) {
    if (isWildcard(pattern) && matchPattern(toolName, pattern)) return "deny";
  }
  for (const pattern of merged.ask) {
    if (isWildcard(pattern) && matchPattern(toolName, pattern)) return "ask";
  }
  for (const pattern of merged.allow) {
    if (isWildcard(pattern) && matchPattern(toolName, pattern)) return "allow";
  }

  // Fallback: when no rules are configured at all, allow everything (backward compat).
  // When rules exist but none match, deny (secure default).
  const hasAnyRules = merged.allow.length > 0 || merged.deny.length > 0 || merged.ask.length > 0;
  return hasAnyRules ? "deny" : "allow";
}
