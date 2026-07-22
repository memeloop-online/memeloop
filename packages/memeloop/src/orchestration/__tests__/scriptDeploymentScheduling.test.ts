import { describe, expect, it } from 'vitest';

import type { ControlStoreActor } from '../controlStore.js';
import { createControlStoreOrchestrationClient } from '../controlStoreClient.js';
import { AGENT_WORKLOAD_API_VERSION, AGENT_WORKLOAD_KIND, type AgentWorkloadResource, type AgentWorkloadStatus } from '../resources.js';
import { createBindingController, createCapacityScheduler } from '../scheduler.js';
import { createScriptDeploymentClient, remoteDeploymentToWorkloadManifest } from '../scripts/scriptDeploymentPipeline.js';
import type { RemoteDeploymentRequest } from '../scripts/scriptRuntime.js';
import { QuorumControlStore } from '../stores/quorumControlStore.js';

const actor: ControlStoreActor = { id: 'controller/script-deployment-test', kind: 'controller' };
const VALID_SCRIPT = 'export default async function* myAgent(ctx) { yield "ok"; }';

function makeDeployment(overrides: Partial<RemoteDeploymentRequest> = {}): RemoteDeploymentRequest {
  return {
    artifactRef: {
      apiVersion: 'execution.memeloop.io/v1alpha1',
      kind: 'ArtifactRecord',
      name: 'script-deadbeef',
      namespace: 'fleet',
      contentDigest: 'sha256:deadbeef',
    },
    trustClass: 'restricted',
    lifecycle: 'service',
    runtimeClass: 'restricted-process',
    nodeSelector: { zone: 'lab' },
    ...overrides,
  };
}

describe('remoteDeploymentToWorkloadManifest', () => {
  it('maps trust, lifecycle, placement, runtimeClass, and digest reference', () => {
    const manifest = remoteDeploymentToWorkloadManifest(makeDeployment());

    expect(manifest.apiVersion).toBe(AGENT_WORKLOAD_API_VERSION);
    expect(manifest.kind).toBe(AGENT_WORKLOAD_KIND);
    expect(manifest.metadata.name).toBe('script-deadbeef');
    expect(manifest.metadata.namespace).toBe('fleet');
    expect(manifest.spec.scriptReference).toBe('sha256:deadbeef');
    expect(manifest.spec.trust).toBe('restricted');
    expect(manifest.spec.runtimeClass).toBe('restricted-process');
    expect(manifest.spec.completionPolicy).toBe('daemon');
    expect(manifest.spec.placement?.nodeSelector).toEqual({ zone: 'lab' });
  });

  it('maps run-once to complete and schedule to detach', () => {
    expect(remoteDeploymentToWorkloadManifest(makeDeployment({ lifecycle: 'run-once' })).spec.completionPolicy).toBe('complete');
    expect(remoteDeploymentToWorkloadManifest(makeDeployment({ lifecycle: 'schedule' })).spec.completionPolicy).toBe('detach');
  });

  it('carries non-secret env into the workload spec for the runtime driver', () => {
    const manifest = remoteDeploymentToWorkloadManifest(makeDeployment({ env: { MODE: 'service' } }));
    expect(manifest.spec.env).toEqual({ MODE: 'service' });
    expect(remoteDeploymentToWorkloadManifest(makeDeployment()).spec.env).toBeUndefined();
  });
});

describe('ScriptDeploymentClient scheduling consumption (plan 24.14)', () => {
  function makeSetup() {
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
    const orchestration = createControlStoreOrchestrationClient(store, actor);
    const client = createScriptDeploymentClient({
      authorTrust: 'restricted',
      orchestration,
      namespace: 'fleet',
    });
    return { store, orchestration, client };
  }

  const workloadRef = (name: string) => ({
    apiVersion: AGENT_WORKLOAD_API_VERSION,
    kind: AGENT_WORKLOAD_KIND,
    name,
    namespace: 'fleet',
  });

  it('deploy applies an AgentWorkload the binding controller can schedule', async () => {
    const { store, client } = makeSetup();

    const result = await client.deploy({ source: VALID_SCRIPT, lifecycle: 'run-once' });
    expect(result.deployed).toBe(true);
    expect(result.workload?.kind).toBe(AGENT_WORKLOAD_KIND);
    expect(result.workload?.spec.completionPolicy).toBe('complete');
    expect(result.workload?.spec.scriptReference).toBe(`sha256:${result.validation.digest}`);

    // The scheduler — not the script — binds the node.
    const controller = createBindingController(store, {
      actor,
      scheduler: createCapacityScheduler(),
      listNodes: async () => [{ name: 'node-1', trustClass: 'restricted', faultDomain: 'lab' }],
    });
    const ref = workloadRef(result.workload!.metadata.name);
    const pending = await store.get(ref);
    expect(pending).not.toBeNull();
    const reconcile = await controller.reconcile({
      resource: pending as unknown as AgentWorkloadResource,
      actor,
      leaseEpoch: '1',
      now: new Date('2026-07-22T12:00:00.000Z'),
    });
    expect(reconcile.status?.phase).toBe('Scheduling');
    await store.updateStatus(actor, ref, reconcile.status as AgentWorkloadStatus, {
      resourceVersion: pending!.metadata.resourceVersion,
    });

    // Readiness is watchable through the standard condition path.
    const scheduled = await client.waitForScheduled(result.workload!.metadata.name, { interval: 100, timeout: 5000 });
    expect(scheduled.matched).toBe(true);

    const bound = await store.get(ref);
    expect((bound?.status as AgentWorkloadStatus | undefined)?.conditions).toContainEqual({
      type: 'Scheduled',
      status: 'True',
      reason: 'BoundTo node-1',
      lastTransitionTime: '2026-07-22T12:00:00.000Z',
    });

    // Deletion is honored through the same client.
    await client.deleteDeployment(result.workload!.metadata.name);
    expect(await store.get(ref)).toBeNull();
  });

  it('re-deploying the same script is idempotent', async () => {
    const { client } = makeSetup();
    const first = await client.deploy({ source: VALID_SCRIPT, lifecycle: 'run-once' });
    const second = await client.deploy({ source: VALID_SCRIPT, lifecycle: 'run-once' });
    expect(second.workload?.metadata.resourceVersion).toBe(first.workload?.metadata.resourceVersion);
  });

  it('rejects readiness and deletion without an orchestration facade', async () => {
    const client = createScriptDeploymentClient({ authorTrust: 'trusted' });
    await expect(client.waitForScheduled('w1')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(client.deleteDeployment('w1')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});
