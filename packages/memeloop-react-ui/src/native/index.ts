/**
 * @memeloop/react-ui/native
 *
 * React Native (Paper) widgets and templates for RJSF.
 * Optional peer: react-native-paper. Re-exports core + native widgets/templates.
 */

export { NativeAgentChatView } from './AgentChatView.js';
export type { NativeAgentChatViewProps } from './AgentChatView.js';
export { templates } from './templates.js';
export { CheckboxWidget, getNativeWidgets, NumberWidget, RadioWidget, SelectWidget, TextWidget } from './widgets.jsx';

export { ArrayItemProvider, buildUiSchema, ConditionalField, getSchemaFromDefinition, shouldShowConditionalField, useArrayItemContext } from '../core/index.js';
export type { ArrayItemContextValue, ArrayItemProviderProps, ConditionalFieldConfig, DefinitionWithPromptSchema, ExtendedFormContext, SchemaWithUiSchema } from '../core/index.js';
