import type { IToolRegistry, PromptConcatTool } from 'memeloop';
import type { ToolPermissionConfig } from '../config.js';

/**
 * Simple Map-based tool registry. Optionally wraps another registry with allowlist/blocklist.
 */
export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, unknown>();
  private readonly promptPlugins = new Map<string, PromptConcatTool>();
  private permission: ToolPermissionConfig | undefined;

  constructor(permission?: ToolPermissionConfig) {
    this.permission = permission;
  }

  getPromptPlugins(): Map<string, PromptConcatTool> {
    return this.promptPlugins;
  }

  registerTool(id: string, impl: unknown): void {
    this.tools.set(id, impl);
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
    if (this.permission.blocklist?.length) {
      return list.filter((id) => !this.permission!.blocklist!.includes(id));
    }
    if (this.permission.allowlist?.length) {
      return list.filter((id) => this.permission!.allowlist!.includes(id));
    }
    return list;
  }
}
