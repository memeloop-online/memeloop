import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RJSFSchema } from '@rjsf/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
          id: { type: 'string', title: 'ID' },
          text: { type: 'string', title: 'Text' },
          children: {
            type: 'array',
            title: 'Children',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', title: 'ID' },
                text: { type: 'string', title: 'Text' },
              },
            },
          },
        },
      },
    },
  },
};

describe('PromptConfigForm array controls', () => {
  it('forwards prompt-editor labels to array templates', () => {
    render(
      <PromptConfigForm
        schema={schema}
        formData={{ prompts: [{ id: 'system', text: 'System prompt' }], plugins: [] }}
        promptEditorLabels={{
          arrayItem: (_title, index) => `項目 ${index + 1}`,
          expandArrayItem: '展開',
          collapseArrayItem: '折りたたむ',
        }}
      />,
    );

    const toggle = screen.getByTestId('prompt-array-item-toggle-0');
    expect(toggle).toHaveAttribute('title', '展開');
    expect(screen.getByText('項目 1')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('title', '折りたたむ');
  });

  it('exposes a stable toggle target and expansion state', () => {
    render(
      <PromptConfigForm
        schema={schema}
        formData={{ prompts: [{ id: 'system', text: 'System prompt' }], plugins: [] }}
      />,
    );

    const toggle = screen.getByTestId('prompt-array-item-toggle-0');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByDisplayValue('System prompt')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByDisplayValue('System prompt')).toBeInTheDocument();
  });

  it('reveals and focuses an ID-selected top-level item without host DOM polling', async () => {
    const onFieldReveal = vi.fn();
    render(
      <PromptConfigForm
        schema={schema}
        formData={{ prompts: [{ id: 'system', text: 'System prompt' }], plugins: [] }}
        formFieldsToScrollTo={['prompts', 'system']}
        onFieldReveal={onFieldReveal}
      />,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('System prompt')).toBeInTheDocument();
      expect(onFieldReveal).toHaveBeenCalledWith(['prompts', 'system']);
    });
    expect(screen.getByDisplayValue('system')).toHaveFocus();
  });

  it('reveals nested ID-selected children one array level at a time', async () => {
    const onFieldReveal = vi.fn();
    render(
      <PromptConfigForm
        schema={schema}
        formData={{
          prompts: [{
            id: 'system',
            text: 'System prompt',
            children: [{ id: 'constraints', text: 'Nested constraint' }],
          }],
          plugins: [],
        }}
        formFieldsToScrollTo={['prompts', 'system', 'constraints']}
        onFieldReveal={onFieldReveal}
      />,
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue('Nested constraint')).toBeInTheDocument();
      expect(onFieldReveal).toHaveBeenCalledWith(['prompts', 'system', 'constraints']);
    });
    expect(screen.getByDisplayValue('constraints')).toHaveFocus();
  });
});

afterEach(() => {
  cleanup();
});
