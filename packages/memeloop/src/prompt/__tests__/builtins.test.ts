import { describe, expect, it } from 'vitest';

import { getBuiltinAgentDefinitions } from '../loadBuiltins.js';

describe('built-in agent tool configuration', () => {
  it('ships the default assistant with explicit host agentTools', () => {
    const defaultAgent = getBuiltinAgentDefinitions().find(agent => agent.id === 'memeloop:general-assistant');
    expect(defaultAgent?.agentTools?.map(tool => tool.toolId)).toEqual([
      'workspacesList',
      'wikiSearch',
      'wikiOperation',
      'modelContextProtocol',
      'spawnAgent',
      'askQuestion',
    ]);

    const mcpTool = defaultAgent?.agentTools?.find(tool => tool.toolId === 'modelContextProtocol');
    expect(mcpTool?.parameters?.modelContextProtocolParam).toMatchObject({
      serverUrl: 'http://127.0.0.1:38385/mcp',
      toolListPosition: { targetId: 'builtin-system', position: 'after' },
    });
  });

  it('keeps code assistant tools explicit instead of relying on runtime global injection', () => {
    const codeAgent = getBuiltinAgentDefinitions().find(agent => agent.id === 'memeloop:code-assistant');
    expect(codeAgent?.agentTools?.map(tool => tool.toolId)).toEqual(expect.arrayContaining([
      'wikiSearch',
      'wikiOperation',
      'modelContextProtocol',
      'getErrors',
      'webFetch',
    ]));
  });
});
