import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ModelCatalogModel } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';
import { ModelParameterFields } from './ModelParameterFields.js';
import { getReasoningEffortLabels } from './modelParameters.js';

const model: ModelCatalogModel = {
  id: 'custom',
  name: 'Custom',
  reasoning: true,
  toolCall: true,
  attachment: false,
  reasoningEfforts: ['low', 'high'],
};

describe('ModelParameterFields', () => {
  it('offers only model-supported effort choices and preserves other values', () => {
    const onChange = vi.fn();
    render(<ModelParameterFields model={model} value={{ topP: 0.8, reasoningEffort: 'high' }} onChange={onChange} />);
    expect(screen.queryByLabelText('Temperature')).toBeNull();
    expect(screen.queryByLabelText('Maximum output tokens')).toBeNull();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Reasoning effort' }));
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map(option => option.textContent)).toEqual(['Model default', 'Low', 'High']);
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Low'));
    expect(onChange).toHaveBeenCalledWith({ topP: 0.8, reasoningEffort: 'low' });
  });
});

it('localizes supported options without changing submitted values', () => {
  const onChange = vi.fn();
  render(<ModelParameterFields model={model} value={{}} onChange={onChange} reasoningEffortLabels={getReasoningEffortLabels('zh-Hans')} />);
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Reasoning effort' }));
  const listbox = within(screen.getByRole('listbox'));
  expect(listbox.getAllByRole('option').map(option => option.textContent)).toEqual(['Model default', '低', '高']);
  fireEvent.click(listbox.getByText('高'));
  expect(onChange).toHaveBeenCalledWith({ reasoningEffort: 'high' });
});

it.each([
  ['en-US', 'High'],
  ['zh_CN', '高'],
  ['zh-TW', '高'],
  ['JA-jp', '高'],
  ['fr-FR', 'Élevé'],
  ['ru_RU', 'Высокий'],
  ['unknown', 'High'],
])('resolves effort labels for %s', (locale, high) => {
  expect(getReasoningEffortLabels(locale).high).toBe(high);
});
