/**
 * RJSF custom field: show/hide based on ui:condition (sibling field values).
 * Platform-agnostic: only depends on React and @rjsf/utils.
 */

import type { FieldProps } from '@rjsf/utils';
import React, { useMemo } from 'react';
import { shouldShowConditionalField } from './conditionVisibility.js';
import type { ConditionalFieldConfig, RjsfFieldPath } from './conditionVisibility.js';

/** Form context shape expected by ConditionalField (root form data for path resolution) */
export interface ExtendedFormContext {
  rootFormData?: Record<string, unknown>;
}

/** RJSF's public `fieldPathId.path` is the canonical field path. */
function getFieldPath(props: FieldProps): RjsfFieldPath | undefined {
  return Array.isArray(props.fieldPathId?.path) ? props.fieldPathId.path : undefined;
}

export function ConditionalField(props: FieldProps): React.ReactElement | null {
  const { uiSchema, registry } = props;

  const condition = uiSchema?.['ui:condition'] as ConditionalFieldConfig | undefined;
  const formContext = registry.formContext as ExtendedFormContext | undefined;
  const rootFormData = formContext?.rootFormData;
  const fieldPath = getFieldPath(props);

  const shouldShow = useMemo(
    () =>
      shouldShowConditionalField(
        condition,
        rootFormData,
        fieldPath,
      ),
    [condition, rootFormData, fieldPath],
  );

  if (!shouldShow) {
    return null;
  }

  const { SchemaField } = registry.fields;
  const { 'ui:field': _removed, ...cleanUiSchema } = uiSchema ?? {};

  return <SchemaField {...props} uiSchema={cleanUiSchema} />;
}
