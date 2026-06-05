/**
 * Hook registry for managing lifecycle hook handlers.
 * Hooks execute in registration order (first registered, first executed).
 *
 * Converted from module-level singletons to an instance class for test isolation
 * and multi-runtime support. Backward-compatible function exports delegate to a
 * default global instance.
 */

import type { HookType, HookHandler, HookResult, HookContext } from "./types.js";

/** Type matching the hook handler maps. */
type HookHandlerMap = Map<string, HookHandler>;

/**
 * Instance-level hook registry. Each instance maintains its own handler state.
 */
export class HookRegistry {
  private readonly hookRegistry = new Map<HookType, HookHandlerMap>();
  private readonly hookOrder: Map<HookType, HookHandler[]> = new Map();

  /**
   * Register a hook handler for a specific lifecycle event.
   */
  registerHook(
    type: HookType,
    handler: HookHandler,
    name?: string,
  ): void {
    const key = name ?? `hook:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    const handlers = this.hookOrder.get(type) ?? [];
    handlers.push(handler);
    this.hookOrder.set(type, handlers);

    const map = this.hookRegistry.get(type) ?? new Map<string, HookHandler>();
    map.set(key, handler);
    this.hookRegistry.set(type, map);
  }

  /**
   * Unregister a specific hook handler by name.
   */
  unregisterHook(type: HookType, name: string): boolean {
    const map = this.hookRegistry.get(type);
    if (!map) return false;
    const deleted = map.delete(name);
    if (deleted) {
      this.hookOrder.set(type, Array.from(map.values()));
    }
    return deleted;
  }

  /**
   * Execute all registered hooks for a given type in registration order.
   */
  async executeHooks(
    type: HookType,
    context: HookContext,
    data: Record<string, unknown>,
  ): Promise<HookResult> {
    const handlers = this.hookOrder.get(type);
    if (!handlers || handlers.length === 0) {
      return { allowed: true };
    }

    let currentData = data;
    let mergedModified: Record<string, unknown> | undefined;
    let permissionAction: HookResult['permissionAction'];
    for (const handler of handlers) {
      try {
        const result = await handler(context, currentData);
        if (result.modified) {
          mergedModified = { ...(mergedModified ?? {}), ...result.modified };
          currentData = { ...currentData, ...result.modified };
        }
        if (result.permissionAction && result.permissionAction !== 'allow') {
          permissionAction = result.permissionAction;
        }
        if (!result.allowed) {
          return {
            ...result,
            modified: mergedModified ?? result.modified,
            permissionAction: permissionAction ?? result.permissionAction,
          };
        }
      } catch (err) {
        return {
          allowed: false,
          reason: err instanceof Error ? err.message : "Hook execution failed",
          modified: mergedModified,
          permissionAction,
        };
      }
    }

    const finalResult: HookResult = { allowed: true };
    if (mergedModified) finalResult.modified = mergedModified;
    if (permissionAction) finalResult.permissionAction = permissionAction;
    return finalResult;
  }

  /**
   * Check if any hooks are registered for a given type.
   */
  hasHooks(type: HookType): boolean {
    const map = this.hookRegistry.get(type);
    return map != null && map.size > 0;
  }

  /**
   * Remove all registered hooks of all types.
   */
  clearHooks(): void {
    this.hookRegistry.clear();
    this.hookOrder.clear();
  }

  /**
   * List all hook types that have at least one registered handler.
   */
  listRegisteredHookTypes(): HookType[] {
    const types: HookType[] = [];
    for (const [type, map] of this.hookRegistry) {
      if (map.size > 0) {
        types.push(type);
      }
    }
    return types;
  }

  /**
   * Get the count of registered handlers for a hook type.
   */
  getHookCount(type: HookType): number {
    const map = this.hookRegistry.get(type);
    return map?.size ?? 0;
  }
}

// ─── Default global instance + backward-compatible function exports ───

const defaultHookRegistry = new HookRegistry();

export function getDefaultHookRegistry(): HookRegistry {
  return defaultHookRegistry;
}

export function registerHook(type: HookType, handler: HookHandler, name?: string): void {
  defaultHookRegistry.registerHook(type, handler, name);
}

export function unregisterHook(type: HookType, name: string): boolean {
  return defaultHookRegistry.unregisterHook(type, name);
}

export async function executeHooks(
  type: HookType,
  context: HookContext,
  data: Record<string, unknown>,
): Promise<HookResult> {
  return defaultHookRegistry.executeHooks(type, context, data);
}

export function hasHooks(type: HookType): boolean {
  return defaultHookRegistry.hasHooks(type);
}

export function clearHooks(): void {
  defaultHookRegistry.clearHooks();
}

export function listRegisteredHookTypes(): HookType[] {
  return defaultHookRegistry.listRegisteredHookTypes();
}

/**
 * Get the count of registered handlers for a hook type.
 */
export function getHookCount(type: HookType): number {
  return defaultHookRegistry.getHookCount(type);
}
