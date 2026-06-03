/**
 * @memeloop/react-ui/web
 *
 * Web (MUI) 封装：在 @rjsf/mui 之上导出 HelpTooltip 与合并后的 widgets/templates。
 */

export { default as Form, Theme } from "@rjsf/mui";

import { Theme } from "@rjsf/mui";

import { HelpTooltip } from "./HelpTooltip.js";

/** MUI 默认 widgets（与 Theme.widgets 相同，便于宿主统一从本包导入） */
export const widgets: typeof Theme.widgets = Theme.widgets ?? {};

/** MUI 默认 templates */
export const templates: typeof Theme.templates = Theme.templates ?? {};

export { HelpTooltip };
export type { HelpTooltipProps } from "./HelpTooltip.js";

export {
  getSchemaFromDefinition,
  attachPromptPathAnnotations,
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
