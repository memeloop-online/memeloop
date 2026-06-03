export * from './theme';
export * from './types';
export * from './components';

export const PROMPT_EDITOR_VERSION = '0.0.1';

export {
	getSchemaFromDefinition,
	attachPromptPathAnnotations,
	buildUiSchema,
	shouldShowConditionalField,
	ArrayItemProvider,
	useArrayItemContext,
	ConditionalField,
} from './core';
export type {
	DefinitionWithPromptSchema,
	SchemaWithUiSchema,
	ConditionalFieldConfig,
	ArrayItemContextValue,
	ArrayItemProviderProps,
	ExtendedFormContext,
} from './core';
