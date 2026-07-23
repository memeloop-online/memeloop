import { createAgentWorkloadManifest, QuorumControlStore } from 'memeloop';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createNodeRuntime } from '../../runtime/nodeRuntime.js';
import { SQLiteAgentStorage } from '../../storage/sqliteStorage.js';
import { discoverExternalDrivers, externalDriverManifestSpecFor, registerExternalDriverManifests } from '../externalDriverDiscovery.js';

const fixturePath = fileURLToPath(new URL('./fixtures/fakeExternalDriver.mjs', import.meta.url));
const actor = { id: 'controller/driver-registry-test', kind: 'controller' as const };

function mkLLMProvider() {
  return {
    name: 'ext-test',
    model: 'ext-model',
    chat: async function*() {
      yield 'ok';
    },
  };
}

function writeManifest(directory: string, name: string, manifest: unknown): void {
  fs.writeFileSync(path.join(directory, name), JSON.stringify(manifest));
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
}

function validManifest(module: string, overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 'drivers.memeloop.io/v1alpha1',
    kind: 'DriverManifest',
    metadata: { name: 'fake-external' },
    spec: { driverType: 'external-orchestrator', module, export: 'createFakeExternalDriver', ...overrides },
  };
}

describe('discoverExternalDrivers (plan 24.62 item 3)', () => {
  it('returns empty for a missing directory (no drivers installed)', async () => {
    const result = await discoverExternalDrivers({ directory: '/nonexistent/drivers.d' });
    expect(result.drivers).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('loads factory and class drivers and validates capabilities', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-drivers-'));
    try {
      writeManifest(directory, 'fake.json', validManifest(fixturePath));
      writeManifest(directory, 'class.json', {
        ...validManifest(fixturePath, { export: 'FakeClassDriver', construct: true }),
        metadata: { name: 'fake-class', namespace: 'infra' },
      });

      const result = await discoverExternalDrivers({ directory });
      expect(result.errors).toEqual([]);
      expect(result.drivers.map((driver) => driver.name)).toEqual(['fake-class', 'fake-external']);
      const factory = result.drivers.find((driver) => driver.name === 'fake-external')!;
      expect(factory.capabilities).toMatchObject({ version: '1.2.3', supportsColocation: true, maxConcurrency: 8 });
      // The driver is live: place + status through the contract.
      const placement = await factory.driver.placeWorkload(
        { metadata: { name: 'w1' } } as never,
        actor,
      );
      expect(placement.externalId).toMatch(/^fake-/);
      const classDriver = result.drivers.find((driver) => driver.name === 'fake-class')!;
      expect(classDriver.namespace).toBe('infra');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('collects malformed manifests, unresolvable modules, and non-conforming drivers without throwing', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-drivers-bad-'));
    try {
      fs.writeFileSync(path.join(directory, 'broken.json'), '{not json');
      writeManifest(directory, 'wrong-kind.json', { apiVersion: 'v1', kind: 'Something', metadata: { name: 'x' }, spec: {} });
      writeManifest(directory, 'missing-module.json', validManifest('/nonexistent/module.js'));
      writeManifest(directory, 'incomplete.json', validManifest(fixturePath, { export: 'createIncompleteDriver' }));
      writeManifest(directory, 'good.json', validManifest(fixturePath));

      const result = await discoverExternalDrivers({ directory });
      expect(result.drivers.map((driver) => driver.name)).toEqual(['fake-external']);
      expect(result.errors).toHaveLength(4);
      expect(result.errors.map((entry) => entry.file)).toEqual([
        'broken.json',
        'incomplete.json',
        'missing-module.json',
        'wrong-kind.json',
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('registerExternalDriverManifests (plan 24.62 item 4)', () => {
  it('registers DriverManifest resources the scheduler can discover, idempotently', async () => {
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
    try {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-drivers-reg-'));
      writeManifest(directory, 'fake.json', validManifest(fixturePath));
      const { drivers } = await discoverExternalDrivers({ directory });

      const first = await registerExternalDriverManifests(store, actor, drivers);
      expect(first).toEqual({ registered: ['fake-external'], errors: [] });
      // Idempotent re-registration (same spec) does not conflict.
      const second = await registerExternalDriverManifests(store, actor, drivers);
      expect(second.errors).toEqual([]);

      const listed = await store.list({ apiVersion: 'drivers.memeloop.io/v1alpha1', kind: 'DriverManifest' });
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0].spec).toMatchObject({
        driverType: 'external-orchestrator',
        version: '1.2.3',
        manages: ['AgentWorkload', 'ToolOperation'],
        supportsColocation: true,
        supportsAdoption: true,
        capabilities: { maxConcurrency: 8 },
      });
      fs.rmSync(directory, { recursive: true, force: true });
    } finally {
      await store.close();
    }
  });

  it('maps capabilities to an honest manifest spec', () => {
    const spec = externalDriverManifestSpecFor({
      name: 'k8s',
      version: '2.0.0',
      manages: ['AgentWorkload'],
      supportsColocation: false,
      supportsAdoption: true,
    });
    expect(spec).toEqual({
      driverType: 'external-orchestrator',
      version: '2.0.0',
      capabilities: {},
      manages: ['AgentWorkload'],
      supportsColocation: false,
      supportsAdoption: true,
      supportsCancellation: true,
      supportsBackpressure: false,
      supportsFencing: false,
    });
  });
});

describe('createNodeRuntime external driver discovery (plan 24.62 item 5)', () => {
  it('discovers drivers from dataDir/drivers.d and registers their manifests', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-ext-drivers-'));
    const discoveryDirectory = path.join(dataDir, 'drivers.d');
    fs.mkdirSync(discoveryDirectory);
    writeManifest(discoveryDirectory, 'fake.json', validManifest(fixturePath));

    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-ext',
      config: { providers: [] },
    });
    try {
      expect(runtime.externalDrivers?.map((driver) => driver.name)).toEqual(['fake-external']);
      const listed = await runtime.controlStore!.list({ apiVersion: 'drivers.memeloop.io/v1alpha1', kind: 'DriverManifest' });
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0].metadata.name).toBe('fake-external');

      // Registration is not merely cataloguing: the runtime controller
      // routes an explicitly placed workload through the live driver.
      await runtime.controlStore!.create(
        actor,
        createAgentWorkloadManifest('routed-external', {
          placement: { orchestrator: 'fake-external' },
        }),
      );
      const routed = await waitFor(
        () =>
          runtime.controlStore!.get({
            apiVersion: 'workload.memeloop.io/v1alpha1',
            kind: 'AgentWorkload',
            name: 'routed-external',
          }),
        (resource) => resource?.status?.phase === 'Running',
      );
      expect(routed?.status).toMatchObject({
        assignedDriver: 'fake-external',
        assignedNode: 'fake-node',
        externalId: 'fake-1',
      });
    } finally {
      await runtime.externalOrchestrationController?.stop();
      await runtime.workloadExecutionController?.stop();
      await runtime.bindingControllerRunner?.stop();
      await runtime.modelEndpointRegistrar?.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('exposes no drivers and no manifests when drivers.d is absent', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-ext-none-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-ext-none',
      config: { providers: [] },
    });
    try {
      expect(runtime.externalDrivers).toEqual([]);
      const listed = await runtime.controlStore!.list({ apiVersion: 'drivers.memeloop.io/v1alpha1', kind: 'DriverManifest' });
      expect(listed.items).toHaveLength(0);
    } finally {
      await runtime.externalOrchestrationController?.stop();
      await runtime.workloadExecutionController?.stop();
      await runtime.bindingControllerRunner?.stop();
      await runtime.modelEndpointRegistrar?.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});
