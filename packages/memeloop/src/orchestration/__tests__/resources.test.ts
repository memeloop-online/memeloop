import { describe, expect, it } from 'vitest';

import {
  AGENT_RUN_API_VERSION,
  AGENT_RUN_KIND,
  AGENT_WORKLOAD_API_VERSION,
  AGENT_WORKLOAD_KIND,
  agentRunReference,
  agentWorkloadReference,
  createAgentRunManifest,
  createAgentWorkloadManifest,
  isAgentRun,
  isAgentWorkload,
} from '../resources.js';

describe('orchestration resource helpers', () => {
  it('creates an AgentWorkload manifest with canonical apiVersion and kind', () => {
    const manifest = createAgentWorkloadManifest('reviewer', {
      profileId: 'memeloop:code-assistant',
      trust: 'restricted',
      placement: { nodeSelector: { gpu: 'true' } },
      ownerReferences: [{ apiVersion: 'run.memeloop.io/v1alpha1', kind: 'AgentRun', name: 'parent', uid: 'parent-uid' }],
    });

    expect(manifest).toEqual({
      apiVersion: AGENT_WORKLOAD_API_VERSION,
      kind: AGENT_WORKLOAD_KIND,
      metadata: { name: 'reviewer' },
      spec: {
        profileId: 'memeloop:code-assistant',
        trust: 'restricted',
        placement: { nodeSelector: { gpu: 'true' } },
        ownerReferences: [{ apiVersion: 'run.memeloop.io/v1alpha1', kind: 'AgentRun', name: 'parent', uid: 'parent-uid' }],
      },
    });
  });

  it('creates an AgentRun manifest referencing a workload', () => {
    const manifest = createAgentRunManifest('run-1', {
      workloadRef: agentWorkloadReference('reviewer', 'default'),
      retry: 2,
      timeoutMs: 30_000,
    });

    expect(manifest).toEqual({
      apiVersion: AGENT_RUN_API_VERSION,
      kind: AGENT_RUN_KIND,
      metadata: { name: 'run-1' },
      spec: {
        workloadRef: {
          apiVersion: AGENT_WORKLOAD_API_VERSION,
          kind: AGENT_WORKLOAD_KIND,
          name: 'reviewer',
          namespace: 'default',
        },
        retry: 2,
        timeoutMs: 30_000,
      },
    });
  });

  it('type-guards resources by apiVersion and kind', () => {
    const workload = createAgentWorkloadManifest('w', {});
    const run = createAgentRunManifest('r', { workloadRef: agentWorkloadReference('w') });
    const runRef = agentRunReference('r', 'default');

    expect(isAgentWorkload(workload)).toBe(true);
    expect(isAgentRun(workload)).toBe(false);
    expect(isAgentRun(run)).toBe(true);
    expect(isAgentWorkload(run)).toBe(false);
    expect(isAgentWorkload({ apiVersion: 'other/v1', kind: 'AgentWorkload' })).toBe(false);
    expect(runRef).toEqual({
      apiVersion: AGENT_RUN_API_VERSION,
      kind: AGENT_RUN_KIND,
      name: 'r',
      namespace: 'default',
    });
  });
});
