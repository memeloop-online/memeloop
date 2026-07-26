import type { ControlStoreActor } from '../controlStore.js';
import type { AgentWorkloadResource, InfrastructureDriverType, NetworkAttachmentStatus, ToolOperationResource } from '../resources.js';
import type { ExternalOrchestrationDriver } from './externalDriver.js';
import type { ModelGenerateRequest, ModelProviderDriver, ModelProviderHealth, ModelStreamChunk } from './modelProviderDriver.js';
import type { NetworkAttachRequest, NetworkDriver, NetworkDriverCapabilities, NetworkDriverHealth } from './networkDriver.js';
import type { ToolExecutionDriver } from './toolExecutionDriver.js';

export interface DriverManifest {
  name: string;
  version: string;
  kind: InfrastructureDriverType;
  capabilities: Record<string, boolean | string | number>;
  supportsCancellation: boolean;
  supportsBackpressure: boolean;
  supportsAdoption: boolean;
  supportsFencing: boolean;
}

export interface DriverConformanceTest {
  name: string;
  description: string;
  run: (driver: unknown) => Promise<void>;
}

export interface DriverConformanceSuite {
  interfaceKind: DriverManifest['kind'];
  tests: DriverConformanceTest[];
}

export interface FakeDriverOptions {
  latencyMs?: number;
  failureRate?: number;
  supportsCancellation?: boolean;
  supportsBackpressure?: boolean;
  supportsAdoption?: boolean;
  supportsFencing?: boolean;
}

async function maybeFail(latency: number, failureRate: number): Promise<void> {
  if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
  if (Math.random() < failureRate) throw new Error('injected failure');
}

/**
 * Create a fake network driver for conformance testing.
 */
export function createFakeNetworkDriver(options: FakeDriverOptions = {}): NetworkDriver {
  const latency = options.latencyMs ?? 0;
  const failureRate = options.failureRate ?? 0;

  return {
    async getCapabilities(): Promise<NetworkDriverCapabilities> {
      await maybeFail(latency, failureRate);
      return {
        name: 'fake-network-driver',
        enforcedFeatures: ['egress'],
        enforcementLevel: 'process',
      };
    },
    async prepare(_request: NetworkAttachRequest): Promise<NetworkAttachmentStatus> {
      await maybeFail(latency, failureRate);
      return { handle: 'fake-handle' };
    },
    async check(_handle: string): Promise<NetworkAttachmentStatus | null> {
      await maybeFail(latency, failureRate);
      return { handle: 'fake-handle' };
    },
    async update(_handle: string, _request: NetworkAttachRequest): Promise<NetworkAttachmentStatus> {
      await maybeFail(latency, failureRate);
      return { handle: 'fake-handle' };
    },
    async resolveService(_name: string, _handle?: string): Promise<string | undefined> {
      await maybeFail(latency, failureRate);
      return undefined;
    },
    async release(_handle: string): Promise<void> {
      await maybeFail(latency, failureRate);
    },
    async getHealth(): Promise<NetworkDriverHealth> {
      await maybeFail(latency, failureRate);
      return { healthy: true, checkedAt: new Date().toISOString() };
    },
  };
}

/**
 * Create a fake model provider driver for conformance testing.
 */
export function createFakeModelProviderDriver(options: FakeDriverOptions = {}): ModelProviderDriver {
  const latency = options.latencyMs ?? 0;
  const failureRate = options.failureRate ?? 0;

  return {
    async listModels() {
      await maybeFail(latency, failureRate);
      return [];
    },
    async getHealth(): Promise<ModelProviderHealth> {
      await maybeFail(latency, failureRate);
      return { healthy: true, checkedAt: new Date().toISOString() };
    },
    async *generate(_request: ModelGenerateRequest): AsyncIterable<ModelStreamChunk> {
      await maybeFail(latency, failureRate);
      yield { type: 'delta', delta: 'fake response' };
    },
  };
}

/**
 * Create a fake tool execution driver for conformance testing.
 */
