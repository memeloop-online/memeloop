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

    // blocklist branch in listTools()
    expect(r.listTools().sort()).toEqual(['a', 'c']);
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
});
