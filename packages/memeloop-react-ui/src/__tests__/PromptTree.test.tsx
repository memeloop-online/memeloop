import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { PromptNode } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';

import { PromptTree } from '../agent/prompts/PromptTree.js';
import { groupGeneratedToolPrompts } from '../agent/prompts/promptTreePresentation.js';

describe('PromptTree', () => {
  it('toggles a generated-tool presentation group without sending a synthetic editor path', () => {
    const onFieldSelect = vi.fn();
    const prompts: PromptNode[] = [
      { id: 'system', caption: 'System', role: 'system', text: 'system' },
      { id: 'search-tools', caption: 'Search tools', role: 'tool', text: 'search', source: ['plugins', 'search-plugin'] },
      { id: 'wiki-tools', caption: 'Wiki tools', role: 'tool', text: 'wiki', source: ['plugins', 'wiki-plugin'] },
    ];
    render(
      <PromptTree
        prompts={groupGeneratedToolPrompts(prompts, 'Generated tools')}
        onFieldSelect={onFieldSelect}
      />,
    );

    expect(screen.getByText('Search tools')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Generated tools'));
    expect(screen.queryByText('Search tools')).not.toBeInTheDocument();
    expect(onFieldSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Generated tools'));
    fireEvent.click(screen.getByText('Search tools'));
    expect(onFieldSelect).toHaveBeenCalledWith(['plugins', 'search-plugin']);
  });
});
