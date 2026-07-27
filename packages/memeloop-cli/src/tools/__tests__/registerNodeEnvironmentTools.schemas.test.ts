import { createManagedToolDescriptors, registerToolParameterSchema, toolSchemaToJsonSchema } from 'memeloop';
import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../runtime/toolRegistry.js';
import { registerNodeEnvironmentTools } from '../registerNodeEnvironmentTools.js';

describe('default Node environment managed-tool catalog', () => {
  it('registers a portable schema for every model-visible host tool', async () => {
    const registry = new ToolRegistry();
    registerNodeEnvironmentTools(registry, {
      terminalManager: {} as never,
      wikiManager: {} as never,
      includeVscodeCli: true,
      fileBaseDir: '/tmp/memeloop-schema-catalog',
      nodeId: 'schema-node',
    });

    const toolIds = registry.listTools().sort();
    expect(toolIds.length).toBeGreaterThan(30);

    const missingSchemas = toolIds.filter(
      (toolId) => registry.getToolParameterSchema(toolId) === undefined,
    );
    expect(missingSchemas).toEqual([]);

    for (const toolId of toolIds) {
      const schema = toolSchemaToJsonSchema(
        registry.getToolParameterSchema(toolId),
      );
      expect(schema, toolId).toMatchObject({ type: 'object' });
    }

    const descriptors = await createManagedToolDescriptors(
      registry,
      'schema-node',
    );
    expect(descriptors).toHaveLength(toolIds.length * 6);
    expect(
      [...new Set(descriptors.map((descriptor) => descriptor.name))].sort(),
    ).toEqual(toolIds);
    expect(
      descriptors.every((descriptor) => /^sha256:[a-f0-9]{64}$/.test(descriptor.schemaDigest)),
    ).toBe(true);
  });

  it('does not inherit a stale process-global schema for a host registration', async () => {
    registerToolParameterSchema('schema.collision', {
      type: 'object',
      properties: { legacy: { type: 'string' } },
      additionalProperties: false,
    });
    const registry = new ToolRegistry();
    registry.registerTool('schema.collision', async () => 'local');

    expect(registry.getToolParameterSchema('schema.collision')).toBeUndefined();
    await expect(
      createManagedToolDescriptors(registry, 'isolated-node'),
    ).resolves.toEqual([]);

    registry.registerTool('schema.collision', async () => 'local', {
      type: 'object',
      properties: { current: { type: 'string' } },
      additionalProperties: false,
    });
    const descriptors = await createManagedToolDescriptors(
      registry,
      'isolated-node',
    );
    expect(descriptors).toHaveLength(6);
    expect(descriptors[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { current: { type: 'string' } },
      additionalProperties: false,
    });
  });
});
