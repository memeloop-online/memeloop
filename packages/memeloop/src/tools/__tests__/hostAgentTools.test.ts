import { describe, expect, it } from 'vitest';

import { registerBuiltinLoops } from '../../loopAPI/plugins/builtinLoopsPlugin.js';
import { LoopRegistryImpl } from '../../loopAPI/registry.js';
import type { AgentLoopStep, LoopProfile } from '../../loopAPI/types.js';
import type { AgentFrameworkConfig } from '../../promptUtilities/types.js';
import { mergeAgentToolsIntoFrameworkConfig } from '../hostAgentTools.js';

describe('mergeAgentToolsIntoFrameworkConfig', () => {
  it.each(
    [
      undefined,
      { prompts: [], plugins: [] },
      { prompts: [], plugins: [], response: undefined },
    ] satisfies Array<AgentFrameworkConfig | undefined>,
  )('runs an MJS profile after merging optional response config %j', async frameworkConfig => {
    const config = mergeAgentToolsIntoFrameworkConfig(frameworkConfig, []);
    expect(Object.hasOwn(config, 'response')).toBe(false);
    expect(config).toEqual({ prompts: [], plugins: [] });
    const profile: LoopProfile = {
      id: 'merged-script',
      name: 'Merged script',
      description: 'Merged framework config',
      loopId: 'agent-agent-loop',
      tools: [],
      agentFrameworkConfig: config,
      scriptReference: { kind: 'source', source: 'export default function run(ctx) { ctx.finish("merged-script-result"); }' },
    };
    const registry = new LoopRegistryImpl();
    registerBuiltinLoops(registry);
    registry.registerProfile(profile);
    const runner = registry.createRunnerForProfile(profile, {
      scriptPolicy: { allowSource: true, scriptLoadGate: { admitScriptLoad: () => ({ allowed: true }) } },
    });
    expect(runner).toBeTypeOf('function');
    const steps: AgentLoopStep[] = [];
    for await (const step of runner!({ conversationId: 'merged-conversation', message: 'Run merged script' })) steps.push(step);
    expect(steps).toContainEqual({ type: 'message', data: 'merged-script-result' });
  });

  it('preserves an explicit response pipeline and its input configuration', () => {
    const response = [{ id: 'response-template', type: 'text' as const, text: 'Result' }];
    const config = { prompts: [], plugins: [], response };
    const merged = mergeAgentToolsIntoFrameworkConfig(config, []);
    expect(merged.response).toBe(response);
    expect(config).toEqual({ prompts: [], plugins: [], response });
    expect(mergeAgentToolsIntoFrameworkConfig({ prompts: [], plugins: [], response: [] }, []).response).toEqual([]);
  });

  it('merges agentTools into existing framework plugins without dropping prompt modifiers', () => {
    const config = mergeAgentToolsIntoFrameworkConfig(
      {
        prompts: [{ id: 'builtin-system', role: 'system', text: 'hello' }],
        plugins: [
          { id: 'fullReplacement-default', toolId: 'fullReplacement' },
          { id: 'wikiSearch-default', toolId: 'wikiSearch', wikiSearchParam: { sourceType: 'old' } },
        ],
        response: [],
      },
      [
        {
          toolId: 'wikiSearch',
          parameters: {
            wikiSearchParam: {
              sourceType: 'wiki',
              toolListPosition: { targetId: 'builtin-system', position: 'after' },
            },
          },
        },
        {
          toolId: 'modelContextProtocol',
          parameters: {
            modelContextProtocolParam: {
              serverUrl: 'http://127.0.0.1:38385/mcp',
            },
          },
        },
      ],
    );

    expect(config.plugins).toEqual([
      { id: 'fullReplacement-default', toolId: 'fullReplacement' },
      {
        id: 'wikiSearch-agent-tool',
        toolId: 'wikiSearch',
        enabled: true,
        wikiSearchParam: {
          sourceType: 'wiki',
          toolListPosition: { targetId: 'builtin-system', position: 'after' },
        },
      },
      {
        id: 'modelContextProtocol-agent-tool',
        toolId: 'modelContextProtocol',
        enabled: true,
        modelContextProtocolParam: {
          serverUrl: 'http://127.0.0.1:38385/mcp',
        },
      },
    ]);
  });
});
