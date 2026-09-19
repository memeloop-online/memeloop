import { type IToolRegistry, type PromptConcatTool, type ToolOperationEffect } from 'memeloop';
import type { ToolPermissionConfig } from '../config.js';

/**
 * Simple Map-based tool registry. Optionally wraps another registry with allowlist/blocklist.
 */
export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, unknown>();
  private readonly effects = new Map<string, ToolOperationEffect>();
  private readonly parameterSchemas = new Map<string, unknown>();
  private readonly promptPlugins = new Map<string, PromptConcatTool>();
  private readonly owners = new Map<string, symbol>();
  private permission: ToolPermissionConfig | undefined;

  constructor(permission?: ToolPermissionConfig) {
    this.permission = permission;
  }

  getPromptPlugins(): Map<string, PromptConcatTool> {
    return this.promptPlugins;
  }

  registerTool(
    id: string,
    impl: unknown,
    parameterSchema?: unknown,
    effect: ToolOperationEffect = 'execute',
  ): void {
    if (typeof impl !== 'function') throw new TypeError(`Tool implementation must be callable: ${id}`);
    if (this.tools.has(id)) throw new Error(`Tool already registered: ${id}`);
    this.setTool(id, impl, parameterSchema, effect);
    this.owners.delete(id);
  }

  registerOwnedTool(
    id: string,
    impl: unknown,
    parameterSchema?: unknown,
    effect: ToolOperationEffect = 'execute',
  ): () => boolean {
    if (typeof impl !== 'function') throw new TypeError(`Tool implementation must be callable: ${id}`);
    if (this.tools.has(id)) throw new Error(`Tool already registered: ${id}`);
    const owner = Symbol(id);
    this.setTool(id, impl, parameterSchema, effect);
    this.owners.set(id, owner);
    return () => {
      if (this.owners.get(id) !== owner) return false;
      return this.unregisterTool(id);
    };
  }

  /** Trusted host replacement. */
  replaceTool(
    id: string,
    impl: unknown,
    parameterSchema?: unknown,
    effect: ToolOperationEffect = 'execute',
  ): void {
    if (typeof impl !== 'function') throw new TypeError(`Tool implementation must be callable: ${id}`);
    this.setTool(id, impl, parameterSchema, effect);
    this.owners.delete(id);
  }

  private setTool(
    id: string,
    impl: unknown,
    parameterSchema: unknown,
    effect: ToolOperationEffect,
  ): void {
    this.tools.set(id, impl);
    this.effects.set(id, effect);
    if (parameterSchema !== undefined) {
      this.parameterSchemas.set(id, parameterSchema);
    } else {
      this.parameterSchemas.delete(id);
    }
  }

  hasTool(id: string): boolean {
    return this.tools.has(id);
  }

  unregisterTool(id: string): boolean {
    this.owners.delete(id);
    this.effects.delete(id);
    this.parameterSchemas.delete(id);
    this.promptPlugins.delete(id);
    return this.tools.delete(id);
  }

  getToolParameterSchema(id: string): unknown {
    return this.parameterSchemas.get(id);
  }

  getToolEffect(id: string): ToolOperationEffect | undefined {
    return this.effects.get(id);
  }

  getTool(id: string): unknown {
    if (this.permission) {
      if (this.permission.blocklist?.includes(id)) return undefined;
      if (
        this.permission.allowlist &&
        this.permission.allowlist.length > 0 &&
        !this.permission.allowlist.includes(id)
      ) {
        return undefined;
      }
    }
    return this.tools.get(id);
  }

  listTools(): string[] {
    const list = Array.from(this.tools.keys());
    if (!this.permission) return list;
    const blocklist = this.permission.blocklist ?? [];
    const allowlist = this.permission.allowlist ?? [];
    return list.filter(
      (id) =>
        !blocklist.includes(id) &&
        (allowlist.length === 0 || allowlist.includes(id)),
    );
  }
}
