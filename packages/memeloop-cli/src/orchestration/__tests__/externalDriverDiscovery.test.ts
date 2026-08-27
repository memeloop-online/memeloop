import {
  type AgentWorkloadResource,
  canonicalDriverValue,
  createAgentWorkloadManifest,
  createToolOperationManifest,
  type DriverManifestResource,
  QuorumControlStore,
  type ToolOperationResource,
} from 'memeloop';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createNodeRuntime } from '../../runtime/nodeRuntime.js';
import { SQLiteAgentStorage } from '../../storage/sqliteStorage.js';
import {
  discoverExternalDrivers,
  externalDriverAdmissionPayload,
  externalDriverConfigurationDigest,
  type ExternalDriverConformanceRun,
  type ExternalDriverConformanceVerifier,
  externalDriverManifestSpecFor,
  registerExternalDriverManifests,
} from '../externalDriverDiscovery.js';

const fixtureSourcePath = path.resolve(import.meta.dirname, 'fixtures/fakeExternalDriver.mjs');
const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-secure-driver-fixture-'));
const fixturePath = path.join(fixtureDirectory, 'fakeExternalDriver.mjs');
fs.copyFileSync(fixtureSourcePath, fixturePath);
// Production intentionally rejects group/world-writable driver bundles. Git
// cannot preserve those permission bits, so a checkout created under umask
// 0002 would otherwise make this positive fixture invalid by accident.
fs.chmodSync(fixturePath, 0o600);
afterAll(() => {
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});
const fixturePackageDigest = `sha256:${createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex')}`;
const fixtureDigest = `sha256:${'7'.repeat(64)}`;
const verifierKey = 'test-only-external-driver-verifier-key';
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
    spec: {
      driverType: 'external-orchestrator',
      module,
      packageDigest: fixturePackageDigest,
      export: 'createFakeExternalDriver',
      ...overrides,
    },
  };
}

