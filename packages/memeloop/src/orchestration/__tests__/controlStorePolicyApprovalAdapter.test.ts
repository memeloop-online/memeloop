import { describe, expect, it, vi } from 'vitest';

import { createControlStorePolicyApprovalAdapter } from '../drivers/controlStorePolicyApprovalAdapter.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import type { PolicyApprovalManagementDriver } from '../drivers/policyApprovalManagement.js';
import { POLICY_DECISION_API_VERSION, POLICY_DECISION_KIND, type PolicyDecisionResource } from '../resources.js';
import { createPolicyDecisionAuthorizer } from '../security/policyDecisionAuthorizer.js';
import { QuorumControlStore } from '../stores/quorumControlStore.js';

const now = () => new Date('2026-07-27T05:00:00.000Z');
const policyDigest = `sha256:${'a'.repeat(64)}`;
const operationDigest = `sha256:${'b'.repeat(64)}`;

function request<T>(
  method: string,
  payload: T,
  idempotencyKey: string,
  actorKind: 'controller' | 'admin' | 'verifier' = 'controller',
  fencingEpoch = 1,
  resourceUid = 'tool-operation-uid',
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'execution.memeloop.io/v1alpha1',
      kind: 'ToolOperation',
      name: resourceUid,
      uid: resourceUid,
      generation: 1,
    },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-27T05:01:00.000Z',
    actor: { id: `${actorKind}/policy-test`, kind: actorKind },
    session: { id: 'policy-session' },
    capabilityHandleRef: 'capability:policy',
    trace: { traceId: 'trace-policy', spanId: idempotencyKey },
    payloadSchemaDigest: `sha256:${'c'.repeat(64)}`,
    payload,
  };
}

function createDriver(
  store: QuorumControlStore,
  evaluateToolOperation = vi.fn(
    async (
      _request: Parameters<
        PolicyApprovalManagementDriver['authorizeToolOperation']
      >[0],
      approval:
        | Awaited<
          ReturnType<PolicyApprovalManagementDriver['requestApproval']>
        >
        | undefined,
    ) => ({
      outcome: approval?.outcome === 'allow' ? 'allow' as const : 'deny' as const,
      reasons: [
        approval?.outcome === 'allow'
          ? 'trusted approval and host tool policy allow execution'
          : 'trusted approval is required',
      ],
    }),
  ),
  currentNow: () => Date = now,
) {
  return {
    driver: createControlStorePolicyApprovalAdapter({
      store,
      name: 'control-store-policy',
      now: currentNow,
      persistence: 'host',
      authorizeRequest: (value) =>
        value.capabilityHandleRef === 'capability:policy' &&
        value.session?.id === 'policy-session',
      evaluateToolOperation,
      threatAssumptions: [
        'the ControlStore, controller request factory, policy evaluator, and approval UI are trusted',
      ],
    }),
    evaluateToolOperation,
  };
}

