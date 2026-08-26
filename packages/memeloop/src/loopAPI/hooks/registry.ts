/**
 * Hook registry for managing lifecycle hook handlers.
 * Hooks execute in registration order (first registered, first executed).
 *
 * Converted from module-level singletons to an instance class for test isolation
 * and multi-runtime support. Backward-compatible function exports delegate to a
 * default global instance.
 */

import { safeErrorMessageFromUnknown } from '../../safeError.js';
import { canonicalizePreToolUseHookResult } from '../../tools/structuredToolArguments.js';
import type { HookContext, HookHandler, HookResult, HookType } from './types.js';

/** Type matching the hook handler maps. */
type HookHandlerMap = Map<string, HookHandler>;

/**
 * Instance-level hook registry. Each instance maintains its own handler state.
 */
export class HookRegistry {
  private readonly hookRegistry = new Map<HookType, HookHandlerMap>();
  private readonly hookOrder: Map<HookType, HookHandler[]> = new Map();
  private readonly ownership = new Map<HookType, Map<string, symbol>>();

  /**
   * Register a hook handler for a specific lifecycle event.
   */
  registerHook(type: HookType, handler: HookHandler, name?: string): void {
    if (typeof handler !== 'function') {
      throw new TypeError(`Hook handler must be callable: ${type}`);
    }
    const key = name ?? `hook:${crypto.randomUUID()}`;
    const map = this.hookRegistry.get(type) ?? new Map<string, HookHandler>();
    map.set(key, handler);
    this.hookRegistry.set(type, map);
    const owners = this.ownership.get(type) ?? new Map<string, symbol>();
    owners.set(key, Symbol(key));
    this.ownership.set(type, owners);
    // A stable name is a replace operation. Deriving execution order from the
    // authoritative map prevents a replaced hook from executing twice.
    this.hookOrder.set(type, Array.from(map.values()));
  }

  /**
   * Register an unloadable hook. Unlike the compatibility registerHook API,
   * this refuses collisions and its disposer cannot remove a later owner.
   */
  registerOwnedHook(type: HookType, handler: HookHandler, name?: string): () => boolean {
    if (typeof handler !== 'function') {
      throw new TypeError(`Hook handler must be callable: ${type}`);
    }
    const key = name ?? `hook:${crypto.randomUUID()}`;
    if (this.hasHook(type, key)) throw new Error(`Hook already registered: ${type}:${key}`);
    const owner = Symbol(key);
    const map = this.hookRegistry.get(type) ?? new Map<string, HookHandler>();
    const owners = this.ownership.get(type) ?? new Map<string, symbol>();
    map.set(key, handler);
    owners.set(key, owner);
    this.hookRegistry.set(type, map);
    this.ownership.set(type, owners);
    this.hookOrder.set(type, Array.from(map.values()));
    return (): boolean => {
      if (this.ownership.get(type)?.get(key) !== owner) return false;
      return this.unregisterHook(type, key);
    };
  }

  hasHook(type: HookType, name: string): boolean {
    return this.hookRegistry.get(type)?.has(name) ?? false;
  }

  /**
   * Unregister a specific hook handler by name.
   */
  unregisterHook(type: HookType, name: string): boolean {
    const map = this.hookRegistry.get(type);
    if (!map) return false;
    const deleted = map.delete(name);
    if (deleted) {
      this.ownership.get(type)?.delete(name);
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
      context.operationSignal?.throwIfAborted();
      try {
        const rawResult = await handler(context, currentData);
        context.operationSignal?.throwIfAborted();
        // PreToolUse is an execution boundary. Detach the complete hook result
        // before reading or spreading it so accessors/proxies/cycles never
        // reach permission, approval, orchestration, persistence, or tools.
        const result = type === 'PreToolUse' ? canonicalizePreToolUseHookResult(rawResult) : rawResult;
        if (result.modified) {
          mergedModified = { ...(mergedModified ?? {}), ...result.modified };
          currentData = { ...currentData, ...result.modified };
        }
        if (result.permissionAction && result.permissionAction !== 'allow') {
          permissionAction = result.permissionAction;
        }
        if (!result.allowed) {
          const denied: HookResult = { allowed: false };
          if (result.reason !== undefined) denied.reason = result.reason;
          const deniedModified = mergedModified ?? result.modified;
          if (deniedModified !== undefined) denied.modified = deniedModified;
          const deniedPermissionAction = permissionAction ?? result.permissionAction;
          if (deniedPermissionAction !== undefined) {
            denied.permissionAction = deniedPermissionAction;
          }
          return denied;
        }
      } catch (error) {
        // Durable run cancellation is control flow, not a policy denial. It
        // must reach the runtime so no post-cancel message/tool side effect is
        // persisted under the guise of a blocked hook.
        if (context.operationSignal?.aborted) context.operationSignal.throwIfAborted();
        const denied: HookResult = {
          allowed: false,
          reason: safeErrorMessageFromUnknown(error, { fallback: 'Hook execution failed' }),
        };
        if (mergedModified !== undefined) denied.modified = mergedModified;
        if (permissionAction !== undefined) denied.permissionAction = permissionAction;
        return denied;
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
    this.ownership.clear();
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

  /** Snapshot this registry for an isolated runtime without sharing mutation. */
  fork(): HookRegistry {
    const clone = new HookRegistry();
    for (const [type, handlers] of this.hookRegistry) {
      for (const [name, handler] of handlers) clone.registerHook(type, handler, name);
    }
    return clone;
  }
}

export async function executeHooks(
  type: HookType,
  context: HookContext,
  data: Record<string, unknown>,
): Promise<HookResult> {
  if (!context.hooks) throw new Error('Lifecycle hooks require a runtime-scoped registry');
  return context.hooks.executeHooks(type, context, data);
}

export function hasHooks(type: HookType, context: HookContext): boolean {
  if (!context.hooks) throw new Error('Lifecycle hooks require a runtime-scoped registry');
  return context.hooks.hasHooks(type);
}
