/**
 * RJSF custom field: show/hide based on ui:condition (sibling field values).
 * Platform-agnostic: only depends on React and @rjsf/utils.
 */

import type { FieldProps } from "@rjsf/utils";
import React, { useMemo } from "react";
import { shouldShowConditionalField } from "./conditionVisibility.js";
import type { ConditionalFieldConfig } from "./conditionVisibility.js";

/** Form context shape expected by ConditionalField (root form data for path resolution) */
export interface ExtendedFormContext {
  rootFormData?: Record<string, unknown>;
}

/** RJSF 5/6: path may be in id or fieldPathId.$id */
function getFieldPath(props: FieldProps): string | undefined {
  const { id } = props;
  if (id && typeof id === "string") return id;
  const fp = (props as { fieldPathId?: { $id?: string } }).fieldPathId;
  return fp?.$id;
}

export function ConditionalField(props: FieldProps): React.ReactElement | null {
  const { uiSchema, registry } = props;

  const condition = uiSchema?.["ui:condition"] as ConditionalFieldConfig | undefined;
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
  const { "ui:field": _removed, ...cleanUiSchema } = uiSchema ?? {};

  return <SchemaField {...props} uiSchema={cleanUiSchema} />;
}
