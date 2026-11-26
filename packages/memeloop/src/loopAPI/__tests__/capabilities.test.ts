import { describe, expect, it, vi } from 'vitest';
import { createTestStorage } from '../../__tests__/testStorage.js';
import type { AgentDefinition } from '../../agent/types.js';
import { resolveAgentLoopCapabilities } from '../../runtime.js';
import type { AgentFrameworkContext } from '../../types.js';
import { getLoadedScriptMetadata, loadAgentLoopScript } from '../scriptLoader.js';

const policy = { allowSource: true, scriptLoadGate: { admitScriptLoad: async () => ({ allowed: true }) } };
function context(): AgentFrameworkContext {
  return {
    storage: createTestStorage(),
    llmProvider: {
      name: 'test',
      chat: async function*() {
        yield { type: 'finish', finishReason: 'stop' };
      },
    },
    tools: { getTool: () => undefined, listTools: () => [], registerTool: vi.fn() },
    network: { start: vi.fn(), stop: vi.fn() },
    syncAdapters: [],
    loopScriptPolicy: policy,
  };
}
function definition(source: string, loopId = 'agent-tool-loop'): AgentDefinition {
  return { id: 'custom', name: 'Custom', description: 'A workflow', loopId, scriptReference: { kind: 'source', source } };
}

describe('selected MJS workflow capabilities', () => {
  it('reads the default assistant capability from its admitted builtin script', async () => {
    await expect(resolveAgentLoopCapabilities(context(), { definitionId: 'memeloop:general-assistant' })).resolves.toEqual({ goal: true });
  });

  it.each(['agent-tool-loop', 'agent-agent-loop'])('follows live source changes for %s and preserves ordinary execution', async loopId => {
    const ctx = context();
    let selected = definition('export const capabilities = { goal: true }; export default () => "ordinary";', loopId);
    const resolve = vi.fn(async () => selected);
    ctx.resolveAgentDefinition = resolve;
    const options = { definitionId: 'custom', conversationId: 'chat' };
    await expect(resolveAgentLoopCapabilities(ctx, options)).resolves.toEqual({ goal: true });
    expect(resolve).toHaveBeenCalledWith('custom', { conversationId: 'chat' });
    selected = definition('export default () => "ordinary";', loopId);
    await expect(resolveAgentLoopCapabilities(ctx, options)).resolves.toEqual({});
    const script = await loadAgentLoopScript<() => string>(selected.scriptReference!, policy);
    expect(script()).toBe('ordinary');
    selected = definition('export const capabilities = { goal: false }; export default () => "ordinary";', loopId);
    await expect(resolveAgentLoopCapabilities(ctx, options)).resolves.toEqual({ goal: false });
  });

  it('does not infer support from a tool loop without an MJS script', async () => {
    const ctx = context();
    ctx.resolveAgentDefinition = async () => ({ id: 'custom', name: 'Plain', description: 'Plain', loopId: 'agent-tool-loop' });
    await expect(resolveAgentLoopCapabilities(ctx, { definitionId: 'custom' })).resolves.toEqual({});
  });

  it('uses the existing script admission gate before importing a capability declaration', async () => {
    const ctx = context();
    ctx.resolveAgentDefinition = async () => definition('export const capabilities = { goal: true }; export default () => "denied";');
    const importModule = vi.fn();
    ctx.loopScriptPolicy = { allowSource: true, importModule };
    await expect(resolveAgentLoopCapabilities(ctx, { definitionId: 'custom' })).rejects.toThrow('denied');
    expect(importModule).not.toHaveBeenCalled();
  });

  it('does not execute the workflow to inspect its capabilities and detaches the declaration', async () => {
    const run = vi.fn();
    const capabilities = { goal: true };
    const script = await loadAgentLoopScript({ kind: 'source', source: 'export default () => 123;' }, {
      ...policy,
      importModule: async () => ({ default: run, capabilities }),
    });
    capabilities.goal = false;
    expect(getLoadedScriptMetadata(script)?.capabilities).toEqual({ goal: true });
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['{ goal: "yes" }', '[]', '{ other: true }'])('rejects malformed capability export %s', async capabilities => {
    await expect(loadAgentLoopScript({ kind: 'source', source: 'export const capabilities = ' + capabilities + '; export default () => 1;' }, policy))
      .rejects.toThrow('capabilities must be a plain');
  });
});
