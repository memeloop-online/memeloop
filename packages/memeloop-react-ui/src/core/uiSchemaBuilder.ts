/**
 * Build uiSchema for RJSF from schema and overrides.
 * Platform-agnostic: pure function, no UI dependencies.
 */

import type { UiSchema } from "@rjsf/utils";

/** Schema that may carry embedded uiSchema (e.g. in a meta or top-level key) */
export interface SchemaWithUiSchema {
  uiSchema?: UiSchema;
  [key: string]: unknown;
}

/**
 * Merges default uiSchema from schema (if present) with overrides.
 * Overrides take precedence. Safe to call with undefined schema or overrides.
 */
export function buildUiSchema(
  schema?: SchemaWithUiSchema | null,
  overrides: UiSchema = {},
): UiSchema {
  const fromSchema = schema?.uiSchema ?? {};
  return {
    ...(fromSchema as UiSchema),
    ...overrides,
  };
}
