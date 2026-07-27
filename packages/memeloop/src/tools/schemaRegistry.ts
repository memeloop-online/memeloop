import { zodToJsonSchema } from 'zod-to-json-schema';

const toolSchemas = new Map<string, unknown>();
const toolMetadata = new Map<string, { displayName: string; description: string }>();

/**
 * Convert either a legacy host's Zod 3 schema, a current Zod 4 schema,
 * schema, or an already portable JSON Schema without silently widening a
 * registered tool to an unconstrained object.
 */
export function toolSchemaToJsonSchema(value: unknown): Record<string, unknown> {
  const native = (
    value as { toJSONSchema?: () => Record<string, unknown> } | undefined
  )?.toJSONSchema?.();
  if (native) return structuredClone(native);

  if (value !== null && typeof value === 'object' && '_def' in value) {
    const converted = zodToJsonSchema(value as never, {
      $refStrategy: 'none',
    });
    return structuredClone(converted as Record<string, unknown>);
  }

  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ('type' in value ||
      'properties' in value ||
      '$ref' in value ||
      'oneOf' in value ||
      'anyOf' in value)
  ) {
    return structuredClone(value as Record<string, unknown>);
  }

  throw new TypeError(
    'Tool parameter schema must be a Zod schema or a portable JSON Schema',
  );
}

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
