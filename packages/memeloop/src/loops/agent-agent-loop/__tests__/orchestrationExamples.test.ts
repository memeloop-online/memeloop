import { describe, expect, it, vi } from 'vitest';

import {
  BUILTIN_AGENT_AGENT_LOOP_ARTIFACT_RESOURCE_LIFECYCLE_SCRIPT_ID,
  BUILTIN_AGENT_AGENT_LOOP_DECLARATIVE_AGENT_RUN_SCRIPT_ID,
} from '../../../loopAPI/agent-agent-loop/index.js';
import { createAgentAgentLoopDefinition } from '../../../loopAPI/agent-agent-loop/loop.js';
import type { AgentLoopGenerator, AgentLoopStep } from '../../../loopAPI/types.js';
import type { AgentOrchestrationClient, OrchestrationResource, OrchestrationResourceManifest, OrchestrationResourceWatchEvent } from '../../../orchestration/index.js';

async function collect(generator: AgentLoopGenerator): Promise<AgentLoopStep[]> {
  const steps: AgentLoopStep[] = [];
  for await (const step of generator) steps.push(step);
  return steps;
}

function resourceFromManifest(
  manifest: OrchestrationResourceManifest,
  resourceVersion: string,
  status?: Record<string, unknown>,
): OrchestrationResource {
  return {
    ...manifest,
    metadata: {
      ...manifest.metadata,
      name: manifest.metadata.name ?? 'generated',
      namespace: manifest.metadata.namespace ?? 'default',
      uid: `${manifest.kind.toLowerCase()}-${resourceVersion}`,
      generation: 1,
      resourceVersion,
      creationTimestamp: '2026-07-20T00:00:00.000Z',
    },
    status,
  } as OrchestrationResource;
}

describe('orchestration .mjs examples', () => {
  it('creates a policy-scoped workload and run through ctx.agentClient', async () => {
    const applied: Array<{ manifest: OrchestrationResourceManifest; options: Record<string, unknown> | undefined }> = [];
    const resources = new Map<string, OrchestrationResource>();
    const orchestration = {
      apply: vi.fn(async (manifest: OrchestrationResourceManifest, options?: Record<string, unknown>) => {
        const status = manifest.kind === 'AgentRun'
          ? { conditions: [{ type: 'Completed', status: 'True', reason: 'Test', lastTransitionTime: '2026-07-20T00:00:00.000Z' }] }
          : undefined;
        const resource = resourceFromManifest(manifest, String(applied.length + 1), status);
        applied.push({ manifest, options });
        resources.set(`${resource.kind}/${resource.metadata.name}`, resource);
        return resource;
      }),
      get: vi.fn(async (reference: { kind: string; name?: string }) => resources.get(`${reference.kind}/${reference.name}`) ?? null),
    } as unknown as AgentOrchestrationClient;
    const runner = createAgentAgentLoopDefinition().createRunner({
      profile: {
        id: 'example:declarative-agent-run',
        name: 'Declarative agent run example',
        description: 'Exercises the script-facing AgentClient.',
        loopId: 'agent-agent-loop',
        scriptReference: { kind: 'builtin', id: BUILTIN_AGENT_AGENT_LOOP_DECLARATIVE_AGENT_RUN_SCRIPT_ID },
        metadata: { childProfileId: 'worker:auditor', waitForCompletion: true },
      },
      runtime: { orchestration },
    });

    const steps = await collect(runner({ conversationId: 'acceptance-1', message: 'audit this change' }));

    expect(applied.map(({ manifest }) => manifest.kind)).toEqual(['AgentWorkload', 'AgentRun']);
    expect(applied[0]?.manifest.spec).toMatchObject({
      profileId: 'worker:auditor',
      trust: 'restricted',
      placement: { nodeSelector: { 'memeloop.io/worker-pool': 'restricted' } },
      toolPolicy: { defaultAction: 'deny', allowedToolClasses: ['read-only'] },
      networkPolicy: { networkClass: 'restricted-egress', egress: 'restricted' },
    });
    expect(applied.map(({ options }) => options?.idempotencyKey)).toEqual([
      'acceptance-1:workload',
      'acceptance-1:run',
    ]);
    expect(steps).toContainEqual({
      type: 'message',
      data: 'scheduled child-acceptance-1-workload/child-acceptance-1-run',
    });
  });

  it('runs ArtifactRecord apply/watch/get/list/delete with CAS preconditions', async () => {
    let stored: OrchestrationResource | undefined;
    let resolveWatch: ((event: OrchestrationResourceWatchEvent) => void) | undefined;
    const watchEvent = new Promise<OrchestrationResourceWatchEvent>((resolve) => {
      resolveWatch = resolve;
    });
    const delete_ = vi.fn(async () => ({
      accepted: true,
      reference: {
        apiVersion: stored?.apiVersion ?? '',
        kind: stored?.kind ?? '',
        name: stored?.metadata.name,
      },
    }));
    const orchestration = {
      watch: vi.fn(async function*() {
        yield await watchEvent;
      }),
      apply: vi.fn(async (manifest: OrchestrationResourceManifest) => {
        stored = resourceFromManifest(manifest, '41');
        resolveWatch?.({ type: 'ADDED', resourceVersion: '41', resource: stored });
        return stored;
      }),
      get: vi.fn(async () => stored ?? null),
      list: vi.fn(async () => ({ items: stored ? [stored] : [], resourceVersion: '41' })),
      delete: delete_,
    } as unknown as AgentOrchestrationClient;
    const runner = createAgentAgentLoopDefinition().createRunner({
      profile: {
        id: 'example:artifact-resource-lifecycle',
        name: 'Artifact resource lifecycle example',
        description: 'Exercises generic resource facade semantics.',
        loopId: 'agent-agent-loop',
        scriptReference: { kind: 'builtin', id: BUILTIN_AGENT_AGENT_LOOP_ARTIFACT_RESOURCE_LIFECYCLE_SCRIPT_ID },
        metadata: { contentHash: `sha256:${'a'.repeat(64)}` },
      },
      runtime: { orchestration },
    });

    const steps = await collect(runner({ conversationId: 'artifact-acceptance', message: 'store script' }));

    expect(stored).toMatchObject({
      apiVersion: 'artifacts.memeloop.io/v1alpha1',
      kind: 'ArtifactRecord',
      spec: {
        contentHash: `sha256:${'a'.repeat(64)}`,
        mimeType: 'text/javascript',
        producer: { trust: 'restricted' },
        trust: 'restricted',
      },
    });
    expect(delete_).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'artifactrecord-41' }),
      expect.objectContaining({
        preconditions: { uid: 'artifactrecord-41', resourceVersion: '41' },
      }),
    );
    expect(steps).toContainEqual({
      type: 'message',
      data: 'verified artifact lifecycle script-artifact-acceptance@41',
    });
  });

  it('fails explicitly when a host does not provide orchestration', async () => {
    const runner = createAgentAgentLoopDefinition().createRunner({
      profile: {
        id: 'example:missing-orchestration',
        name: 'Missing orchestration example',
        description: 'Verifies fail-closed behavior.',
        loopId: 'agent-agent-loop',
        scriptReference: { kind: 'builtin', id: BUILTIN_AGENT_AGENT_LOOP_DECLARATIVE_AGENT_RUN_SCRIPT_ID },
        metadata: { childProfileId: 'worker:auditor' },
      },
    });

    await expect(collect(runner({ conversationId: 'missing', message: 'run' })))
      .rejects.toThrow('requires the orchestration resource facade');
  });
});
