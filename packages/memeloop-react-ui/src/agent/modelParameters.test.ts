import type { ModelCatalogModel } from 'memeloop';
import { describe, expect, it } from 'vitest';
import { getModelParameterFields, updateModelParameter } from './modelParameters.js';

const model: ModelCatalogModel = {
  id: 'model',
  name: 'Model',
  attachment: false,
  reasoning: true,
  toolCall: true,
  reasoningEfforts: ['minimal', 'high'],
  temperature: true,
  limit: { output: 12345 },
};

describe('model parameters', () => {
  it('uses exactly the selected model capabilities and advertised output limit', () => {
    expect(getModelParameterFields(model)).toEqual([
      { key: 'reasoningEffort', options: ['minimal', 'high'] },
      { key: 'temperature', min: 0, max: 2, step: 0.1 },
      { key: 'maxOutputTokens', min: 1, max: 12345, step: 1 },
    ]);
    expect(getModelParameterFields({ ...model, reasoningEfforts: ['medium'] })[0])
      .toEqual({ key: 'reasoningEffort', options: ['medium'] });
  });
  it('omits unknown and unavailable optional controls', () => {
    expect(getModelParameterFields()).toEqual([]);
    expect(getModelParameterFields({
      id: 'unknown',
      name: 'Unknown',
      attachment: false,
      toolCall: false,
      reasoning: true,
    })).toEqual([]);
    expect(getModelParameterFields({ ...model, reasoning: false, temperature: false, limit: {} })).toEqual([]);
  });
  it('preserves unrelated parameters when editing or clearing one setting', () => {
    const value = { topP: 0.9, temperature: 0.7, reasoningEffort: 'high' as const };
    const field = getModelParameterFields(model)[0];
    expect(updateModelParameter(value, field, 'minimal')).toEqual({ ...value, reasoningEffort: 'minimal' });
    expect(updateModelParameter(value, field, '')).toEqual({ topP: 0.9, temperature: 0.7 });
    expect(updateModelParameter(value, field, 'medium')).toBe(value);
  });
  it('rejects numeric values outside the canonical range or model output allowance', () => {
    const value = { topP: 0.9 };
    const fields = getModelParameterFields(model);
    expect(updateModelParameter(value, fields[2], '12346')).toBe(value);
    expect(updateModelParameter(value, fields[2], '1.5')).toBe(value);
    expect(updateModelParameter(value, fields[2], '8192')).toEqual({ ...value, maxOutputTokens: 8192 });
    expect(updateModelParameter(value, fields[1], 'NaN')).toBe(value);
  });
});
