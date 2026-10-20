import { View } from 'react-native';
import { Button, Text, TextInput } from 'react-native-paper';
import { defaultModelParameterLabels, getModelParameterFields, type ModelParameterFieldsProps, updateModelParameter } from '../agent/modelParameters.js';

export function NativeModelParameterFields({ model, value, onChange, disabled, labels: overrides }: ModelParameterFieldsProps) {
  const labels = { ...defaultModelParameterLabels, ...overrides };
  const fields = getModelParameterFields(model);
  return (
    <View style={{ gap: 12 }}>
      {fields.length === 0 && <Text>{labels.unavailable}</Text>}
      {fields.map(field =>
        field.key === 'reasoningEffort'
          ? (
            <View key={field.key} style={{ gap: 4 }}>
              <Text>{labels[field.key]}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                {['', ...field.options].map(option => (
                  <Button
                    key={option}
                    mode={(value.reasoningEffort ?? '') === option ? 'contained' : 'outlined'}
                    disabled={disabled}
                    onPress={() => {
                      onChange(updateModelParameter(value, field, option));
                    }}
                  >
                    {option || labels.defaultValue}
                  </Button>
                ))}
              </View>
            </View>
          )
          : (
            <TextInput
              key={field.key}
              label={labels[field.key]}
              placeholder={labels.defaultValue}
              keyboardType='numeric'
              value={value[field.key]?.toString() ?? ''}
              disabled={disabled}
              onChangeText={raw => {
                onChange(updateModelParameter(value, field, raw));
              }}
            />
          )
      )}
    </View>
  );
}
