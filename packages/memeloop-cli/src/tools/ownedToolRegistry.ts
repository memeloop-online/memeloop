import type { IToolRegistry, ToolOperationEffect } from 'memeloop';

/**
 * Canonical registry contract for host tools. Every environment registrar uses
 * an ownership-bound registration and returns the disposer it received from
 * the registry; no registrar falls back to an unowned `registerTool` call.
 */
export interface OwnedToolRegistry extends IToolRegistry {
  registerOwnedTool(
    id: string,
    implementation: unknown,
    parameterSchema?: unknown,
    effect?: ToolOperationEffect,
  ): () => boolean;
}

/** Resolve the owner-aware registry required by Node environment tools. */
export function requireOwnedToolRegistry(registry: IToolRegistry): OwnedToolRegistry {
  if (typeof (registry as Partial<OwnedToolRegistry>).registerOwnedTool !== 'function') {
    throw new Error('Node environment tools require an ownership-aware tool registry');
  }
  return registry as OwnedToolRegistry;
}

/** Dispose a registrar's registrations in reverse order, preserving all errors. */
export function disposeOwnedToolRegistrations(cleanups: Array<() => boolean>): void {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  cleanups.length = 0;
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Owned tool registration cleanup failed');
  }
}
