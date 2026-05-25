/**
 * Hook registry for managing lifecycle hook handlers.
 * Hooks execute in registration order (first registered, first executed).
 */

import type { HookType, HookHandler, HookResult, HookContext } from "./types.js";

/** Type matching the hook handler maps. */
type HookHandlerMap = Map<string, HookHandler>;

/** Registry of hook handlers by type. */
const hookRegistry = new Map<HookType, HookHandlerMap>();

/** Internal user-provided handler ordering in a flat list per type. */
const hookOrder: Map<HookType, HookHandler[]> = new Map();

/**
 * Register a hook handler for a specific lifecycle event.
 *
 * Handlers execute in registration order. If any handler returns
 * `{ allowed: false }`, subsequent handlers are skipped and the
 * action is blocked.
 *
 * @param type - The hook event type to listen for
 * @param handler - The handler function
 * @param name - Optional unique name for this handler (enables dedup/unregistration)
 */
export function registerHook(
  type: HookType,
  handler: HookHandler,
  name?: string,
): void {
  const key = name ?? `hook:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  const handlers = hookOrder.get(type) ?? [];
  handlers.push(handler);
  hookOrder.set(type, handlers);

  const map = hookRegistry.get(type) ?? new Map();
  map.set(key, handler);
  hookRegistry.set(type, map);
}

/**
 * Unregister a specific hook handler by name.
 * Only works for handlers registered with a name.
 */
export function unregisterHook(type: HookType, name: string): boolean {
  const map = hookRegistry.get(type);
  if (!map) return false;
  const deleted = map.delete(name);
  if (deleted) {
    // Rebuild order from remaining handlers
    hookOrder.set(type, Array.from(map.values()));
  }
  return deleted;
}

/**
 * Execute all registered hooks for a given type in registration order.
 *
 * If any hook returns `{ allowed: false }`, execution stops immediately
 * and the blocking result is returned.
 *
 * @returns The first blocking result, or an allow result if all passed
 */
export async function executeHooks(
  type: HookType,
  context: HookContext,
  data: Record<string, unknown>,
): Promise<HookResult> {
  const handlers = hookOrder.get(type);
  if (!handlers || handlers.length === 0) {
    return { allowed: true };
  }

  for (const handler of handlers) {
    try {
      const result = await handler(context, data);
      if (!result.allowed) {
        return result;
      }
    } catch (err) {
      // If a hook throws, treat as denial
      return {
        allowed: false,
        reason: err instanceof Error ? err.message : "Hook execution failed",
      };
    }
  }

  return { allowed: true };
}

/**
 * Check if any hooks are registered for a given type.
 */
export function hasHooks(type: HookType): boolean {
  const map = hookRegistry.get(type);
  return map != null && map.size > 0;
}

/**
 * Remove all registered hooks of all types.
 */
export function clearHooks(): void {
  hookRegistry.clear();
  hookOrder.clear();
}

/**
 * List all hook types that have at least one registered handler.
 */
export function listRegisteredHookTypes(): HookType[] {
  const types: HookType[] = [];
  for (const [type, map] of hookRegistry) {
    if (map.size > 0) {
      types.push(type);
    }
  }
  return types;
}

/**
 * Get the count of registered handlers for a hook type.
 */
export function getHookCount(type: HookType): number {
  const map = hookRegistry.get(type);
  return map?.size ?? 0;
}
