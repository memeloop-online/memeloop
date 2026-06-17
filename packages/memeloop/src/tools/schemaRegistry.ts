const toolSchemas = new Map<string, unknown>();
const toolMetadata = new Map<string, { displayName: string; description: string }>();

export function registerToolParameterSchema(
  toolId: string,
  schema: unknown,
  metadata?: { displayName: string; description: string },
): void {
  toolSchemas.set(toolId, schema);
  if (metadata) {
    toolMetadata.set(toolId, metadata);
  }
}

export function getToolParameterSchema(toolId: string): unknown {
  return toolSchemas.get(toolId);
}

export function getToolMetadata(
  toolId: string,
): { displayName: string; description: string } | undefined {
  return toolMetadata.get(toolId);
}
