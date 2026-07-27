import { createManagedToolDescriptors } from 'memeloop';
import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../toolRegistry.js';

describe('ToolRegistry', () => {
  it('applies blocklist/allowlist for getTool and listTools', () => {
    const r = new ToolRegistry({ allowlist: ['a'], blocklist: ['b'] });
    r.registerTool('a', 1);
    r.registerTool('b', 2);
    r.registerTool('c', 3);

    // blocklist branch in getTool()
    expect(r.getTool('b')).toBeUndefined();

    // Catalog visibility must apply both lists, just like getTool().
    expect(r.listTools()).toEqual(['a']);
    expect(r.getTool('c')).toBeUndefined();
  });

  it('filters by allowlist when blocklist is empty', () => {
    const r = new ToolRegistry({ allowlist: ['b', 'c'], blocklist: [] });
    r.registerTool('a', 1);
    r.registerTool('b', 2);
    r.registerTool('c', 3);

    // allowlist branch in getTool()
    expect(r.getTool('a')).toBeUndefined();

    // allowlist branch in listTools()
    expect(r.listTools().sort()).toEqual(['b', 'c']);
  });

  it('never advertises tools outside the effective permission intersection', async () => {
    const r = new ToolRegistry({
      allowlist: ['allowed', 'blocked'],
      blocklist: ['blocked'],
    });
    const schema = {
      type: 'object',
      properties: {},
      additionalProperties: false,
    } as const;
    r.registerTool('allowed', 1, schema);
    r.registerTool('blocked', 2, schema);
    r.registerTool('unlisted', 3, schema);

    const descriptors = await createManagedToolDescriptors(r, 'permission-node');
    expect(new Set(descriptors.map((descriptor) => descriptor.name))).toEqual(
      new Set(['allowed']),
    );
    expect(descriptors).toHaveLength(6);
  });
});
