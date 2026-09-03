/**
 * @memeloop/react-ui/web
 *
 * Web (MUI) 封装：在 @rjsf/mui 之上导出 HelpTooltip 与合并后的 widgets/templates。
 */

export { default as Form, Theme } from '@rjsf/mui';

import { Theme } from '@rjsf/mui';

import { HelpTooltip } from './HelpTooltip.js';
import { templates as promptTemplates } from './templates.js';
import { widgets as promptWidgets } from './widgets.js';

/** MUI 默认 widgets（与 Theme.widgets 相同，便于宿主统一从本包导入） */
export const widgets = {
  ...(Theme.widgets ?? {}),
  ...promptWidgets,
} as typeof Theme.widgets;

/** MUI 默认 templates */
export const templates = {
  ...(Theme.templates ?? {}),
  ...promptTemplates,
} as typeof Theme.templates;

export { HelpTooltip };
export type { HelpTooltipProps } from './HelpTooltip.js';
export { DEFAULT_PROMPT_EDITOR_LABELS, resolvePromptEditorLabels } from './labels.js';
export type { PromptEditorLabels } from './labels.js';
import type { TemplatesType, WidgetProps } from '@rjsf/utils';
import { templates as _promptEditorTemplates } from './templates.js';
const _promptEditorTemplatesTyped: Partial<TemplatesType> = _promptEditorTemplates;
export { _promptEditorTemplatesTyped as promptEditorTemplates };
import type { ComponentType } from 'react';
import { widgets as _promptEditorWidgets } from './widgets.js';
const _promptEditorWidgetsTyped: Record<string, ComponentType<WidgetProps>> = _promptEditorWidgets;
export { _promptEditorWidgetsTyped as promptEditorWidgets };

export {
  ArrayItemProvider,
  attachPromptPathAnnotations,
  buildUiSchema,
  ConditionalField,
  getSchemaFromDefinition,
  shouldShowConditionalField,
  useArrayItemContext,
} from '../core/index.js';
export type { ArrayItemContextValue, ArrayItemProviderProps, ConditionalFieldConfig, DefinitionWithPromptSchema, ExtendedFormContext, SchemaWithUiSchema } from '../core/index.js';
