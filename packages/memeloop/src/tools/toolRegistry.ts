/**
 * TidGi `toolRegistry.ts` 迁移。
 */
import type { z } from 'zod';

import { defineTool } from './defineTool.js';
import type { DefinedTool, ToolDefinition } from './defineToolTypes.js';
import { registerToolParameterSchema } from './schemaRegistry.js';

const toolDefinitionRegistry = new Map<string, DefinedTool>();

export function registerToolDefinition<
  TConfigSchema extends z.ZodType,
  TLLMToolSchemas extends Record<string, z.ZodType>,
>(definition: ToolDefinition<TConfigSchema, TLLMToolSchemas>): DefinedTool<TConfigSchema, TLLMToolSchemas> {
  const toolDefinition = defineTool(definition);

  registerToolParameterSchema(toolDefinition.toolId, toolDefinition.configSchema as object, {
    displayName: toolDefinition.displayName,
    description: toolDefinition.description,
  });

  toolDefinitionRegistry.set(toolDefinition.toolId, toolDefinition as DefinedTool);
  return toolDefinition as DefinedTool<TConfigSchema, TLLMToolSchemas>;
}

export function getAllToolDefinitions(): Map<string, DefinedTool> {
  return toolDefinitionRegistry;
}

export function getToolDefinition(toolId: string): DefinedTool | undefined {
  return toolDefinitionRegistry.get(toolId);
}
