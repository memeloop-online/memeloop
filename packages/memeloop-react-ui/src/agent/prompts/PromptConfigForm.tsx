/**
 * PromptConfigForm — reusable RJSF-based prompt configuration form.
 *
 * Wraps @memeloop/react-ui/web Form with shared templates, widgets,
 * and default UI schema.
 *
 * No direct Desktop-store dependency; receives all data via props.
 */

import { Box, CircularProgress, Paper, Typography } from '@mui/material';
import type { IChangeEvent } from '@rjsf/core';
import type { ObjectFieldTemplateProps, RJSFSchema, RJSFValidationError, TemplatesType, UiSchema } from '@rjsf/utils';
import validator from '@rjsf/validator-ajv8';
import type { AgentFrameworkConfig } from 'memeloop';
import React, { useCallback, useMemo, useState } from 'react';
import { ArrayItemProvider, buildUiSchema, Form, type PromptEditorLabels, promptEditorTemplates, promptEditorWidgets, resolvePromptEditorLabels } from '../../web/index.js';

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
  /** Field path requested by the host for tab switching / scrolling. */
  formFieldsToScrollTo?: string[];
  /** Called after the exact ID-backed array item is visible and focused. */
  onFieldReveal?: (fieldPath: string[]) => void;
  /** Custom error display component */
  renderError?: React.ComponentType<{ errors: RJSFValidationError[] }>;
  /** Custom no-schema message */
  noSchemaMessage?: string;
  /** Custom no-schema description */
  noSchemaDescription?: string;
  validationErrorMessage?: string;
  formatValidationError?: (error: RJSFValidationError) => string;
  /** Labels forwarded to the shared RJSF widgets and templates. */
  promptEditorLabels?: Partial<PromptEditorLabels>;
}

interface PromptConfigFormContext extends Record<string, unknown> {
  rootFormData?: AgentFrameworkConfig;
  onFormDataChange?: (formData: AgentFrameworkConfig) => void;
  formFieldsToScrollTo?: string[];
  onFieldReveal?: (fieldPath: string[]) => void;
  promptEditorLabels: PromptEditorLabels;
}

// ─── Inline error display ──────────────────────────────────────────

function DefaultErrorDisplay({ errors, message, format }: { errors: RJSFValidationError[]; message: string; format?: (error: RJSFValidationError) => string }) {
  if (errors.length === 0) return null;
  return (
    <Box sx={{ mt: 1 }}>
      {errors.map((error, index) => (
        <Typography key={index} variant='caption' color='error'>
          {format?.(error) ?? message}
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
  formFieldsToScrollTo,
  onFieldReveal,
  renderError: ErrorDisplay,
  noSchemaMessage = 'Schema not provided',
  noSchemaDescription = 'The agent framework does not provide a configuration schema.',
  validationErrorMessage = 'A configuration value is invalid.',
  formatValidationError,
  promptEditorLabels,
}) => {
  const [validationErrors, setValidationErrors] = useState<RJSFValidationError[]>([]);

  const resolvedUiSchema = useMemo(() => {
    if (!schema) return undefined;
    const base = buildUiSchema(schema, uiSchemaOverride);
    if (!base || typeof base !== 'object') return base;
    return {
      ...base,
      'ui:options': {
        ...((base as Record<string, unknown>)['ui:options'] as Record<string, unknown>),
        label: true,
      },
    } as UiSchema;
  }, [schema, uiSchemaOverride]);

  const templates = useMemo(() => {
    const sharedTemplates: Partial<TemplatesType> = promptEditorTemplates;
    const rootObjectFieldTemplate = (props: ObjectFieldTemplateProps) => {
      const fieldTemplate = sharedTemplates.ObjectFieldTemplate;
      return fieldTemplate
        ? React.createElement(fieldTemplate, props)
        : props.properties[0]?.content ?? <div />;
    };

    const resolvedTemplates: Partial<TemplatesType> = {
      ...sharedTemplates,
      ObjectFieldTemplate: rootObjectFieldTemplate,
    };
    return resolvedTemplates;
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

  const resolvedPromptEditorLabels = useMemo(() => resolvePromptEditorLabels(promptEditorLabels), [promptEditorLabels]);
  const formContext = useMemo<PromptConfigFormContext>(
    () => ({ rootFormData: formData, onFormDataChange: onChange, formFieldsToScrollTo, onFieldReveal, promptEditorLabels: resolvedPromptEditorLabels }),
    [formData, onChange, formFieldsToScrollTo, onFieldReveal, resolvedPromptEditorLabels],
  );

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress size={40} />
      </Box>
    );
  }

  if (!schema || Object.keys(schema).length === 0) {
    return (
      <Box sx={{ width: '100%' }}>
        <Paper
          elevation={0}
          sx={{
            p: 2,
            mb: 2,
            bgcolor: 'background.paper',
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'error.main',
          }}
        >
          <Typography variant='h6' color='error' gutterBottom>
            {noSchemaMessage}
          </Typography>
          <Typography variant='body2' color='text.secondary'>
            {noSchemaDescription}
          </Typography>
        </Paper>
      </Box>
    );
  }

  return (
    <ArrayItemProvider isInArrayItem={false} arrayItemCollapsible={false} itemData={undefined} itemIndex={0} arrayFieldPath={''} arrayFieldPathSegments={undefined}>
      <Box data-testid='prompt-config-form'>
        <Form
          schema={schema}
          uiSchema={resolvedUiSchema}
          formData={formData}
          formContext={formContext}
          validator={validator}
          onChange={handleChange}
          onError={handleError}
          disabled={disabled}
          templates={templates}
          widgets={promptEditorWidgets}
          showErrorList={false}
          liveValidate='onChange'
          noHtml5Validate
        >
          <div />
        </Form>
        {ErrorDisplay
          ? <ErrorDisplay errors={validationErrors} />
          : <DefaultErrorDisplay errors={validationErrors} message={validationErrorMessage} format={formatValidationError} />}
      </Box>
    </ArrayItemProvider>
  );
};
