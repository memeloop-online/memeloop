import { type IToolRegistry, type PromptConcatTool, registerToolParameterSchema, type ToolOperationEffect } from 'memeloop';
import type { ToolPermissionConfig } from '../config.js';

/**
 * Simple Map-based tool registry. Optionally wraps another registry with allowlist/blocklist.
 */
export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, unknown>();
  private readonly effects = new Map<string, ToolOperationEffect>();
  private readonly parameterSchemas = new Map<string, unknown>();
  private readonly promptPlugins = new Map<string, PromptConcatTool>();
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
    this.tools.set(id, impl);
    this.effects.set(id, effect);
    if (parameterSchema !== undefined) {
      this.parameterSchemas.set(id, parameterSchema);
      registerToolParameterSchema(id, parameterSchema, {
        displayName: id,
        description: `Host-registered tool ${id}`,
      });
    } else {
      this.parameterSchemas.delete(id);
    }
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
