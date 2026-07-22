import { createScriptDeploymentClient } from 'memeloop';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SQLiteAgentStorage } from '../../storage/sqliteStorage.js';
import { createNodeRuntime } from '../nodeRuntime.js';

const VALID_SCRIPT = 'export default async function* myAgent(ctx) { yield "ok"; }';

function mkLLMProvider() {
  return {
    name: 'embed-test',
    model: 'embed-model',
    chat: async function*() {
      yield { type: 'text-delta' as const, content: 'ok', id: '1' };
    },
  };
}

describe('createNodeRuntime script deployment scheduling (plan 24.14)', () => {
  it('wires a ControlStore-backed facade so deploy applies a schedulable AgentWorkload', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-scriptdep-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
    });
    try {
      expect(runtime.context.scriptDeployment?.orchestration).toBeDefined();

      const client = createScriptDeploymentClient(runtime.context.scriptDeployment!);
      const result = await client.deploy({ source: VALID_SCRIPT, lifecycle: 'run-once' });

      expect(result.deployed).toBe(true);
      expect(result.workload?.kind).toBe('AgentWorkload');
      expect(result.workload?.spec.scriptReference).toBe(`sha256:${result.validation.digest}`);

      const workloads = await runtime.controlStore!.list({
        apiVersion: 'workload.memeloop.io/v1alpha1',
        kind: 'AgentWorkload',
      });
      expect(workloads.items).toHaveLength(1);
      expect(workloads.items[0].metadata.name).toBe(result.workload!.metadata.name);
    } finally {
      await runtime.modelEndpointRegistrar?.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