export function createFakeToolExecutionDriver(options: FakeDriverOptions = {}): ToolExecutionDriver {
  const latency = options.latencyMs ?? 0;
  const failureRate = options.failureRate ?? 0;

  return {
    async execute(operation): Promise<ToolOperationResource> {
      await maybeFail(latency, failureRate);
      return {
        ...operation,
        status: { phase: 'Completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
      };
    },
  };
}

/**
 * Run a conformance suite against a driver.
 */
export async function runConformanceSuite(
  suite: DriverConformanceSuite,
  driver: unknown,
): Promise<{ passed: number; failed: number; failures: Array<{ name: string; error: string }> }> {
  const failures: Array<{ name: string; error: string }> = [];

  for (const test of suite.tests) {
    try {
      await test.run(driver);
    } catch (error) {
      failures.push({
        name: test.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    passed: suite.tests.length - failures.length,
    failed: failures.length,
    failures,
  };
}

/**
 * Standard conformance tests for network drivers.
 */
export function createNetworkDriverConformanceSuite(): DriverConformanceSuite {
  return {
    interfaceKind: 'network',
    tests: [
      {
        name: 'getCapabilities returns valid capabilities',
        description: 'Driver must return its capability set',
        run: async (driver) => {
          const networkDriver = driver as NetworkDriver;
          const capabilities = await networkDriver.getCapabilities();
          if (!capabilities.name) throw new Error('name is required');
          if (!capabilities.enforcementLevel) throw new Error('enforcementLevel is required');
        },
      },
      {
        name: 'prepare returns attachment status with handle',
        description: 'Driver must prepare network for a workload',
        run: async (driver) => {
          const networkDriver = driver as NetworkDriver;
          const result = await networkDriver.prepare({
            attachment: {
              apiVersion: 'network.memeloop.io/v1alpha1',
              kind: 'NetworkAttachment',
              metadata: { name: 'test', namespace: 'default', uid: 'uid-1', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-18T00:00:00.000Z' },
              spec: { networkClassRef: { apiVersion: 'network.memeloop.io/v1alpha1', kind: 'NetworkClass', name: 'process' } },
            },
            networkClass: {
              apiVersion: 'network.memeloop.io/v1alpha1',
              kind: 'NetworkClass',
              metadata: { name: 'process', namespace: 'default', uid: 'uid-2', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-18T00:00:00.000Z' },
              spec: { driver: 'fake-network-driver', enforcement: 'best-effort' },
            },
            sandboxRef: 'sandbox-1',
          });
          if (!result.handle) throw new Error('prepare must return handle');
        },
      },
      {
        name: 'getHealth returns health status',
        description: 'Driver must report its health',
        run: async (driver) => {
          const networkDriver = driver as NetworkDriver;
          const health = await networkDriver.getHealth();
          if (typeof health.healthy !== 'boolean') throw new Error('healthy is required');
        },
      },
    ],
  };
}

/**
 * Standard conformance tests for model provider drivers.
 */
export function createModelProviderDriverConformanceSuite(): DriverConformanceSuite {
  return {
    interfaceKind: 'model-provider',
    tests: [
      {
        name: 'listModels returns model array',
        description: 'Driver must list available models',
        run: async (driver) => {
          const modelDriver = driver as ModelProviderDriver;
          const models = await modelDriver.listModels();
          if (!Array.isArray(models)) throw new Error('listModels must return array');
        },
      },
      {
        name: 'getHealth returns health status',
        description: 'Driver must report its health',
        run: async (driver) => {
          const modelDriver = driver as ModelProviderDriver;
          const health = await modelDriver.getHealth();
          if (typeof health.healthy !== 'boolean') throw new Error('healthy is required');
        },
      },
    ],
  };
}

/**
 * Standard conformance tests for tool execution drivers.
 */
export function createToolExecutionDriverConformanceSuite(): DriverConformanceSuite {
  return {
    interfaceKind: 'tool-execution',
    tests: [
      {
        name: 'execute returns operation resource with status',
        description: 'Driver must execute a tool operation',
        run: async (driver) => {
          const toolDriver = driver as ToolExecutionDriver;
          const operation: ToolOperationResource = {
            apiVersion: 'execution.memeloop.io/v1alpha1',
            kind: 'ToolOperation',
            metadata: { name: 'test', namespace: 'default', uid: 'uid-1', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-18T00:00:00.000Z' },
            spec: { toolRef: { kind: 'Tool', name: 'test-tool' }, effect: 'execute' },
          };
          const result = await toolDriver.execute(operation);
          if (!result.status) throw new Error('execute must return status');
          if (!result.status.phase) throw new Error('status.phase is required');
        },
      },
    ],
  };
}

/**
 * Standard lifecycle and crash-adoption contract for optional external
 * orchestrators. Resource factories keep backend-specific runtime-image
 * annotations out of portable core while allowing this exact suite to run
 * against Swarm, Kubernetes, and future plugins.
 */
export function createExternalOrchestrationDriverConformanceSuite(options: {
  createWorkload: (name: string) => AgentWorkloadResource;
  createToolOperation: (name: string) => ToolOperationResource;
  actor?: ControlStoreActor;
}): DriverConformanceSuite {
  const actor = options.actor ?? { id: 'controller/external-conformance', kind: 'controller' };
  return {
    interfaceKind: 'external-orchestrator',
    tests: [
      {
        name: 'reports honest external orchestration capabilities and health',
        description: 'Both independently managed resource kinds, adoption support, and health are explicit',
        run: async (driver) => {
          const external = driver as ExternalOrchestrationDriver;
          const [capabilities, health] = await Promise.all([
            external.getCapabilities(),
            external.getHealth(),
          ]);
          for (const kind of ['AgentWorkload', 'ToolOperation'] as const) {
            if (!capabilities.manages.includes(kind)) throw new Error(`capabilities do not manage ${kind}`);
          }
          if (!capabilities.supportsAdoption) throw new Error('crash-safe adoption is required');
          if (typeof health.healthy !== 'boolean' || !health.checkedAt) throw new Error('invalid health result');
        },
      },
      {
        name: 'places, discovers, adopts, inspects, and stops a workload',
        description: 'The workload lifecycle is independently addressable and duplicate UID placement is idempotent',
        run: async (driver) => {
          const external = driver as ExternalOrchestrationDriver;
          const workload = options.createWorkload('external-conformance-workload');
          const first = await external.placeWorkload(workload, actor);
          if (!first.externalId) throw new Error('placement did not return externalId');
          const second = await external.placeWorkload(workload, actor);
          if (second.externalId !== first.externalId) throw new Error('duplicate workload UID was not adopted');
          const status = await external.getWorkloadStatus(first.externalId);
          if (status.externalId !== first.externalId) throw new Error('workload status identity mismatch');
          const listed = await external.listWorkloads();
          if (!listed.some((entry) => entry.externalId === first.externalId)) {
            throw new Error('placed workload missing from listWorkloads');
          }
          await external.stopWorkload(first.externalId, actor);
        },
      },
      {
        name: 'executes, discovers, adopts, inspects, and cancels a tool operation',
        description: 'The tool lifecycle is independently addressable and duplicate UID submission is idempotent',
        run: async (driver) => {
          const external = driver as ExternalOrchestrationDriver;
          const operation = options.createToolOperation('external-conformance-tool');
          const first = await external.executeToolOperation(operation, actor);
          if (!first.externalId) throw new Error('execution did not return externalId');
          const second = await external.executeToolOperation(operation, actor);
          if (second.externalId !== first.externalId) throw new Error('duplicate tool UID was not adopted');
          const status = await external.getToolOperationStatus(first.externalId);
          if (status.externalId !== first.externalId) throw new Error('tool status identity mismatch');
          const listed = await external.listToolOperations();
          if (!listed.some((entry) => entry.externalId === first.externalId)) {
            throw new Error('placed tool operation missing from listToolOperations');
          }
          await external.cancelToolOperation(first.externalId, actor);
        },
      },
    ],
  };
}
