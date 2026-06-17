/**
 * PromptConfigForm — reusable RJSF-based prompt configuration form.
 *
 * Wraps @memeloop/react-ui/web Form with shared templates, widgets,
 * and default UI schema.
 *
 * No direct Desktop-store dependency; receives all data via props.
 */

import {
  ArrayItemProvider,
  buildUiSchema,
  Form,
  promptEditorTemplates,
  promptEditorWidgets,
} from "../../web/index.js";
import { Box, CircularProgress, Paper, Typography } from "@mui/material";
import type { IChangeEvent } from "@rjsf/core";
import type {
  ObjectFieldTemplateProps,
  RJSFSchema,
  RJSFValidationError,
  UiSchema,
} from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";
import type { AgentFrameworkConfig } from "memeloop";
import React, { useCallback, useMemo, useState } from "react";

// ─── Types ─────────────────────────────────────────────────────────

export interface PromptConfigFormProps {
  /** JSON Schema for form validation and generation */
  schema?: RJSFSchema;
  /** UI schema for layout customization */
  uiSchema?: Record<string, unknown>;
  /** Initial form data */
  formData?: AgentFrameworkConfig;
  /** Change handler for form data */
  onChange?: (formData: AgentFrameworkConfig) => void;
  /** Error handler for form validation errors */
  onError?: (errors: RJSFValidationError[]) => void;
  /** Whether the form is disabled */
  disabled?: boolean;
  /** Whether to show loading indicator */
  loading?: boolean;
  /** Custom error display component */
  renderError?: React.ComponentType<{ errors: RJSFValidationError[] }>;
  /** Custom no-schema message */
  noSchemaMessage?: string;
  /** Custom no-schema description */
  noSchemaDescription?: string;
}

// ─── Inline error display ──────────────────────────────────────────

function DefaultErrorDisplay({ errors }: { errors: RJSFValidationError[] }) {
  if (errors.length === 0) return null;
  return (
    <Box sx={{ mt: 1 }}>
      {errors.map((err, index) => (
        <Typography key={index} variant="caption" color="error">
          {err.message || err.stack}
        </Typography>
      ))}
    </Box>
  );
}

// ─── Component ─────────────────────────────────────────────────────

export const PromptConfigForm: React.FC<PromptConfigFormProps> = ({
  schema,
  uiSchema: uiSchemaOverride,
  formData,
  onChange,
  onError,
  disabled = false,
  loading = false,
  renderError: ErrorDisplay,
  noSchemaMessage = "Schema not provided",
  noSchemaDescription = "The agent framework does not provide a configuration schema.",
}) => {
  const ErrorComponent = ErrorDisplay ?? DefaultErrorDisplay;
  const [validationErrors, setValidationErrors] = useState<RJSFValidationError[]>([]);

  const resolvedUiSchema = useMemo(() => {
    if (!schema) return undefined;
    const base = buildUiSchema(schema, uiSchemaOverride);
    if (!base || typeof base !== "object") return base;
    return {
      ...base,
      "ui:options": {
        ...((base as Record<string, unknown>)["ui:options"] as Record<string, unknown>),
        label: true,
      },
    } as UiSchema;
  }, [schema, uiSchemaOverride]);

  const templates = useMemo(() => {
    const sharedTemplates = promptEditorTemplates as unknown as {
      ObjectFieldTemplate?: React.ComponentType<ObjectFieldTemplateProps>;
    } & Record<string, unknown>;
    const rootObjectFieldTemplate = (props: ObjectFieldTemplateProps) => {
      const fieldTemplate = sharedTemplates.ObjectFieldTemplate;
      return fieldTemplate
        ? React.createElement(fieldTemplate, props)
        : props.properties[0]?.content ?? <div />;
    };

    return {
      ...sharedTemplates,
      ObjectFieldTemplate: rootObjectFieldTemplate,
    } as unknown as Record<string, unknown>;
  }, []);

  const handleError = useCallback(
    (errors: RJSFValidationError[]) => {
      setValidationErrors(errors);
      onError?.(errors);
    },
    [onError],
  );

  const handleChange = useCallback(
    (changeEvent: IChangeEvent<AgentFrameworkConfig>) => {
      const data = changeEvent.formData;
      if (data) onChange?.(data);
    },
    [onChange],
  );

  const formContext = useMemo(
    () => ({ rootFormData: formData, onFormDataChange: onChange }),
    [formData, onChange],
  );

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
        <CircularProgress size={40} />
      </Box>
    );
  }

  if (!schema || Object.keys(schema).length === 0) {
    return (
      <Box sx={{ width: "100%" }}>
        <Paper
          elevation={0}
          sx={{
            p: 2,
            mb: 2,
            bgcolor: "background.paper",
            borderRadius: 1,
            border: "1px solid",
            borderColor: "error.main",
          }}
        >
          <Typography variant="h6" color="error" gutterBottom>
            {noSchemaMessage}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {noSchemaDescription}
          </Typography>
        </Paper>
      </Box>
    );
  }

  const SharedForm = Form as unknown as React.ComponentType<{
    schema: RJSFSchema;
    uiSchema?: UiSchema;
    formData?: AgentFrameworkConfig;
    formContext?: Record<string, unknown>;
    validator: typeof validator;
    onChange?: (event: IChangeEvent<AgentFrameworkConfig>) => void;
    onError?: (errors: RJSFValidationError[]) => void;
    disabled?: boolean;
    templates?: Record<string, unknown>;
    widgets?: Record<string, unknown>;
    showErrorList?: boolean;
    liveValidate?: "onChange";
    noHtml5Validate?: boolean;
    children?: React.ReactNode;
  }>;

  return (
    <ArrayItemProvider isInArrayItem={false} arrayItemCollapsible={false} itemData={undefined} itemIndex={0} arrayFieldPath={""} arrayFieldPathSegments={undefined}>
      <Box data-testid="prompt-config-form">
        <SharedForm
          schema={schema}
          uiSchema={resolvedUiSchema}
          formData={formData}
          formContext={formContext}
          validator={validator}
          onChange={handleChange}
          onError={handleError}
          disabled={disabled}
          templates={templates as Record<string, unknown>}
          widgets={promptEditorWidgets as unknown as Record<string, unknown>}
          showErrorList={false}
          liveValidate="onChange"
          noHtml5Validate
        >
          <div />
        </SharedForm>
        <ErrorComponent errors={validationErrors} />
      </Box>
    </ArrayItemProvider>
  );
};
