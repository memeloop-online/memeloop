import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '../../agent/types.js';
import { AgentDefinitionEditorController } from '../AgentDefinitionEditorController.js';
import type { AgentDefinitionRepository, AgentInstanceClient, ScheduledTaskClient } from '../types.js';

afterEach(() => vi.useRealTimers());

describe('AgentDefinitionEditorController loop configuration', () => {
  it('loads the canonical loop schema and preserves execution fields in both save paths', async () => {
    vi.useFakeTimers();
    const definition: AgentDefinition = {
      id: 'scripted',
      name: 'Scripted',
      description: 'Scripted',
      systemPrompt: '',
      tools: [],
      version: '1',
      loopId: 'agent-agent-loop',
      scriptReference: { kind: 'source', source: 'export default function run(ctx) { ctx.finish("ok"); }' },
      metadata: { childProfile: 'worker' },
    };
    const updateAgentDef = vi.fn<AgentDefinitionRepository['updateAgentDef']>(async change => ({ ...definition, ...change }));
    const getFrameworkConfigSchema = vi.fn<AgentInstanceClient['getFrameworkConfigSchema']>(async () => ({}));
    const repository: AgentDefinitionRepository = {
      createAgentDef: vi.fn(async (value: AgentDefinition) => value),
      updateAgentDef,
      getAgentDefs: vi.fn(async () => [definition]),
      getAgentDef: vi.fn(async () => definition),
      getAgentTemplates: vi.fn(async () => []),
      deleteAgentDef: vi.fn(async () => {}),
    };
    const instanceClient: AgentInstanceClient = {
      createAgent: vi.fn(async () => ({ id: 'preview' })),
      fetchAgent: vi.fn(),
      updateAgent: vi.fn(),
      cancelAgent: vi.fn(),
      deleteAgent: vi.fn(),
      subscribeToUpdates: vi.fn(),
      getAgentFrameworkId: vi.fn(),
      getFrameworkConfigSchema,
    };
    const scheduledTaskClient: ScheduledTaskClient = {
      listScheduledTasksForAgent: vi.fn(),
      createScheduledTask: vi.fn(),
      updateScheduledTask: vi.fn(),
      deleteScheduledTask: vi.fn(),
      getCronPreviewDates: vi.fn(),
    };
    const editor = new AgentDefinitionEditorController({
      definitionRepository: repository,
      agentInstanceClient: instanceClient,
      scheduledTaskClient,
      onError: vi.fn(),
    });
    await editor.loadDefinition(definition.id);
    expect(getFrameworkConfigSchema).toHaveBeenCalledWith('agent-agent-loop');
    await editor.saveNow();
    expect(updateAgentDef).toHaveBeenLastCalledWith(definition);
    editor.updateDefinition({ id: definition.id, name: 'Updated' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updateAgentDef).toHaveBeenLastCalledWith({ ...definition, name: 'Updated' });
  });
});