describe('ControlStore production Policy/Approval adapter', () => {
  it('persists approval and tool decisions and explains them after recreation', async () => {
    const store = new QuorumControlStore({
      memberId: 'policy-1',
      voters: ['policy-1'],
      authorizer: { authorize: createPolicyDecisionAuthorizer() },
    });
    const first = createDriver(store);
    const pending = await first.driver.requestApproval(request(
      'policy.request-approval',
      {
        policyDigest,
        subjectKind: 'tool-operation' as const,
        subjectDigest: operationDigest,
        reason: 'filesystem update requires user approval',
        ttlMs: 60_000,
      },
      'approval',
    ));
    expect(pending).toMatchObject({
      kind: 'approval',
      outcome: 'pending',
      actorId: 'controller/policy-test',
    });
    const pendingResource = await store.get({
      apiVersion: POLICY_DECISION_API_VERSION,
      kind: POLICY_DECISION_KIND,
      name: pending.decisionHandle.slice('policy-decision:'.length),
    });
    await expect(store.updateStatus(
      { id: 'controller/forged-approval', kind: 'controller' },
      {
        apiVersion: POLICY_DECISION_API_VERSION,
        kind: POLICY_DECISION_KIND,
        name: pendingResource!.metadata.name,
      },
      {
        outcome: 'allow',
        decidedBy: 'controller/forged-approval',
        decidedAt: now().toISOString(),
        reasons: ['forged'],
        resolutionInputDigest: `sha256:${'f'.repeat(64)}`,
      },
      { resourceVersion: pendingResource!.metadata.resourceVersion },
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const approved = await first.driver.resolveApproval(request(
      'policy.resolve-approval',
      {
        approvalDecisionHandle: pending.decisionHandle,
        outcome: 'allow' as const,
        reason: 'approved in authenticated host UI',
      },
      'resolve',
      'admin',
    ));
    expect(approved).toMatchObject({
      outcome: 'allow',
      actorId: 'admin/policy-test',
      approval: { subjectDigest: operationDigest },
    });

    const tool = await first.driver.authorizeToolOperation(request(
      'policy.authorize-tool-operation',
      {
        policyDigest,
        toolName: 'fs.write',
        effect: 'update' as const,
        operationDigest,
        approvalDecisionHandle: pending.decisionHandle,
      },
      'tool',
    ));
    expect(tool).toMatchObject({
      kind: 'tool-operation',
      outcome: 'allow',
      policyDigest,
    });
    expect(first.evaluateToolOperation).toHaveBeenCalledOnce();

    const recreated = createDriver(store).driver;
    await expect(recreated.explainDecision(request(
      'policy.explain-decision',
      { decisionHandle: tool.decisionHandle },
      'explain',
    ))).resolves.toMatchObject({
      decision: { decisionHandle: tool.decisionHandle, outcome: 'allow' },
      summary: expect.stringContaining('tool-operation allow'),
    });
    const persisted = await store.list({
      apiVersion: POLICY_DECISION_API_VERSION,
      kind: POLICY_DECISION_KIND,
    });
    expect(persisted.items as PolicyDecisionResource[]).toHaveLength(2);
  });

  it('rejects capability, idempotency, approval scope, and stale fencing drift', async () => {
    const store = new QuorumControlStore({
      memberId: 'policy-2',
      voters: ['policy-2'],
      authorizer: { authorize: createPolicyDecisionAuthorizer() },
    });
    const { driver } = createDriver(store);
    const approvalRequest = request(
      'policy.request-approval',
      {
        policyDigest,
        subjectKind: 'tool-operation' as const,
        subjectDigest: operationDigest,
        reason: 'approval',
        ttlMs: 60_000,
      },
      'stable',
      'controller',
      2,
    );
    const pending = await driver.requestApproval(approvalRequest);
    await expect(driver.requestApproval({
      ...approvalRequest,
      payload: {
        ...approvalRequest.payload,
        subjectDigest: `sha256:${'d'.repeat(64)}`,
      },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(driver.resolveApproval({
      ...request(
        'policy.resolve-approval',
        {
          approvalDecisionHandle: pending.decisionHandle,
          outcome: 'allow' as const,
          reason: 'forged',
        },
        'wrong-capability',
        'admin',
        2,
      ),
      capabilityHandleRef: 'capability:wrong',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(driver.explainDecision(request(
      'policy.explain-decision',
      { decisionHandle: pending.decisionHandle },
      'stale',
      'controller',
      1,
    ))).rejects.toMatchObject({ code: 'STALE_EPOCH' });
    await expect(driver.explainDecision(request(
      'policy.explain-decision',
      { decisionHandle: pending.decisionHandle },
      'foreign',
      'controller',
      2,
      'foreign-uid',
    ))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('treats an unresolved durable approval as denied after expiry', async () => {
    const store = new QuorumControlStore({
      memberId: 'policy-3',
      voters: ['policy-3'],
      authorizer: { authorize: createPolicyDecisionAuthorizer() },
    });
    let current = new Date('2026-07-27T05:00:00.000Z');
    const first = createDriver(store, undefined, () => current).driver;
    const pending = await first.requestApproval(request(
      'policy.request-approval',
      {
        policyDigest,
        subjectKind: 'tool-operation' as const,
        subjectDigest: operationDigest,
        reason: 'approval',
        ttlMs: 1000,
      },
      'expiring',
    ));
    expect(pending.outcome).toBe('pending');

    current = new Date('2026-07-27T05:00:02.000Z');
    const recreated = createDriver(store, undefined, () => current).driver;
    await expect(recreated.explainDecision(request(
      'policy.explain-decision',
      { decisionHandle: pending.decisionHandle },
      'expired-explanation',
    ))).resolves.toMatchObject({
      decision: {
        outcome: 'deny',
        reasons: ['approval expired without an administrator resolution'],
      },
    });
  });
});
