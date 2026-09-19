import { Autocomplete, TextField } from '@mui/material';
import type { RegistryWidgetsType, WidgetProps } from '@rjsf/utils';
import React, { useMemo } from 'react';

import { type PromptEditorLabels, resolvePromptEditorLabels } from './labels.js';

type EnumOption = {
  label: string;
  value: string | number | boolean;
};

function readPromptEditorLabels(formContext: unknown): Partial<PromptEditorLabels> | undefined {
  if (formContext === null || typeof formContext !== 'object') return undefined;
  const labels: unknown = Reflect.get(formContext, 'promptEditorLabels');
  return labels !== null && typeof labels === 'object'
    ? labels as Partial<PromptEditorLabels>
    : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readEnumOptions(schema: WidgetProps['schema']): EnumOption[] {
  const rawOptions: unknown = Reflect.get(schema, 'enumOptions');
  if (Array.isArray(rawOptions)) {
    return rawOptions.flatMap(option => {
      if (option === null || typeof option !== 'object') return [];
      const label: unknown = Reflect.get(option, 'label');
      const value: unknown = Reflect.get(option, 'value');
      return typeof label === 'string' && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        ? [{ label, value }]
        : [];
    });
  }
  const rawEnum: unknown = Reflect.get(schema, 'enum');
  return Array.isArray(rawEnum)
    ? rawEnum.flatMap(value =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? [{ value, label: String(value) }]
        : []
    )
    : [];
}

function TagsWidget(props: WidgetProps): React.JSX.Element {
  const {
    id,
    onChange,
    onBlur,
    onFocus,
    disabled,
    readonly,
    required,
    placeholder,
  } = props;
  const valueArray = readStringArray(props.value);

  const predefinedTags = useMemo(
    () => [
      'SystemPrompt',
      'UserPrompt',
      'AssistantPrompt',
      'Context',
      'Instruction',
      'Example',
      'Template',
      'Dynamic',
      'Static',
      'Important',
      'Optional',
      'Debug',
    ],
    [],
  );

  const allOptions = useMemo(() => {
    return [...new Set([...predefinedTags, ...valueArray])].filter(Boolean);
  }, [predefinedTags, valueArray]);

  const labels = resolvePromptEditorLabels(readPromptEditorLabels(props.formContext));

  return (
    <Autocomplete
      multiple
      id={id}
      options={allOptions}
      value={valueArray}
      disabled={disabled || readonly}
      freeSolo
      onChange={(_event, newValue) => {
        onChange(newValue);
      }}
      onBlur={() => {
        onBlur(id, valueArray);
      }}
      onFocus={() => {
        onFocus(id, valueArray);
      }}
      slotProps={{
        chip: {
          size: 'small',
          variant: 'outlined',
          color: 'primary',
        },
      }}
      renderInput={(parameters) => {
        return (
          <TextField
            {...parameters}
            placeholder={placeholder || labels.tagsPlaceholder}
            required={required}
            size='small'
            helperText={labels.tagsHelperText}
          />
        );
      }}
      getOptionLabel={(option) => option}
      isOptionEqualToValue={(option, valueItem) => option === valueItem}
      clearOnBlur
      selectOnFocus
      handleHomeEndKeys
    />
  );
}

function SelectWidget(props: WidgetProps): React.JSX.Element {
  const { id, disabled, readonly, required, schema, onChange, onBlur, onFocus } = props;
  const value = typeof props.value === 'string' || typeof props.value === 'number' || typeof props.value === 'boolean'
    ? props.value
    : undefined;
  const labels = resolvePromptEditorLabels(readPromptEditorLabels(props.formContext));
  const options = readEnumOptions(schema);

  return (
    <TextField
      id={id}
      select
      fullWidth
      required={required}
      disabled={disabled || readonly}
      value={value ? String(value) : ''}
      onChange={(event) => {
        const newValue = event.target.value;
        onChange(newValue === '' ? undefined : newValue);
      }}
      onBlur={() => {
        onBlur(id, value);
      }}
      onFocus={() => {
        onFocus(id, value);
      }}
      size='small'
    >
      {!required && <option value=''>{labels.noneOption}</option>}
      {options.map((option, index) => (
        <option key={`${option.value}-${index}`} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </TextField>
  );
}

export const widgets = {
  TagsWidget,
  SelectWidget,
} satisfies RegistryWidgetsType;