function signedConformanceVerifier(
  mutate: (run: ExternalDriverConformanceRun) => ExternalDriverConformanceRun = run => run,
): ExternalDriverConformanceVerifier {
  return {
    async run(candidate) {
      const run: ExternalDriverConformanceRun = {
        suiteVersion: 'memeloop-driver-conformance/v1',
        passedAt: '2026-08-26T00:00:00.000Z',
        fixtureDigest,
        verifiedBy: 'verifier/external-driver-test',
        attestation: '',
        testsPassed: 12,
        testsFailed: 0,
      };
      const mutated = mutate(run);
      const payload = externalDriverAdmissionPayload(candidate, mutated);
      return {
        ...mutated,
        attestation: createHmac('sha256', verifierKey).update(canonicalDriverValue(payload)).digest('hex'),
      };
    },
    verifyAttestation(payload, attestation) {
      return attestation === createHmac('sha256', verifierKey).update(canonicalDriverValue(payload)).digest('hex');
    },
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
        metadata: { name: 'fake-class' },
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
      expect(result.drivers.find((driver) => driver.name === 'fake-class')).toBeDefined();
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
      writeManifest(
        directory,
        'missing-tool-contracts.json',
        validManifest(fixturePath, {
          config: { omitToolContracts: true },
        }),
      );
      writeManifest(
        directory,
        'missing-workload-runtimes.json',
        validManifest(fixturePath, {
          config: { omitWorkloadRuntimes: true },
        }),
      );
      writeManifest(directory, 'good.json', validManifest(fixturePath));

      const result = await discoverExternalDrivers({ directory });
      expect(result.drivers.map((driver) => driver.name)).toEqual(['fake-external']);
      expect(result.errors).toHaveLength(6);
      expect(result.errors.map((entry) => entry.file)).toEqual([
        'broken.json',
        'incomplete.json',
        'missing-module.json',
        'missing-tool-contracts.json',
        'missing-workload-runtimes.json',
        'wrong-kind.json',
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not trust a manifest or malicious driver self-report of passed conformance', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-drivers-self-admit-'));
    try {
      writeManifest(
        directory,
        'fake.json',
        validManifest(fixturePath, {
          conformance: { status: 'passed', fixtureDigest, attestation: 'self-signed' },
        }),
      );
      const result = await discoverExternalDrivers({ directory });
      expect(result.errors).toEqual([]);
      expect(result.drivers[0]?.conformance).toEqual({
        suiteVersion: 'memeloop-driver-conformance/v1',
        status: 'not-run',
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects bare npm modules without a trusted package-integrity resolver', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-drivers-bare-'));
    try {
      writeManifest(directory, 'bare.json', validManifest('@example/memeloop-driver'));
      const importModule = vi.fn();
      const result = await discoverExternalDrivers({ directory, importModule });
      expect(result.drivers).toEqual([]);
      expect(result.errors).toEqual([{ file: 'bare.json', error: 'external_driver_discovery_failed' }]);
      expect(importModule).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('loads a bare npm module only when the trusted resolver matches the manifest digest', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-drivers-bare-trusted-'));
    try {
      writeManifest(directory, 'bare.json', validManifest('@example/memeloop-driver'));
      const fixtureModule = await import(fixturePath) as Record<string, unknown>;
      const importModule = vi.fn(async () => fixtureModule);
      const mismatch = await discoverExternalDrivers({
        directory,
        importModule,
        resolvePackageDigest: async () => `sha256:${'8'.repeat(64)}`,
      });
      expect(mismatch.drivers).toEqual([]);
      expect(importModule).not.toHaveBeenCalled();

      const exact = await discoverExternalDrivers({
        directory,
        importModule,
        resolvePackageDigest: async () => fixturePackageDigest,
      });
      expect(exact.errors).toEqual([]);
      expect(exact.drivers.map(driver => driver.name)).toEqual(['fake-external']);
      expect(importModule).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['symlink', 'nonregular', 'oversize'] as const)('rejects an unsafe %s local package before import', async kind => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-drivers-unsafe-'));
    try {
      const unsafePath = path.join(directory, 'unsafe-module.mjs');
      if (kind === 'symlink') fs.symlinkSync(fixturePath, unsafePath);
      else if (kind === 'nonregular') fs.mkdirSync(unsafePath);
      else {
        const handle = fs.openSync(unsafePath, 'w');
        fs.ftruncateSync(handle, 64 * 1024 * 1024 + 1);
        fs.closeSync(handle);
      }
      writeManifest(directory, 'unsafe.json', validManifest(unsafePath));
      const importModule = vi.fn();
      const result = await discoverExternalDrivers({ directory, importModule });
      expect(result.drivers).toEqual([]);
      expect(result.errors).toEqual([{ file: 'unsafe.json', error: 'external_driver_discovery_failed' }]);
      expect(importModule).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['symlink', 'nonregular', 'oversize', 'invalid-utf8'] as const)(
    'rejects an unsafe %s manifest before import',
    async kind => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-manifest-unsafe-'));
      try {
        const manifestPath = path.join(directory, 'unsafe.json');
        if (kind === 'symlink') {
          const target = path.join(directory, 'manifest-target');
          writeManifest(directory, 'manifest-target', validManifest(fixturePath));
          fs.symlinkSync(target, manifestPath);
        } else if (kind === 'nonregular') {
          fs.mkdirSync(manifestPath);
        } else if (kind === 'oversize') {
          const handle = fs.openSync(manifestPath, 'w');
          fs.ftruncateSync(handle, 256 * 1024 + 1);
          fs.closeSync(handle);
        } else {
          fs.writeFileSync(manifestPath, Buffer.from([0xc3, 0x28]));
        }
        const importModule = vi.fn();
        const result = await discoverExternalDrivers({ directory, importModule });
        expect(result.drivers).toEqual([]);
        expect(result.errors).toEqual([{ file: 'unsafe.json', error: 'external_driver_discovery_failed' }]);
        expect(importModule).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('rejects deeply nested configuration without recursive traversal or importing the driver', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-config-deep-'));
    try {
      let config: Record<string, unknown> = {};
      for (let depth = 0; depth < 40; depth += 1) config = { nested: config };
      writeManifest(directory, 'deep.json', validManifest(fixturePath, { config }));
      const importModule = vi.fn();
      const result = await discoverExternalDrivers({ directory, importModule });
      expect(result.drivers).toEqual([]);
      expect(result.errors).toEqual([{ file: 'deep.json', error: 'external_driver_discovery_failed' }]);
      expect(importModule).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('admits only an exact trusted passing conformance run', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-conformance-exact-'));
    try {
      writeManifest(directory, 'fake.json', validManifest(fixturePath, { config: { region: 'test' } }));
      const passed = await discoverExternalDrivers({
        directory,
        conformance: signedConformanceVerifier(),
      });
      expect(passed.drivers[0]?.conformance).toMatchObject({
        status: 'passed',
        packageDigest: fixturePackageDigest,
        configurationDigest: externalDriverConfigurationDigest({ region: 'test' }),
        fixtureDigest,
        verifiedBy: 'verifier/external-driver-test',
        testsPassed: 12,
      });

      const failed = await discoverExternalDrivers({
        directory,
        conformance: signedConformanceVerifier(run => ({ ...run, testsFailed: 1 })),
      });
      expect(failed.drivers[0]?.conformance).toMatchObject({
        status: 'failed',
        failure: 'external_driver_conformance_failed',
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an attestation signed for a different configuration digest', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-conformance-drift-'));
    try {
      writeManifest(directory, 'fake.json', validManifest(fixturePath, { config: { region: 'live' } }));
      const verifier: ExternalDriverConformanceVerifier = {
        async run(candidate) {
          const run: ExternalDriverConformanceRun = {
            suiteVersion: 'memeloop-driver-conformance/v1',
            passedAt: '2026-08-26T00:00:00.000Z',
            fixtureDigest,
            verifiedBy: 'verifier/external-driver-test',
            attestation: '',
            testsPassed: 12,
            testsFailed: 0,
          };
          const payload = externalDriverAdmissionPayload({
            ...candidate,
            configurationDigest: externalDriverConfigurationDigest({ region: 'other' }),
          }, run);
          return {
            ...run,
            attestation: createHmac('sha256', verifierKey).update(canonicalDriverValue(payload)).digest('hex'),
          };
        },
        verifyAttestation(payload, attestation) {
          return attestation === createHmac('sha256', verifierKey)
            .update(canonicalDriverValue(payload))
            .digest('hex');
        },
      };
      const result = await discoverExternalDrivers({ directory, conformance: verifier });
      expect(result.drivers[0]?.conformance.status).toBe('failed');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists only a stable failure code when the harness diagnostic contains a secret', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-drivers-secret-'));
    const diagnostics: unknown[] = [];
    try {
      writeManifest(directory, 'fake.json', validManifest(fixturePath));
      const result = await discoverExternalDrivers({
        directory,
        conformance: {
          run: () => Promise.reject(new Error('sk-raw-secret-must-not-persist')),
          verifyAttestation: () => true,
        },
        onDiagnostic: (_file, error) => diagnostics.push(error),
      });
      expect(result.errors).toEqual([]);
      expect(result.drivers[0]?.conformance).toMatchObject({
        status: 'failed',
        failure: 'external_driver_conformance_failed',
      });
      expect(JSON.stringify(result.drivers)).not.toContain('sk-raw-secret');
      expect(diagnostics).toHaveLength(1);
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

  it('marks exact verifier-attested manifests Ready and rejects a non-verifier writer', async () => {
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-drivers-admitted-'));
    try {
      writeManifest(directory, 'fake.json', validManifest(fixturePath));
      const { drivers } = await discoverExternalDrivers({
        directory,
        conformance: signedConformanceVerifier(),
      });
      const diagnostics: unknown[] = [];
      const denied = await registerExternalDriverManifests(
        store,
        actor,
        drivers,
        (_name, error) => diagnostics.push(error),
      );
      expect(denied.registered).toEqual([]);
      expect(denied.errors).toEqual([{
        name: 'fake-external',
        error: 'external_driver_registration_failed',
      }]);
      expect(diagnostics).toHaveLength(1);

      const verifierActor = { id: 'verifier/external-driver-test', kind: 'verifier' as const };
      const admitted = await registerExternalDriverManifests(store, verifierActor, drivers);
      expect(admitted).toEqual({ registered: ['fake-external'], errors: [] });
      const resource = await store.get({
        apiVersion: 'drivers.memeloop.io/v1alpha1',
        kind: 'DriverManifest',
        name: 'fake-external',
      });
      expect((resource as DriverManifestResource | null)?.status?.phase).toBe('Ready');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
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
      execution: {
        location: 'external',
        transport: 'container-api',
      },
      supportedTrustClasses: ['trusted'],
      resourceKinds: ['AgentWorkload'],
      capabilities: {},
      downgradeBehavior: 'reject',
      requiredHostPrivileges: ['external-orchestrator-api'],
      isolation: {
        boundary: 'external',
        threatAssumptions: [
          'backend credentials remain in the trusted driver host',
          'backend admission and workload hardening are independently enforced',
        ],
      },
      configuration: {
        schemaRef: 'memeloop://schemas/external-driver-package-manifest/v1',
        secretRefs: ['config.secretRefs'],
      },
      health: { mode: 'method' },
      lifecycle: {
        discoverable: true,
        hotReload: false,
        gracefulShutdown: true,
      },
      conformance: {
        suiteVersion: 'memeloop-driver-conformance/v1',
        status: 'not-run',
      },
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
      logger: { warn: () => {} },
      toolExecution: {
        admission: { defaultAction: 'allow', rules: [] },
      },
      externalDrivers: {
        conformance: signedConformanceVerifier(),
      },
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
        (resource) => (resource as AgentWorkloadResource | null)?.status?.phase === 'Running',
      );
      expect((routed as AgentWorkloadResource | null)?.status).toMatchObject({
        assignedDriver: 'fake-external',
        assignedNode: 'fake-node',
        externalId: 'fake-1',
      });

      const externalTool = createToolOperationManifest('routed-external-tool', {
        toolRef: { kind: 'Tool', name: 'fake.echo' },
        arguments: { accepted: true },
        effect: 'read',
        placement: { orchestrator: 'fake-external' },
      });
      externalTool.metadata.annotations = {
        'memeloop.io/runtime-image': 'example.invalid/fake-runtime@sha256:test',
      };
      await runtime.controlStore!.create(actor, externalTool);
      const routedTool = await waitFor(
        () =>
          runtime.controlStore!.get({
            apiVersion: 'execution.memeloop.io/v1alpha1',
            kind: 'ToolOperation',
            name: 'routed-external-tool',
          }),
        (resource) => (resource as ToolOperationResource | null)?.status?.externalId === 'fake-tool-2',
      );
      expect((routedTool as ToolOperationResource | null)?.status).toMatchObject({
        assignedDriver: 'fake-external',
        assignedNode: 'fake-node',
        externalId: 'fake-tool-2',
      });

      await runtime.controlStore!.create(
        actor,
        createAgentWorkloadManifest('trusted-external-denied', {
          trust: 'trusted',
          placement: { orchestrator: 'fake-external' },
        }),
      );
      const deniedTrusted = await waitFor(
        () =>
          runtime.controlStore!.get({
            apiVersion: 'workload.memeloop.io/v1alpha1',
            kind: 'AgentWorkload',
            name: 'trusted-external-denied',
          }),
        (resource) => (resource as AgentWorkloadResource | null)?.status?.phase === 'Failed',
      );
      expect((deniedTrusted as AgentWorkloadResource | null)?.status?.lastRunResult).toContain(
        'no independently attested trusted-node identity',
      );
      expect((deniedTrusted as AgentWorkloadResource | null)?.status?.externalId).toBeUndefined();
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

  it('never routes a discovered driver whose conformance has not run', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-ext-not-run-'));
    const discoveryDirectory = path.join(dataDir, 'drivers.d');
    fs.mkdirSync(discoveryDirectory);
    writeManifest(discoveryDirectory, 'fake.json', validManifest(fixturePath));

    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-ext-not-run',
      config: { providers: [] },
      logger: { warn: () => {} },
      toolExecution: {
        admission: { defaultAction: 'allow', rules: [] },
      },
    });
    try {
      expect(runtime.externalDrivers?.[0]?.conformance.status).toBe('not-run');
      await runtime.controlStore!.create(
        actor,
        createAgentWorkloadManifest('not-run-driver-denied', {
          placement: { orchestrator: 'fake-external' },
        }),
      );
      const denied = await waitFor(
        () =>
          runtime.controlStore!.get({
            apiVersion: 'workload.memeloop.io/v1alpha1',
            kind: 'AgentWorkload',
            name: 'not-run-driver-denied',
          }),
        resource => (resource as AgentWorkloadResource | null)?.status?.phase === 'Failed',
      );
      expect((denied as AgentWorkloadResource | null)?.status?.externalId).toBeUndefined();
      expect((denied as AgentWorkloadResource | null)?.status?.lastRunResult).toContain(
        "external orchestrator 'fake-external' is not registered",
      );
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
