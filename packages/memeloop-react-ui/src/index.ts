export * from './chat';
export * from './components';
export * from './theme';
export * from './types';

export const PROMPT_EDITOR_VERSION = '0.0.1';

export {
  ArrayItemProvider,
  attachPromptPathAnnotations,
  buildUiSchema,
  ConditionalField,
  getSchemaFromDefinition,
  rjsfFieldPathToSegments,
  shouldShowConditionalField,
  useArrayItemContext,
} from './core';
export type {
  ArrayItemContextValue,
  ArrayItemProviderProps,
  ConditionalFieldConfig,
  DefinitionWithPromptSchema,
  ExtendedFormContext,
  RjsfFieldPath,
  SchemaWithUiSchema,
} from './core';
