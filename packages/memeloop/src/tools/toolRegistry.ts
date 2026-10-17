/**
 * Tool definition registry.
 * Converted from module-level singletons to an instance class for test isolation
 * and multi-runtime support.
 */
import { defineTool } from './defineTool.js';
import type { DefinedTool, ToolDefinition, ToolSchema } from './defineToolTypes.js';
import { ToolSchemaRegistry } from './schemaRegistry.js';
import type { PromptConcatTool } from './types.js';

/**
 * Instance-level tool definition registry.
 */
export class ToolDefinitionRegistry {
  private readonly registry = new Map<string, DefinedTool>();
  private readonly cleanup = new Map<string, () => boolean>();

  constructor(
    private readonly promptPlugins: Map<string, PromptConcatTool> = new Map(),
    private readonly schemas: ToolSchemaRegistry = new ToolSchemaRegistry(),
  ) {}

  registerToolDefinition<
    TConfigSchema extends ToolSchema,
    TLLMToolSchemas extends Record<string, ToolSchema>,
  >(
    definition: ToolDefinition<TConfigSchema, TLLMToolSchemas>,
  ): DefinedTool<TConfigSchema, TLLMToolSchemas> {
    return this.registerOwnedToolDefinition(definition).definition;
  }

  registerOwnedToolDefinition<
    TConfigSchema extends ToolSchema,
    TLLMToolSchemas extends Record<string, ToolSchema>,
  >(
    definition: ToolDefinition<TConfigSchema, TLLMToolSchemas>,
  ): {
    definition: DefinedTool<TConfigSchema, TLLMToolSchemas>;
    unregister: () => boolean;
  } {
    if (this.registry.has(definition.toolId) || this.promptPlugins.has(definition.toolId)) {
      throw new Error(`Tool definition already registered: ${definition.toolId}`);
    }
    const toolDefinition = defineTool(definition, { pluginRegistry: this.promptPlugins });
    let unregisterSchema: (() => boolean) | undefined;
    try {
      unregisterSchema = this.schemas.registerOwnedToolParameterSchema(
        toolDefinition.toolId,
        toolDefinition.configSchema as object,
        {
          displayName: toolDefinition.displayName,
          description: toolDefinition.description,
        },
      );
    } catch (error) {
      if (this.promptPlugins.get(toolDefinition.toolId) === toolDefinition.tool) {
        this.promptPlugins.delete(toolDefinition.toolId);
      }
      throw error;
    }

    this.registry.set(toolDefinition.toolId, toolDefinition as DefinedTool);
    const owner = toolDefinition as DefinedTool;
    const unregister = (): boolean => {
      if (this.registry.get(toolDefinition.toolId) !== owner) return false;
      this.registry.delete(toolDefinition.toolId);
      this.cleanup.delete(toolDefinition.toolId);
      if (this.promptPlugins.get(toolDefinition.toolId) === toolDefinition.tool) {
        this.promptPlugins.delete(toolDefinition.toolId);
      }
      unregisterSchema?.();
      return true;
    };
    this.cleanup.set(toolDefinition.toolId, unregister);
    return {
      definition: toolDefinition as DefinedTool<TConfigSchema, TLLMToolSchemas>,
      unregister,
    };
  }

  getAllToolDefinitions(): ReadonlyMap<string, DefinedTool> {
    return new Map(this.registry);
  }

  getToolDefinition(toolId: string): DefinedTool | undefined {
    return this.registry.get(toolId);
  }

  dispose(): void {
    for (const unregister of [...this.cleanup.values()].reverse()) unregister();
  }
}
