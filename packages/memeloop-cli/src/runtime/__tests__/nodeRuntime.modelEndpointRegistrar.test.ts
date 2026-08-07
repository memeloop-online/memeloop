import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SQLiteAgentStorage } from '../../storage/sqliteStorage.js';
import { createNodeRuntime } from '../nodeRuntime.js';

function mkLLMProvider() {
  return {
    name: 'embed-test',
    model: 'embed-model',
    chat: async function*() {
      yield { type: 'text-delta' as const, content: 'ok', id: '1' };
    },
  };
}

interface RegistrarTestRuntime {
  controlStore?: import('memeloop').ControlStore;
  modelEndpointRegistrar?: import('memeloop').ModelEndpointRegistrarHandle;
  bindingControllerRunner?: import('memeloop').ControllerRunnerHandle;
  workloadExecutionController?: import('memeloop').WorkloadExecutionControllerHandle;
  storage: unknown;
}

async function cleanup(runtime: RegistrarTestRuntime): Promise<void> {
  await runtime.workloadExecutionController?.stop();
  await runtime.bindingControllerRunner?.stop();
  await runtime.modelEndpointRegistrar?.stop();
  await runtime.controlStore?.close();
  (runtime.storage as SQLiteAgentStorage).close();
}

describe('createNodeRuntime model endpoint registration (plan 24.36)', () => {
  it('advertises configured models and keeps endpoint health in the ControlStore', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-modelreg-'));
    let runtime: RegistrarTestRuntime | undefined;
    try {
      runtime = await createNodeRuntime({
        dataDir,
        llmProvider: mkLLMProvider() as never,
        includeVscodeCli: false,
        localNodeId: 'node-a',
        trustClass: 'restricted',
        config: {
          providers: [{
            name: 'ollama',
            models: [{
              id: 'qwen2.5:7b',
              name: 'Qwen 2.5 7B',
              maxInputTokens: 32_768,
              maxOutputTokens: 8192,
              toolCalling: true,
              vision: false,
            }],
          }],
        },
      });

      expect(runtime.modelEndpointRegistrar).toBeDefined();

      // The registrar heartbeats asynchronously; wait for the first tick.
      let endpoints = await runtime.controlStore!.list({
        apiVersion: 'models.memeloop.io/v1alpha1',
        kind: 'ModelEndpoint',
      });
      for (let attempt = 0; attempt < 50 && endpoints.items.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        endpoints = await runtime.controlStore!.list({
          apiVersion: 'models.memeloop.io/v1alpha1',
          kind: 'ModelEndpoint',
        });
      }
      expect(endpoints.items).toHaveLength(1);
      const [endpoint] = endpoints.items;
      expect(endpoint.spec).toMatchObject({ nodeId: 'node-a', trust: 'restricted' });
      expect(endpoint.status?.healthy).toBe(true);
      expect(endpoint.status?.heartbeat).toBeTruthy();

      const classes = await runtime.controlStore!.list({
        apiVersion: 'models.memeloop.io/v1alpha1',
        kind: 'ModelClass',
      });
      expect(classes.items).toHaveLength(1);
      expect(classes.items[0].spec).toMatchObject({
        provider: 'ollama',
        model: 'qwen2.5:7b',
        contextWindow: 32_768,
        maxOutputTokens: 8192,
        capabilities: { toolUse: true },
        modalities: ['text'],
      });

      await runtime.modelEndpointRegistrar!.stop();
      const afterStop = await runtime.controlStore!.list({
        apiVersion: 'models.memeloop.io/v1alpha1',
        kind: 'ModelEndpoint',
      });
      expect(afterStop.items[0].status?.healthy).toBe(false);
    } finally {
      if (runtime) await cleanup(runtime);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('does not register when disabled', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-modelreg-off-'));
    let runtime: RegistrarTestRuntime | undefined;
    try {
      runtime = await createNodeRuntime({
        dataDir,
        llmProvider: mkLLMProvider() as never,
        includeVscodeCli: false,
        modelEndpointRegistration: { enabled: false },
        config: { providers: [] },
      });

      expect(runtime.modelEndpointRegistrar).toBeUndefined();
      const endpoints = await runtime.controlStore!.list({
        apiVersion: 'models.memeloop.io/v1alpha1',
        kind: 'ModelEndpoint',
      });
      expect(endpoints.items).toHaveLength(0);
    } finally {
      if (runtime) await cleanup(runtime);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('never persists a non-serializable SDK model factory', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-modelreg-factory-'));
    let runtime: RegistrarTestRuntime | undefined;
    const errors: unknown[] = [];
    try {
      runtime = await createNodeRuntime({
        dataDir,
        llmProvider: {
          name: 'factory-provider',
          model: () => ({ provider: 'sdk-object' }),
          chat: async function*() {
            yield 'ok';
          },
        },
        includeVscodeCli: false,
        logger: { warn: (_message, error) => errors.push(error) },
        modelGateway: { enabled: false },
        workloadExecution: { enabled: false },
      });

      await runtime.modelEndpointRegistrar!.refresh();
      const classes = await runtime.controlStore!.list({
        apiVersion: 'models.memeloop.io/v1alpha1',
        kind: 'ModelClass',
      });
      expect(classes.items).toHaveLength(1);
      expect(classes.items[0].spec).toMatchObject({
        provider: 'factory-provider',
        model: 'factory-provider',
      });
      expect(errors).toEqual([]);
      expect(() => structuredClone(classes.items[0])).not.toThrow();
    } finally {
      if (runtime) await cleanup(runtime);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
