import { Autocomplete, TextField } from '@mui/material';
import type { WidgetProps } from '@rjsf/utils';
import React, { useMemo } from 'react';

type EnumOption = {
  label: string;
  value: string | number | boolean;
};

type SchemaWithEnum = {
  enum?: Array<string | number | boolean>;
  enumOptions?: EnumOption[];
};

function TagsWidget(props: WidgetProps): React.JSX.Element {
  const {
    id,
    value = [] as unknown,
    onChange,
    onBlur,
    onFocus,
    disabled,
    readonly,
    required,
    placeholder,
  } = props;

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
    const valueArray = Array.isArray(value) ? (value as string[]) : [];
    return [...new Set([...predefinedTags, ...valueArray])].filter(Boolean);
  }, [predefinedTags, value]);

  const valueArray = Array.isArray(value) ? value : [];

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
      renderInput={(parameters) => (
        <TextField
          {...(parameters as unknown as Record<string, unknown>)}
          placeholder={placeholder || 'Enter tags'}
          required={required}
          size='small'
          helperText='Select or create tags'
        />
      )}
      getOptionLabel={(option) => `${option}`}
      isOptionEqualToValue={(option, valueItem) => `${option}` === `${valueItem}`}
      clearOnBlur
      selectOnFocus
      handleHomeEndKeys
    />
  );
}

function SelectWidget(props: WidgetProps): React.JSX.Element {
  const { id, value, disabled, readonly, required, schema, onChange, onBlur, onFocus } = props;
  const typedSchema = schema as SchemaWithEnum;
  const options = Array.isArray(typedSchema.enumOptions)
    ? typedSchema.enumOptions
    : Array.isArray(typedSchema.enum)
    ? typedSchema.enum.map((enumValue) => ({ value: enumValue, label: String(enumValue) }))
    : [];

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
      {!required && <option value=''>None</option>}
      {options.map((option, index) => (
        <option key={`${option.value}-${index}`} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </TextField>
  );
}

export const widgets: Record<string, React.ComponentType<WidgetProps>> = {
  TagsWidget,
  SelectWidget,
};
