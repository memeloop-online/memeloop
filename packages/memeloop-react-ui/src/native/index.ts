/**
 * @memeloop/react-ui/native
 *
 * React Native (Paper) widgets and templates for RJSF.
 * Optional peer: react-native-paper. Re-exports core + native widgets/templates.
 */

export {
  getNativeWidgets,
  TextWidget,
  CheckboxWidget,
  SelectWidget,
  RadioWidget,
  NumberWidget,
} from "./widgets.jsx";
export { templates } from "./templates.js";

export {
  getSchemaFromDefinition,
  buildUiSchema,
  shouldShowConditionalField,
  ArrayItemProvider,
  useArrayItemContext,
  ConditionalField,
} from "../core/index.js";
export type {
  DefinitionWithPromptSchema,
  SchemaWithUiSchema,
  ConditionalFieldConfig,
  ArrayItemContextValue,
  ArrayItemProviderProps,
  ExtendedFormContext,
} from "../core/index.js";
