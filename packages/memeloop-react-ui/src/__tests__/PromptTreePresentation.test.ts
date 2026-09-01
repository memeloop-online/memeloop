import type { PromptNode } from 'memeloop';
import { describe, expect, it } from 'vitest';

import { groupGeneratedToolPrompts } from '../agent/prompts/promptTreePresentation.js';

describe('groupGeneratedToolPrompts', () => {
  it('collects generated plugin prompts under one expandable tool group without changing source paths', () => {
    const prompts: PromptNode[] = [
      { id: 'system', caption: 'System', role: 'system', text: 'system' },
      { id: 'search-tools', caption: 'Search tools', text: 'search', source: ['plugins', 'search-1'] },
      { id: 'rules', caption: 'Rules', text: 'rules' },
      { id: 'wiki-tools', caption: 'Wiki tools', text: 'wiki', source: ['plugins', 'wiki-1'] },
    ];

    const grouped = groupGeneratedToolPrompts(prompts, 'Available tools');

    expect(grouped).toHaveLength(3);
    expect(grouped[1]).toMatchObject({
      id: 'memeloop-generated-tools',
      caption: 'Available tools',
      source: ['plugins'],
      children: [
        expect.objectContaining({ id: 'search-tools', source: ['plugins', 'search-1'] }),
        expect.objectContaining({ id: 'wiki-tools', source: ['plugins', 'wiki-1'] }),
      ],
    });
    expect(grouped[2]).toBe(prompts[2]);
    expect(prompts).toHaveLength(4);
  });

  it('returns the original array when there are no generated tool prompts', () => {
    const prompts: PromptNode[] = [{ id: 'system', role: 'system', text: 'system' }];
    expect(groupGeneratedToolPrompts(prompts, 'Available tools')).toBe(prompts);
  });
});
