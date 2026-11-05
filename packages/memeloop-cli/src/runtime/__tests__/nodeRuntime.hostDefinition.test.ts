import { type AgentDefinition, type AgentLoopStep } from 'memeloop';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeAgentDefinition } from '../../config.js';
import { createNodeRuntime } from '../nodeRuntime.js';

describe('live host loop definitions', () => {
  it('preserves script fields in configuration normalization', () => {
    const definition: AgentDefinition = {
      id: 'configured',
      name: 'Configured',
      description: 'Configured',
      systemPrompt: '',
      tools: [],
      version: '1',
      loopId: 'agent-agent-loop',
      scriptReference: { kind: 'source', source: 'export default function run() {}' },
      metadata: { child: 'worker' },
    };
    expect(normalizeAgentDefinition(definition)).toMatchObject(definition);
  });

  it('executes the latest saved host script after the Node runtime was started', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'host-loop-definition-'));
    const definitions = new Map<string, AgentDefinition>();
    const runtime = await createNodeRuntime({
      dataDir,
      localNodeId: 'local',
      includeVscodeCli: false,
      workloadExecution: { enabled: false },
      modelEndpointRegistration: { enabled: false },
      llmProvider: { name: 'unused-script-model', chat: vi.fn() },
      modelGateway: { routeLoops: false },
      config: { agents: [] },
      getAgentDefinition: async id => definitions.get(id),
      loopScriptPolicy: {
        allowSource: true,
        scriptLoadGate: { admitScriptLoad: () => ({ allowed: true, trustClass: 'trusted' }) },
      },
    });
    try {
      const definition: AgentDefinition = {
        id: 'host-saved',
        name: 'Host script',
        description: 'Host script',
        systemPrompt: '',
        tools: [],
        version: '1',
        loopId: 'agent-agent-loop',
        scriptReference: { kind: 'source', source: 'export default function run(ctx) { ctx.finish(ctx.profile.metadata.result); }' },
        metadata: { result: 'first' },
      };
      definitions.set(definition.id, definition);
      const { conversationId } = await runtime.runtime.createAgent({ definitionId: definition.id, conversationId: 'host-conversation' });
      const collect = async () => {
        const steps: AgentLoopStep[] = [];
        const unsubscribe = runtime.runtime.subscribeToUpdates(conversationId, update => {
          if (update.type === 'agent-step') steps.push(update.step);
        });
        try {
          const handle = await runtime.runtime.sendMessage({ conversationId, message: 'run' });
          await vi.waitFor(async () => {
            expect((await runtime.runtime.getRunStatus(handle.runId))?.state).toBe('completed');
          }, { timeout: 5_000 });
          return steps;
        } finally {
          unsubscribe();
        }
      };
      expect(await collect()).toContainEqual({ type: 'message', data: 'first' });
      definitions.set(definition.id, { ...definition, metadata: { result: 'edited' } });
      expect(await collect()).toContainEqual({ type: 'message', data: 'edited' });
      const page = await runtime.storage.getMessagePage(conversationId, { limit: 10, maxBytes: 64 * 1024 });
      expect(page.reset).toBe(false);
      if (page.reset) throw new Error('Fresh message page reset');
      expect(page.items.map(message => [message.role, message.content])).toEqual([
        ['user', 'run'],
        ['assistant', 'first'],
        ['user', 'run'],
        ['assistant', 'edited'],
      ]);
      expect(page.items[1].turnId).toBe(page.items[0].messageId);
      expect(page.items[3].turnId).toBe(page.items[2].messageId);
    } finally {
      await runtime.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
