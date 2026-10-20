import { MenuItem, Stack, TextField, Typography } from '@mui/material';
import { defaultModelParameterLabels, getModelParameterFields, type ModelParameterFieldsProps, updateModelParameter } from './modelParameters.js';

/** Controlled fields: the host owns the conversation and persistence lifecycle. */
export function ModelParameterFields({ model, value, onChange, disabled, labels: overrides }: ModelParameterFieldsProps) {
  const labels = { ...defaultModelParameterLabels, ...overrides };
  const fields = getModelParameterFields(model);
  return (
    <Stack spacing={2}>
      {fields.length === 0 && <Typography color='text.secondary'>{labels.unavailable}</Typography>}
      {fields.map(field =>
        field.key === 'reasoningEffort'
          ? (
            <TextField
              key={field.key}
              select
              fullWidth
              label={labels[field.key]}
              value={field.options.includes(value.reasoningEffort!) ? value.reasoningEffort : ''}
              disabled={disabled}
              onChange={event => {
                onChange(updateModelParameter(value, field, event.target.value));
              }}
            >
              <MenuItem value=''>{labels.defaultValue}</MenuItem>
              {field.options.map(option => <MenuItem key={option} value={option}>{option}</MenuItem>)}
            </TextField>
          )
          : (
            <TextField
              key={field.key}
              fullWidth
              type='number'
              label={labels[field.key]}
              placeholder={labels.defaultValue}
              value={value[field.key] ?? ''}
              disabled={disabled}
              slotProps={{ htmlInput: { min: field.min, max: field.max, step: field.step } }}
              onChange={event => {
                onChange(updateModelParameter(value, field, event.target.value));
              }}
            />
          )
      )}
    </Stack>
  );
}
