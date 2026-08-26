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
      'mcpClient',
      'spawnAgent',
      'ask-question',
      'todoWrite',
    ]);

    expect(defaultProfile?.systemPrompt).toContain(
      'Treat the user request as the active goal',
    );
    expect(defaultProfile?.systemPrompt).toContain('Treat every host capability as optional');
    expect(defaultProfile?.systemPrompt).toContain(
      'Never claim that an action succeeded',
    );
    expect(defaultProfile?.version).toBe('1.2.0');
    expect(defaultProfile?.systemPrompt).not.toMatch(/wiki/i);
    expect(defaultProfile?.tools).not.toEqual(
      expect.arrayContaining(['workspacesList', 'wikiSearch', 'wikiOperation']),
    );
    expect(defaultProfile?.systemPrompt).not.toContain('wiki-search');
    expect(defaultProfile?.systemPrompt).not.toContain('manage-todo');
    expect(defaultProfile?.systemPrompt).not.toContain('todoWrite');
    expect(
      defaultProfile?.agentFrameworkConfig?.prompts?.find(
        (prompt) => prompt.id === 'builtin-system',
      )?.text,
    ).toBe(defaultProfile?.systemPrompt);

    const mcpTool = defaultProfile?.agentTools?.find(
      (tool) => tool.toolId === 'mcpClient',
    );
    expect(mcpTool?.parameters?.mcpClientParam).toMatchObject({
      serverUrl: 'http://127.0.0.1:38385/mcp',
      toolListPosition: { targetId: 'builtin-system', position: 'after' },
    });
    expect(
      defaultProfile?.agentTools?.find(tool => tool.toolId === 'ask-question')?.parameters,
    ).toEqual({
      'ask-questionParam': {
        toolListPosition: { targetId: 'builtin-system', position: 'after' },
      },
    });
    expect(defaultProfile?.agentTools?.find(tool => tool.toolId === 'todoWrite')?.parameters).toEqual({
      todoWriteParam: {
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
      'mcpClient',
      'spawnAgent',
      'ask-question',
      'getErrors',
      'webFetch',
    ]);
  });

  it('uses canonical builtin tool ids and matching configuration keys in every profile', () => {
    for (const profile of getBuiltinLoopProfiles()) {
      expect(profile.tools).not.toEqual(
        expect.arrayContaining(['modelContextProtocol', 'askQuestion', 'todo']),
      );
      for (const tool of profile.agentTools ?? []) {
        expect(tool.toolId).not.toMatch(/^(modelContextProtocol|askQuestion|todo)$/);
        expect(Object.keys(tool.parameters ?? {})).toEqual([`${tool.toolId}Param`]);
      }
      for (const plugin of profile.plugins ?? []) {
        const providedToolIds: Record<string, string> = {
          'builtin:mcp-client': 'mcpClient',
          'builtin:mcp-forward': 'mcpForward',
          'builtin:spawn-agent': 'spawnAgent',
          'builtin:ask-question': 'ask-question',
          'builtin:todo-write': 'todoWrite',
        };
        const providedToolId = providedToolIds[plugin.id];
        if (providedToolId) expect(profile.tools).toContain(providedToolId);
      }
    }
  });
});
