import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ModelCatalogModel } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';
import { ModelParameterFields } from './ModelParameterFields.js';

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
    expect(options.map(option => option.textContent)).toEqual(['Model default', 'low', 'high']);
    fireEvent.click(within(screen.getByRole('listbox')).getByText('low'));
    expect(onChange).toHaveBeenCalledWith({ topP: 0.8, reasoningEffort: 'low' });
  });
});
