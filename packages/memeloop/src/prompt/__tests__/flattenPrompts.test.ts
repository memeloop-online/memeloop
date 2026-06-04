import { describe, expect, it } from 'vitest';

import { flattenPrompts } from '../promptConcat.js';
import type { PromptNode } from '../types.js';

describe('flattenPrompts', () => {
  it('flattens simple prompt tree into model messages', () => {
    const prompts: PromptNode[] = [
      {
        id: 'root',
        role: 'system',
        text: 'You are an assistant.',
        children: [
          { id: 'child1', text: 'Please help the user.' },
          { id: 'child2', role: 'user', text: 'Hello' },
        ],
      },
    ];

    const result = flattenPrompts(prompts);
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toContain('You are an assistant.');
    expect(result[1].role).toBe('system');
    expect(result[1].content).toBe('Please help the user.');
    expect(result[2].role).toBe('user');
    expect(result[2].content).toBe('Hello');
  });
});
