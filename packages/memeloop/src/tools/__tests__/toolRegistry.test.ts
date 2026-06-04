import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  defineTool: vi.fn((def: any) => ({
    tool: vi.fn(),
    toolId: def.toolId,
    configSchema: def.configSchema,
    llmToolSchemas: def.llmToolSchemas,
    displayName: def.displayName ?? def.toolId,
    description: def.description ?? '',
  })),
  registerToolParameterSchema: vi.fn(),
}));

vi.mock('../defineTool.js', () => ({
  defineTool: (def: any) => mocks.defineTool(def),
}));

vi.mock('../schemaRegistry.js', () => ({
  registerToolParameterSchema: (...args: any[]) => mocks.registerToolParameterSchema(...args),
}));

import { getAllToolDefinitions, getToolDefinition, registerToolDefinition } from '../toolRegistry.js';

describe('toolRegistry', () => {
  it('registerToolDefinition registers definition and schema metadata', () => {
    const def = registerToolDefinition({
      toolId: 't1',
      configSchema: { x: 1 } as any,
      llmToolSchemas: undefined,
      displayName: 'T1',
      description: 'D',
    } as any);

    expect(def.toolId).toBe('t1');
    expect(mocks.registerToolParameterSchema).toHaveBeenCalledWith(
      't1',
      { x: 1 },
      expect.objectContaining({ displayName: 'T1', description: 'D' }),
    );
    expect(getToolDefinition('t1')).toBeTruthy();
    expect(getAllToolDefinitions().has('t1')).toBe(true);
  });
});
