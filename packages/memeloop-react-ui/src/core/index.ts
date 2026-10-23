/**
 * Platform-agnostic prompt editor core: schema, uiSchema, conditional field, array context.
 */

export { attachPromptPathAnnotations, getSchemaFromDefinition } from './schemaGenerator.js';
export type { DefinitionWithPromptSchema } from './schemaGenerator.js';

export { buildUiSchema } from './uiSchemaBuilder.js';
export type { SchemaWithUiSchema } from './uiSchemaBuilder.js';

export { rjsfFieldPathToSegments, shouldShowConditionalField } from './conditionVisibility.js';
export type { ConditionalFieldConfig, RjsfFieldPath } from './conditionVisibility.js';

export { ArrayItemProvider, useArrayItemContext } from './ArrayItemContext.jsx';
export type { ArrayItemContextValue, ArrayItemProviderProps } from './ArrayItemContext.jsx';

export { ConditionalField, type ExtendedFormContext } from './ConditionalField.jsx';
