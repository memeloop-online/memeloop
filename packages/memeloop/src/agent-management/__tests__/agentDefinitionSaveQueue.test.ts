import { describe, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '../../agent/types.js';
import { createAgentDefinitionSaveQueue } from '../agentDefinitionSaveQueue.js';

const definition: AgentDefinition = { id: 'definition', name: 'Definition', description: 'Definition', systemPrompt: '', tools: [], version: '1' };

describe('agent definition save ordering', () => {
  it('keeps an explicit source apply between earlier and later autosaves', async () => {
    const order: string[] = [];
    let completeFirst!: (value: AgentDefinition) => void;
    const save = vi.fn(async (value: AgentDefinition) => {
      order.push(value.name);
      if (value.name === 'first') return new Promise<AgentDefinition>(resolve => { completeFirst = resolve; });
      return value;
    });
    const queue = createAgentDefinitionSaveQueue(save);
    const first = queue.save({ ...definition, name: 'first' });
    const apply = queue.save(definition, async value => { order.push('apply'); return value; });
    const last = queue.save({ ...definition, name: 'last' });
    await Promise.resolve();
    expect(order).toEqual(['first']);
    completeFirst(definition);
    await Promise.all([first, apply, last]);
    expect(order).toEqual(['first', 'apply', 'last']);
    await queue.waitForIdle();
  });

  it('runs later saves after an earlier write rejects', async () => {
    const queue = createAgentDefinitionSaveQueue(async value => value);
    await expect(queue.save(definition, async () => { throw new Error('write failed'); })).rejects.toThrow('write failed');
    await expect(queue.save(definition)).resolves.toBe(definition);
  });
});
