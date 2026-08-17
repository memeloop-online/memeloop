import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RJSFSchema } from '@rjsf/utils';
import { describe, expect, it } from 'vitest';

import { PromptConfigForm } from '../agent/prompts/PromptConfigForm';

const schema: RJSFSchema = {
  type: 'object',
  properties: {
    prompts: {
      type: 'array',
      title: 'Prompts',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', title: 'Text' },
        },
      },
    },
  },
};

describe('PromptConfigForm array controls', () => {
  it('exposes a stable toggle target and expansion state', () => {
    render(
      <PromptConfigForm
        schema={schema}
        formData={{ prompts: [{ text: 'System prompt' }] }}
      />,
    );

    const toggle = screen.getByTestId('prompt-array-item-toggle-0');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByDisplayValue('System prompt')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByDisplayValue('System prompt')).toBeInTheDocument();
  });
});
