import { describe, expect, it } from 'vitest';

import { getBuiltinLoopProfiles } from '../loadBuiltins.js';

describe('built-in loop profile tool configuration', () => {
  it('ships the default assistant with explicit host agentTools', () => {
    const defaultProfile = getBuiltinLoopProfiles().find(p => p.id === 'memeloop:general-assistant');
    expect(defaultProfile?.agentTools?.map(tool => tool.toolId)).toEqual([
      'workspacesList',
      'wikiSearch',
      'wikiOperation',
      'modelContextProtocol',
      'spawnAgent',
      'askQuestion',
    ]);

    const mcpTool = defaultProfile?.agentTools?.find(tool => tool.toolId === 'modelContextProtocol');
    expect(mcpTool?.parameters?.modelContextProtocolParam).toMatchObject({
      serverUrl: 'http://127.0.0.1:38385/mcp',
      toolListPosition: { targetId: 'builtin-system', position: 'after' },
    });
  });

  it('keeps code assistant tools explicit instead of relying on runtime global injection', () => {
    const codeProfile = getBuiltinLoopProfiles().find(p => p.id === 'memeloop:code-assistant');
    expect(codeProfile?.agentTools?.map(tool => tool.toolId)).toEqual(expect.arrayContaining([
      'wikiSearch',
      'wikiOperation',
      'modelContextProtocol',
      'getErrors',
      'webFetch',
    ]));
  });
});
