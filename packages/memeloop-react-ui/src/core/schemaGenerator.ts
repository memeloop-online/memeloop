/**
 * Build RJSF schema from Agent Definition's promptSchema.
 * Platform-agnostic: no UI dependencies.
 */

import type { RJSFSchema } from "@rjsf/utils";

/** Agent definition shape (minimal for schema generation) */
export interface DefinitionWithPromptSchema {
  promptSchema?: unknown;
}

/**
 * Returns the form schema for the prompt config form.
 * Uses definition.promptSchema if present (must be valid JSON Schema / RJSFSchema),
 * otherwise returns a minimal empty object schema so the form can render without errors.
 */
export function getSchemaFromDefinition(definition: DefinitionWithPromptSchema): RJSFSchema {
  const raw = definition?.promptSchema;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as object).length > 0) {
    return raw as RJSFSchema;
  }
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

/**
 * 将 `promptConcatStream` 产出的 `sourcePaths` 写入 schema 描述，便于表单与 prompt 节点对齐。
 */
export function attachPromptPathAnnotations(
  schema: RJSFSchema,
  sourcePaths: Record<string, string> | undefined,
): RJSFSchema {
  if (!sourcePaths || Object.keys(sourcePaths).length === 0) return schema;
  const note = `MemeLoop prompt node paths: ${JSON.stringify(sourcePaths)}`;
  const prev = typeof schema.description === "string" ? schema.description : "";
  return {
    ...schema,
    description: prev ? `${prev}\n\n${note}` : note,
  };
}
