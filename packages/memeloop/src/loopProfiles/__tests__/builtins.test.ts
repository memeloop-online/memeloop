import { describe, expect, it } from 'vitest';

import { getBuiltinLoopProfiles } from '../loadBuiltins.js';

describe('built-in loop profile tool configuration', () => {
  it('ships the default assistant with explicit host agentTools', () => {
    const defaultProfile = getBuiltinLoopProfiles().find(
      (p) => p.id === 'memeloop:general-assistant',
    );
    expect(defaultProfile?.plugins?.map((plugin) => plugin.id)).toEqual([
      'builtin:mcp-client',
      'builtin:mcp-forward',
      'builtin:spawn-agent',
      'builtin:ask-question',
      'builtin:todo-write',
    ]);
    expect(defaultProfile?.agentTools?.map((tool) => tool.toolId)).toEqual([
      'workspacesList',
      'wikiSearch',
      'wikiOperation',
      'modelContextProtocol',
      'spawnAgent',
      'askQuestion',
      'todo',
    ]);

    expect(defaultProfile?.systemPrompt).toContain(
      'Treat the user request as the active goal',
    );
    expect(defaultProfile?.systemPrompt).toContain('[title[Exact Title]]');
    expect(defaultProfile?.systemPrompt).toContain(
      'Never claim that an action succeeded',
    );

    const mcpTool = defaultProfile?.agentTools?.find(
      (tool) => tool.toolId === 'modelContextProtocol',
    );
    expect(mcpTool?.parameters?.modelContextProtocolParam).toMatchObject({
      serverUrl: 'http://127.0.0.1:38385/mcp',
      toolListPosition: { targetId: 'builtin-system', position: 'after' },
    });
    expect(defaultProfile?.agentTools?.find(tool => tool.toolId === 'todo')?.parameters).toEqual({
      todoParam: {
        toolListPosition: { targetId: 'builtin-system', position: 'after' },
        todoInjectionTargetId: 'builtin-system',
        toolResultDuration: 1,
      },
    });
  });

  it('keeps code assistant tools explicit instead of relying on runtime global injection', () => {
    const codeProfile = getBuiltinLoopProfiles().find((p) => p.id === 'memeloop:code-assistant');
    expect(codeProfile?.plugins?.map((plugin) => plugin.id)).toEqual(
      expect.arrayContaining([
        'builtin:mcp-client',
        'builtin:mcp-forward',
        'builtin:spawn-agent',
        'builtin:ask-question',
      ]),
    );
    expect(codeProfile?.agentTools?.map((tool) => tool.toolId)).toEqual([
      'workspacesList',
      'modelContextProtocol',
      'spawnAgent',
      'askQuestion',
      'getErrors',
      'webFetch',
    ]);
  });
});
