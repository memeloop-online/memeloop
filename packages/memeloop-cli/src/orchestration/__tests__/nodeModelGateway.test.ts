import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createNodeRuntime } from '../../runtime/nodeRuntime.js';
import { SQLiteAgentStorage } from '../../storage/sqliteStorage.js';
import { createHmacModelHandleSigner, loadOrCreateModelBrokerKey } from '../nodeModelGateway.js';

function mkLLMProvider() {
  return {
    name: 'gw-test',
    model: 'gw-model',
    chat: async function*() {
      yield 'hello ';
      yield 'world';
    },
  };
}

const MODEL_REF = { apiVersion: 'models.memeloop.io/v1alpha1', kind: 'ModelClass', name: 'gw-model' };

describe('createHmacModelHandleSigner', () => {
  it('signs and verifies, rejecting tampering', async () => {
    const signer = createHmacModelHandleSigner(new Uint8Array(32).fill(7));
    const payload = new TextEncoder().encode('claims');
    const signature = await signer.sign(payload);
    expect(await signer.verify(payload, signature)).toBe(true);
    expect(await signer.verify(new TextEncoder().encode('other'), signature)).toBe(false);
    const tampered = new Uint8Array(signature);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(await signer.verify(payload, tampered)).toBe(false);
  });
});

describe('loadOrCreateModelBrokerKey', () => {
  it('persists a 0600 host-local key and reloads it', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-broker-key-'));
    try {
      const first = loadOrCreateModelBrokerKey(dataDir);
      const second = loadOrCreateModelBrokerKey(dataDir);
      expect(first.length).toBeGreaterThanOrEqual(32);
      expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
      const stat = fs.statSync(path.join(dataDir, 'model-broker.key'));
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('nodeRuntime model gateway (plan §12 / 24.65)', () => {
  it('issues handles, serves verified calls, and audits ModelCallRecords in the ControlStore', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-gateway-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-gw',
      config: { providers: [] },
    });
    try {
      expect(runtime.modelGateway).toBeDefined();

      const handle = await runtime.modelGateway!.issueHandle({
        modelClassRef: MODEL_REF,
        runRef: {
          apiVersion: 'run.memeloop.io/v1alpha1',
          kind: 'AgentRun',
          name: 'run-gw',
          uid: 'run-gw-uid',
        },
        attempt: 1,
        budget: { maxConcurrent: 2 },
      });

      const chunks: string[] = [];
      for await (
        const chunk of runtime.modelGateway!.gateway.generate({
          callId: 'call-gw-1',
          modelClassRef: MODEL_REF,
          messages: [{ role: 'user', content: 'hi' }],
          accessHandle: handle.token,
        })
      ) {
        if (chunk.type === 'delta' && chunk.delta) chunks.push(chunk.delta);
      }
      expect(chunks.join('')).toBe('hello world');

      // Audit: exactly one ModelCallRecord with the terminal status.
      const records = await runtime.controlStore!.list({
        apiVersion: 'models.memeloop.io/v1alpha1',
        kind: 'ModelCallRecord',
      });
      expect(records.items).toHaveLength(1);
      const record = records.items[0];
      expect(record.spec).toMatchObject({
        caller: 'node/node-gw',
        accessHandleRef: handle.claims.handleId,
      });
      expect(record.status).toMatchObject({ phase: 'Completed' });

      // A forged token is rejected before any provider call.
      await expect(async () => {
        for await (
          const _chunk of runtime.modelGateway!.gateway.generate({
            callId: 'call-gw-2',
            modelClassRef: MODEL_REF,
            messages: [{ role: 'user', content: 'hi' }],
            accessHandle: 'mlh1.Zm9yZ2Vk.Zm9yZ2Vk',
          })
        ) { /* drain */ }
      }).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const after = await runtime.controlStore!.list({ apiVersion: 'models.memeloop.io/v1alpha1', kind: 'ModelCallRecord' });
      expect(after.items).toHaveLength(1);

      // Revocation on Run completion closes access immediately (§12.1 step 6).
      runtime.modelGateway!.gateway.revokeRunHandles('run-gw');
      await expect(async () => {
        for await (
          const _chunk of runtime.modelGateway!.gateway.generate({
            callId: 'call-gw-3',
            modelClassRef: MODEL_REF,
            messages: [{ role: 'user', content: 'hi' }],
            accessHandle: handle.token,
          })
        ) { /* drain */ }
      }).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await runtime.workloadExecutionController?.stop();
      await runtime.bindingControllerRunner?.stop();
      await runtime.modelEndpointRegistrar?.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('is disabled via modelGateway.enabled=false', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-gateway-off-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-gw-off',
      config: { providers: [] },
      modelGateway: { enabled: false },
    });
    try {
      expect(runtime.modelGateway).toBeUndefined();
    } finally {
      await runtime.workloadExecutionController?.stop();
      await runtime.bindingControllerRunner?.stop();
      await runtime.modelEndpointRegistrar?.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('routes loop model calls through the gateway by default (24.35)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-gateway-loops-'));
    const directProvider = mkLLMProvider();
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: directProvider as never,
      includeVscodeCli: false,
      localNodeId: 'node-gw-loops',
      config: { providers: [] },
    });
    try {
      // The loop-facing provider is the gateway-mediated adapter, not the raw one.
      expect(runtime.context.llmProvider).not.toBe(directProvider);
      expect(runtime.context.llmProvider.name).toBe('gw-test');

      let text = '';
      const stream = runtime.context.llmProvider.chat({
        conversationId: 'conv-loops',
        messages: [{ role: 'user', content: 'hi' }],
      }) as AsyncIterable<unknown>;
      for await (const chunk of stream) {
        if (typeof chunk === 'string') text += chunk;
      }
      // Same text as the direct path (deltas survive the gateway round-trip).
      expect(text).toBe('hello world');

      // The call was audited: a ModelCallRecord exists for the loop model class.
      const records = await runtime.controlStore!.list({
        apiVersion: 'models.memeloop.io/v1alpha1',
        kind: 'ModelCallRecord',
      });
      expect(records.items.length).toBeGreaterThanOrEqual(1);
      expect(records.items[0].spec).toMatchObject({
        modelClassRef: { name: 'gw-test-gw-model' },
      });
      expect(records.items[0].status).toMatchObject({ phase: 'Completed' });
    } finally {
      await runtime.workloadExecutionController?.stop();
      await runtime.bindingControllerRunner?.stop();
      await runtime.modelEndpointRegistrar?.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps the direct provider path when routeLoops is false', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-gateway-direct-'));
    const directProvider = mkLLMProvider();
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: directProvider as never,
      includeVscodeCli: false,
      localNodeId: 'node-gw-direct',
      config: { providers: [] },
      modelGateway: { routeLoops: false },
    });
    try {
      expect(runtime.modelGateway).toBeDefined();
      expect(runtime.context.llmProvider).toBe(directProvider);
    } finally {
      await runtime.workloadExecutionController?.stop();
      await runtime.bindingControllerRunner?.stop();
      await runtime.modelEndpointRegistrar?.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});
