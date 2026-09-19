import type { ToolOperationEffect } from '../orchestration/resources.js';
import type { IToolRegistry } from '../types.js';
import type { ToolSchemaRegistry } from './schemaRegistry.js';
import type { PromptConcatTool } from './types.js';

/**
 * Runtime-owned tool overlay.
 *
 * Core capabilities are registered in the local layer and may intentionally
 * shadow a host tool with the same canonical id. Host capabilities remain a
 * read-only fallback and are never mutated or disposed by the runtime.
 */
export class RuntimeToolRegistry implements IToolRegistry {
  private readonly tools = new Map<string, unknown>();
  private readonly parameterSchemas = new Map<string, unknown>();
  private readonly effects = new Map<string, ToolOperationEffect>();
  private readonly owners = new Map<string, symbol>();

  constructor(
    private readonly host: IToolRegistry,
    private readonly promptPlugins: Map<string, PromptConcatTool>,
    private readonly schemaCatalog: ToolSchemaRegistry,
  ) {}

  registerTool(
    id: string,
    implementation: unknown,
    parameterSchema?: unknown,
    effect: ToolOperationEffect = 'execute',
  ): void {
    this.assertRegistration(id, implementation);
    this.setLocalTool(id, implementation, parameterSchema, effect);
    this.owners.delete(id);
  }

  registerOwnedTool(
    id: string,
    implementation: unknown,
    parameterSchema?: unknown,
    effect: ToolOperationEffect = 'execute',
  ): () => boolean {
    this.assertRegistration(id, implementation);
    const owner = Symbol(id);
    this.setLocalTool(id, implementation, parameterSchema, effect);
    this.owners.set(id, owner);
    return () => {
      if (this.owners.get(id) !== owner) return false;
      return this.unregisterTool(id);
    };
  }

  unregisterTool(id: string): boolean {
    this.owners.delete(id);
    this.parameterSchemas.delete(id);
    this.effects.delete(id);
    return this.tools.delete(id);
  }

  hasTool(id: string): boolean {
    return this.tools.has(id) || (
      this.host.hasTool?.(id) ?? this.host.getTool(id) !== undefined
    );
  }

  getTool(id: string): unknown {
    return this.tools.has(id) ? this.tools.get(id) : this.host.getTool(id);
  }

  listTools(): string[] {
    return [...new Set([...this.host.listTools(), ...this.tools.keys()])];
  }

  getToolParameterSchema(id: string): unknown {
    return this.parameterSchemas.has(id)
      ? this.parameterSchemas.get(id)
      : this.host.getToolParameterSchema?.(id);
  }

  getToolMetadata(id: string) {
    return this.schemaCatalog.getToolMetadata(id) ?? this.host.getToolMetadata?.(id);
  }

  getToolEffect(id: string): ToolOperationEffect | undefined {
    return this.effects.get(id) ?? this.host.getToolEffect?.(id);
  }

  getPromptPlugins(): Map<string, PromptConcatTool> {
    return this.promptPlugins;
  }

  dispose(): void {
    this.tools.clear();
    this.parameterSchemas.clear();
    this.effects.clear();
    this.owners.clear();
  }

  private assertRegistration(id: string, implementation: unknown): void {
    if (typeof implementation !== 'function') {
      throw new TypeError(`Tool implementation must be callable: ${id}`);
    }
    if (this.tools.has(id)) throw new Error(`Tool already registered in runtime: ${id}`);
  }

  private setLocalTool(
    id: string,
    implementation: unknown,
    parameterSchema: unknown,
    effect: ToolOperationEffect,
  ): void {
    this.tools.set(id, implementation);
    this.effects.set(id, effect);
    if (parameterSchema === undefined) this.parameterSchemas.delete(id);
    else this.parameterSchemas.set(id, parameterSchema);
  }
}
