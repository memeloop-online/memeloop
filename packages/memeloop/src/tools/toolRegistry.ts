/**
 * Tool definition registry.
 * Converted from module-level singletons to an instance class for test isolation
 * and multi-runtime support.
 */
import type { z } from 'zod';

import { defineTool } from './defineTool.js';
import type { DefinedTool, ToolDefinition } from './defineToolTypes.js';
import { registerToolParameterSchema } from './schemaRegistry.js';

/**
 * Instance-level tool definition registry.
 */
export class ToolDefinitionRegistry {
  private readonly registry = new Map<string, DefinedTool>();

  registerToolDefinition<
    TConfigSchema extends z.ZodType,
    TLLMToolSchemas extends Record<string, z.ZodType>,
  >(definition: ToolDefinition<TConfigSchema, TLLMToolSchemas>): DefinedTool<TConfigSchema, TLLMToolSchemas> {
    const toolDefinition = defineTool(definition);

    registerToolParameterSchema(toolDefinition.toolId, toolDefinition.configSchema as object, {
      displayName: toolDefinition.displayName,
      description: toolDefinition.description,
    });

    this.registry.set(toolDefinition.toolId, toolDefinition as DefinedTool);
    return toolDefinition as DefinedTool<TConfigSchema, TLLMToolSchemas>;
  }

  getAllToolDefinitions(): Map<string, DefinedTool> {
    return this.registry;
  }

  getToolDefinition(toolId: string): DefinedTool | undefined {
    return this.registry.get(toolId);
  }
}

// ─── Default global instance + backward-compatible function exports ───

const defaultToolDefinitionRegistry = new ToolDefinitionRegistry();

export function getDefaultToolDefinitionRegistry(): ToolDefinitionRegistry {
  return defaultToolDefinitionRegistry;
}

export function registerToolDefinition<
  TConfigSchema extends z.ZodType,
  TLLMToolSchemas extends Record<string, z.ZodType>,
>(definition: ToolDefinition<TConfigSchema, TLLMToolSchemas>): DefinedTool<TConfigSchema, TLLMToolSchemas> {
  return defaultToolDefinitionRegistry.registerToolDefinition(definition);
}

export function getAllToolDefinitions(): Map<string, DefinedTool> {
  return defaultToolDefinitionRegistry.getAllToolDefinitions();
}

export function getToolDefinition(toolId: string): DefinedTool | undefined {
  return defaultToolDefinitionRegistry.getToolDefinition(toolId);
}
