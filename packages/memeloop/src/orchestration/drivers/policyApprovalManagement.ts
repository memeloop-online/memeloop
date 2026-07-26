import { OrchestrationError } from '../errors.js';
import type { NodeTrustClass, ToolOperationEffect } from '../resources.js';

import type { DriverConformanceSuite } from './driverConformance.js';
import { assertDriverRequestEnvelope, type DriverRequestEnvelope } from './driverRequest.js';

export type PolicyDecisionKind =
  | 'resource-admission'
  | 'placement'
  | 'tool-operation'
  | 'approval'
  | 'transition';
export type PolicyDecisionOutcome = 'allow' | 'deny' | 'pending';

export interface PolicyApprovalCapabilities {
  name: string;
  decisions: PolicyDecisionKind[];
  defaultOutcome: 'deny';
  supportsDurableApproval: boolean;
  supportsExplanation: boolean;
  persistence: 'process' | 'host' | 'external';
  threatAssumptions: string[];
}

export interface PolicyDecision {
  decisionHandle: string;
  resourceUid: string;
  kind: PolicyDecisionKind;
  outcome: PolicyDecisionOutcome;
  policyDigest: string;
  inputDigest: string;
  actorId: string;
  reasons: string[];
  obligations: string[];
  decidedAt: string;
  approval?: {
    subjectDigest: string;
    requestedBy: string;
    requestedAt: string;
    expiresAt: string;
    decidedBy?: string;
    resolvedAt?: string;
    resolutionInputDigest?: string;
  };
}

export interface PolicyExplanation {
  decision: PolicyDecision;
  summary: string;
}

export interface PolicyApprovalManagementDriver {
  getCapabilities(): Promise<PolicyApprovalCapabilities>;
  admitResource(
    request: DriverRequestEnvelope<{
      policyDigest: string;
      resourceApiVersion: string;
      resourceKind: string;
    }>,
  ): Promise<PolicyDecision>;
  authorizePlacement(
    request: DriverRequestEnvelope<{
      policyDigest: string;
      nodeId: string;
      nodeTrustClass: NodeTrustClass;
      requiredTrustClass: NodeTrustClass;
      attested: boolean;
      driverConformancePassed: boolean;
    }>,
  ): Promise<PolicyDecision>;
  authorizeToolOperation(
    request: DriverRequestEnvelope<{
      policyDigest: string;
      toolName: string;
      effect: ToolOperationEffect;
      operationDigest: string;
      approvalDecisionHandle?: string;
    }>,
  ): Promise<PolicyDecision>;
  requestApproval(
    request: DriverRequestEnvelope<{
      policyDigest: string;
      subjectKind: 'tool-operation' | 'resource' | 'placement' | 'transition';
      subjectDigest: string;
      reason: string;
      ttlMs: number;
    }>,
  ): Promise<PolicyDecision>;
  resolveApproval(
    request: DriverRequestEnvelope<{
      approvalDecisionHandle: string;
      outcome: 'allow' | 'deny';
      reason: string;
    }>,
  ): Promise<PolicyDecision>;
  verifyTransition(
    request: DriverRequestEnvelope<{
      policyDigest: string;
      transition: string;
      from: string;
      to: string;
      evidenceDigest: string;
    }>,
  ): Promise<PolicyDecision>;
  explainDecision(
    request: DriverRequestEnvelope<{ decisionHandle: string }>,
  ): Promise<PolicyExplanation>;
}

export interface FakePolicyApprovalState {
  decisions: Map<string, PolicyDecision>;
  idempotency: Map<string, string>;
  idempotencyFingerprints: Map<string, string>;
  fences: Map<string, number>;
  nextHandle: number;
}

export function createFakePolicyApprovalState(): FakePolicyApprovalState {
  return {
    decisions: new Map(),
    idempotency: new Map(),
    idempotencyFingerprints: new Map(),
    fences: new Map(),
    nextHandle: 1,
  };
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TRUST_RANK: Record<NodeTrustClass, number> = {
  quarantine: 0,
  restricted: 1,
  trusted: 2,
};

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function requiredString(value: unknown, field: string): string {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as Record<string, unknown>)[field] !== 'string' ||
    !(value as Record<string, string>)[field]
  ) invalid(`policy payload '${field}' is required`);
  return (value as Record<string, string>)[field];
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
        .join(',')
    }}`;
  }
  return JSON.stringify(value) ?? typeof value;
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stable(value));
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${
    [...new Uint8Array(result)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }`;
}

/**
 * Deterministic, durable-state policy reference. Its allow rules are explicit
 * constructor-owned configuration; request payloads can never grant authority.
 */
export function createFakePolicyApprovalManagementDriver(options: {
  state?: FakePolicyApprovalState;
  now?: () => Date;
  admittedResourceTypes?: Array<{ apiVersion: string; kind: string }>;
  allowedTools?: string[];
  allowedTransitions?: string[];
} = {}): PolicyApprovalManagementDriver {
  const state = options.state ?? createFakePolicyApprovalState();
  const now = options.now ?? (() => new Date());
  const admittedResourceTypes = new Set(
    (options.admittedResourceTypes ?? [
      { apiVersion: 'workload.memeloop.io/v1alpha1', kind: 'AgentWorkload' },
      { apiVersion: 'execution.memeloop.io/v1alpha1', kind: 'ToolOperation' },
    ]).map(({ apiVersion, kind }) => `${apiVersion}/${kind}`),
  );
  const allowedTools = new Set(options.allowedTools ?? ['fs.read', 'fs.write']);
  const allowedTransitions = new Set(
    options.allowedTransitions ?? [
      'ArtifactRecord:quarantined->verified',
      'Node:restricted->trusted',
    ],
  );

  function validate<T>(
    request: DriverRequestEnvelope<T>,
    expectedMethod: string,
    actorKinds: Array<'controller' | 'verifier' | 'admin'>,
  ): void {
    assertDriverRequestEnvelope(request, {
      now,
      requireFencing: true,
      requireCapability: true,
      expectedMethod,
    });
    if (!actorKinds.includes(request.actor.kind)) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `actor kind '${request.actor.kind}' cannot call ${expectedMethod}`,
        retryable: false,
      });
    }
    const epoch = request.fencingEpoch as number;
    const current = state.fences.get(request.resource.uid) ?? 0;
    if (epoch < current) {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: `stale policy fencing epoch ${epoch}; current epoch is ${current}`,
        retryable: false,
      });
    }
    state.fences.set(request.resource.uid, epoch);
  }

  function assertPolicyDigest(value: string): void {
    if (!SHA256.test(value)) invalid('policyDigest must be a canonical sha256 digest');
  }

  function owned(handle: string, resourceUid: string): PolicyDecision {
    const decision = state.decisions.get(handle);
    if (!decision) {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `policy decision '${handle}' was not found`,
        retryable: false,
      });
    }
    if (decision.resourceUid !== resourceUid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `policy decision '${handle}' belongs to another resource`,
        retryable: false,
      });
    }
    return decision;
  }

  async function decide(
    request: DriverRequestEnvelope,
    operation: string,
    kind: PolicyDecisionKind,
    outcome: PolicyDecisionOutcome,
    policyDigest: string,
    reasons: string[],
    obligations: string[] = [],
    approval?: PolicyDecision['approval'],
  ): Promise<PolicyDecision> {
    assertPolicyDigest(policyDigest);
    const key = `${request.resource.uid}:${operation}:${request.idempotencyKey}`;
    const fingerprint = stable(request.payload);
    const previousHandle = state.idempotency.get(key);
    if (previousHandle) {
      if (state.idempotencyFingerprints.get(key) !== fingerprint) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: `policy ${operation} idempotency key was reused with different input`,
          retryable: false,
        });
      }
      return structuredClone(owned(previousHandle, request.resource.uid));
    }
    const decision: PolicyDecision = {
      decisionHandle: `policy-decision:${state.nextHandle++}`,
      resourceUid: request.resource.uid,
      kind,
      outcome,
      policyDigest,
      inputDigest: await digest(request.payload),
      actorId: request.actor.id,
      reasons,
      obligations,
      decidedAt: now().toISOString(),
      approval,
    };
    state.decisions.set(decision.decisionHandle, decision);
    state.idempotency.set(key, decision.decisionHandle);
    state.idempotencyFingerprints.set(key, fingerprint);
    return structuredClone(decision);
  }

  return {
    async getCapabilities() {
      return {
        name: 'fake-policy-approval',
        decisions: [
          'resource-admission',
          'placement',
          'tool-operation',
          'approval',
          'transition',
        ],
        defaultOutcome: 'deny',
        supportsDurableApproval: true,
        supportsExplanation: true,
        persistence: 'host',
        threatAssumptions: [
          'the injected state, policy configuration, and authenticated actors are trusted',
        ],
      };
    },
    async admitResource(request) {
      validate(request, 'policy.admit-resource', ['controller', 'admin']);
      const policyDigest = requiredString(request.payload, 'policyDigest');
      const resourceApiVersion = requiredString(request.payload, 'resourceApiVersion');
      const resourceKind = requiredString(request.payload, 'resourceKind');
      const allowed = admittedResourceTypes.has(`${resourceApiVersion}/${resourceKind}`);
      return decide(
        request,
        'admit-resource',
        'resource-admission',
        allowed ? 'allow' : 'deny',
        policyDigest,
        [
          allowed
            ? `trusted policy admits ${resourceApiVersion}/${resourceKind}`
            : `trusted policy does not admit ${resourceApiVersion}/${resourceKind}`,
        ],
      );
    },
    async authorizePlacement(request) {
      validate(request, 'policy.authorize-placement', ['controller', 'admin']);
      const policyDigest = requiredString(request.payload, 'policyDigest');
      const nodeId = requiredString(request.payload, 'nodeId');
      const trust = request.payload.nodeTrustClass;
      const required = request.payload.requiredTrustClass;
      if (!(trust in TRUST_RANK) || !(required in TRUST_RANK)) {
        invalid('placement trust class is invalid');
      }
      const allowed = request.payload.attested &&
        request.payload.driverConformancePassed &&
        TRUST_RANK[trust] >= TRUST_RANK[required];
      const reasons = allowed
        ? [`node '${nodeId}' satisfies attestation, conformance, and trust requirements`]
        : [`node '${nodeId}' fails attestation, conformance, or trust requirements`];
      return decide(
        request,
        'authorize-placement',
        'placement',
        allowed ? 'allow' : 'deny',
        policyDigest,
        reasons,
        allowed ? ['scheduler must revalidate the decision before binding'] : [],
      );
    },
    async authorizeToolOperation(request) {
      validate(request, 'policy.authorize-tool-operation', ['controller', 'admin']);
      const policyDigest = requiredString(request.payload, 'policyDigest');
      const toolName = requiredString(request.payload, 'toolName');
      const operationDigest = requiredString(request.payload, 'operationDigest');
      const effect = request.payload.effect;
      if (!SHA256.test(operationDigest)) invalid('tool operationDigest is invalid');
      if (!['read', 'create', 'update', 'delete', 'execute', 'unknown'].includes(effect)) {
        invalid('tool operation effect is invalid');
      }
      let approval: PolicyDecision | undefined;
      if (request.payload.approvalDecisionHandle) {
        approval = owned(request.payload.approvalDecisionHandle, request.resource.uid);
      }
      const needsApproval = effect !== 'read';
      const approvalValid = !needsApproval ||
        (approval?.kind === 'approval' &&
          approval.outcome === 'allow' &&
          approval.policyDigest === policyDigest &&
          approval.approval?.subjectDigest === operationDigest &&
          Date.parse(approval.approval.expiresAt) > now().getTime());
      const allowed = allowedTools.has(toolName) && approvalValid;
      return decide(
        request,
        'authorize-tool-operation',
        'tool-operation',
        allowed ? 'allow' : 'deny',
        policyDigest,
        [
          !allowedTools.has(toolName)
            ? `tool '${toolName}' is not allowed by trusted policy`
            : !approvalValid
            ? `effect '${effect}' requires an approved decision under the same policy`
            : `tool '${toolName}' and effect '${effect}' are authorized`,
        ],
        allowed ? ['worker-local permission and capability checks remain required'] : [],
      );
    },
    async requestApproval(request) {
      validate(request, 'policy.request-approval', ['controller', 'admin']);
      const policyDigest = requiredString(request.payload, 'policyDigest');
      const subjectDigest = requiredString(request.payload, 'subjectDigest');
      requiredString(request.payload, 'reason');
      if (!SHA256.test(subjectDigest)) invalid('approval subjectDigest is invalid');
      if (
        !Number.isSafeInteger(request.payload.ttlMs) ||
        request.payload.ttlMs < 1 ||
        request.payload.ttlMs > 15 * 60_000
      ) invalid('approval ttlMs must be between 1 and 900000');
      const requestedAt = now();
      return decide(
        request,
        'request-approval',
        'approval',
        'pending',
        policyDigest,
        ['approval awaits an authenticated administrator decision'],
        ['deny if unresolved or expired'],
        {
          subjectDigest,
          requestedBy: request.actor.id,
          requestedAt: requestedAt.toISOString(),
          expiresAt: new Date(requestedAt.getTime() + request.payload.ttlMs).toISOString(),
        },
      );
    },
    async resolveApproval(request) {
      validate(request, 'policy.resolve-approval', ['admin']);
      const handle = requiredString(request.payload, 'approvalDecisionHandle');
      const reason = requiredString(request.payload, 'reason');
      if (!['allow', 'deny'].includes(request.payload.outcome)) {
        invalid('approval outcome must be allow or deny');
      }
      const decision = owned(handle, request.resource.uid);
      if (decision.kind !== 'approval') invalid('decision is not an approval');
      if (
        decision.approval &&
        Date.parse(decision.approval.expiresAt) <= now().getTime()
      ) {
        decision.outcome = 'deny';
        decision.reasons = ['approval expired before resolution'];
        decision.decidedAt = now().toISOString();
        decision.approval.resolvedAt = now().toISOString();
        throw new OrchestrationError({
          code: 'TIMEOUT',
          message: 'approval expired before resolution',
          retryable: false,
        });
      }
      if (decision.outcome !== 'pending') {
        if (decision.outcome !== request.payload.outcome) {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: 'resolved approval outcome is immutable',
            retryable: false,
          });
        }
        return structuredClone(decision);
      }
      decision.outcome = request.payload.outcome;
      decision.reasons = [reason];
      decision.decidedAt = now().toISOString();
      decision.actorId = request.actor.id;
      decision.approval = {
        ...(decision.approval as NonNullable<PolicyDecision['approval']>),
        decidedBy: request.actor.id,
        resolvedAt: now().toISOString(),
        resolutionInputDigest: await digest(request.payload),
      };
      return structuredClone(decision);
    },
    async verifyTransition(request) {
      validate(request, 'policy.verify-transition', ['verifier']);
      const policyDigest = requiredString(request.payload, 'policyDigest');
      const transition = requiredString(request.payload, 'transition');
      const from = requiredString(request.payload, 'from');
      const to = requiredString(request.payload, 'to');
      const evidenceDigest = requiredString(request.payload, 'evidenceDigest');
      if (!SHA256.test(evidenceDigest)) invalid('transition evidenceDigest is invalid');
      const transitionKey = `${transition}:${from}->${to}`;
      const allowed = allowedTransitions.has(transitionKey);
      return decide(
        request,
        'verify-transition',
        'transition',
        allowed ? 'allow' : 'deny',
        policyDigest,
        [
          allowed
            ? `verifier evidence permits ${transitionKey}`
            : `trusted transition policy does not permit ${transitionKey}`,
        ],
        allowed ? ['ControlStore CAS must bind the unchanged evidence digest'] : [],
      );
    },
    async explainDecision(request) {
      validate(request, 'policy.explain-decision', [
        'controller',
        'verifier',
        'admin',
      ]);
      const decision = owned(
        requiredString(request.payload, 'decisionHandle'),
        request.resource.uid,
      );
      return {
        decision: structuredClone(decision),
        summary: `${decision.kind} ${decision.outcome}: ${decision.reasons.join('; ')}`,
      };
    },
  };
}

export function createPolicyApprovalConformanceSuite(options: {
  createRequest<T>(
    method: string,
    payload: T,
    idempotencyKey: string,
    fencingEpoch?: number,
    resourceUid?: string,
    actorKind?: 'controller' | 'verifier' | 'admin',
  ): DriverRequestEnvelope<T>;
  recreate(driver: PolicyApprovalManagementDriver): PolicyApprovalManagementDriver;
}): DriverConformanceSuite {
  const policyDigest = `sha256:${'a'.repeat(64)}`;
  return {
    interfaceKind: 'policy-approval',
    tests: [
      {
        name: 'declares default-deny durable and explainable capabilities',
        description: 'The security and persistence posture is explicit',
        run: async (value) => {
          const capabilities = await (value as PolicyApprovalManagementDriver)
            .getCapabilities();
          if (
            capabilities.decisions.length !== 5 ||
            capabilities.defaultOutcome !== 'deny' ||
            !capabilities.supportsDurableApproval ||
            !capabilities.supportsExplanation ||
            !capabilities.threatAssumptions.length
          ) throw new Error('policy capabilities are incomplete');
        },
      },
      {
        name: 'resource and placement admission are trusted and default deny',
        description: 'Caller data cannot self-authorize unsupported work',
        run: async (value) => {
          const driver = value as PolicyApprovalManagementDriver;
          const admitted = await driver.admitResource(options.createRequest(
            'policy.admit-resource',
            {
              policyDigest,
              resourceApiVersion: 'workload.memeloop.io/v1alpha1',
              resourceKind: 'AgentWorkload',
            },
            'admit',
          ));
          const denied = await driver.admitResource(options.createRequest(
            'policy.admit-resource',
            { policyDigest, resourceApiVersion: 'evil/v1', resourceKind: 'AgentWorkload' },
            'deny',
          ));
          const placement = await driver.authorizePlacement(options.createRequest(
            'policy.authorize-placement',
            {
              policyDigest,
              nodeId: 'node-1',
              nodeTrustClass: 'restricted' as const,
              requiredTrustClass: 'trusted' as const,
              attested: true,
              driverConformancePassed: true,
            },
            'placement',
          ));
          if (
            admitted.outcome !== 'allow' || denied.outcome !== 'deny' ||
            placement.outcome !== 'deny'
          ) throw new Error('admission did not fail closed');
        },
      },
      {
        name: 'approval is durable, immutable, and binds tool authorization',
        description: 'Only authenticated approval under the same policy unlocks effects',
        run: async (value) => {
          let driver = value as PolicyApprovalManagementDriver;
          const approval = await driver.requestApproval(options.createRequest(
            'policy.request-approval',
            {
              policyDigest,
              subjectKind: 'tool-operation' as const,
              subjectDigest: `sha256:${'b'.repeat(64)}`,
              reason: 'write requested',
              ttlMs: 60_000,
            },
            'approval',
          ));
          if (approval.outcome !== 'pending') throw new Error('approval is not pending');
          driver = options.recreate(driver);
          const resolved = await driver.resolveApproval(options.createRequest(
            'policy.resolve-approval',
            {
              approvalDecisionHandle: approval.decisionHandle,
              outcome: 'allow' as const,
              reason: 'authenticated operator approved',
            },
            'resolve',
            1,
            'policy-uid-1',
            'admin',
          ));
          const replayedForAnotherOperation = await driver.authorizeToolOperation(
            options.createRequest(
              'policy.authorize-tool-operation',
              {
                policyDigest,
                toolName: 'fs.write',
                effect: 'update' as const,
                operationDigest: `sha256:${'e'.repeat(64)}`,
                approvalDecisionHandle: resolved.decisionHandle,
              },
              'tool-replay',
            ),
          );
          const authorization = await driver.authorizeToolOperation(options.createRequest(
            'policy.authorize-tool-operation',
            {
              policyDigest,
              toolName: 'fs.write',
              effect: 'update' as const,
              operationDigest: `sha256:${'b'.repeat(64)}`,
              approvalDecisionHandle: resolved.decisionHandle,
            },
            'tool',
          ));
          if (
            replayedForAnotherOperation.outcome !== 'deny' ||
            authorization.outcome !== 'allow' ||
            !resolved.approval?.decidedBy ||
            !resolved.approval.resolutionInputDigest
          ) {
            throw new Error('approval did not authorize the operation');
          }
        },
      },
      {
        name: 'transition verification is verifier-only and explainable',
        description: 'Sensitive transitions require verifier evidence',
        run: async (value) => {
          const driver = value as PolicyApprovalManagementDriver;
          await driver.verifyTransition(options.createRequest(
            'policy.verify-transition',
            {
              policyDigest,
              transition: 'ArtifactRecord',
              from: 'quarantined',
              to: 'verified',
              evidenceDigest: `sha256:${'c'.repeat(64)}`,
            },
            'transition',
            1,
            'policy-uid-1',
            'verifier',
          ));
          const decision = await driver.admitResource(options.createRequest(
            'policy.admit-resource',
            { policyDigest, resourceApiVersion: 'unsupported/v1', resourceKind: 'Unknown' },
            'explain-source',
          ));
          const explanation = await driver.explainDecision(options.createRequest(
            'policy.explain-decision',
            { decisionHandle: decision.decisionHandle },
            'explain',
          ));
          if (!explanation.summary.includes('deny') || !decision.inputDigest.startsWith('sha256:')) {
            throw new Error('decision explanation is incomplete');
          }
          await driver.verifyTransition(options.createRequest(
            'policy.verify-transition',
            {
              policyDigest,
              transition: 'ArtifactRecord',
              from: 'quarantined',
              to: 'verified',
              evidenceDigest: `sha256:${'c'.repeat(64)}`,
            },
            'wrong-actor',
          )).then(
            () => {
              throw new Error('controller verified a protected transition');
            },
            () => undefined,
          );
        },
      },
      {
        name: 'restart, idempotency, ownership, and fencing fail closed',
        description: 'Distributed retries converge without weakening isolation',
        run: async (value) => {
          let driver = value as PolicyApprovalManagementDriver;
          const request = options.createRequest(
            'policy.admit-resource',
            {
              policyDigest,
              resourceApiVersion: 'workload.memeloop.io/v1alpha1',
              resourceKind: 'AgentWorkload',
            },
            'durable',
            3,
          );
          const first = await driver.admitResource(request);
          driver = options.recreate(driver);
          const retry = await driver.admitResource(request);
          if (first.decisionHandle !== retry.decisionHandle) throw new Error('retry diverged');
          await driver.admitResource({
            ...request,
            payload: { ...request.payload, resourceKind: 'ToolOperation' },
          }).then(
            () => {
              throw new Error('idempotency drift was accepted');
            },
            () => undefined,
          );
          await driver.explainDecision(options.createRequest(
            'policy.explain-decision',
            { decisionHandle: first.decisionHandle },
            'foreign',
            3,
            'foreign-policy-uid',
          )).then(
            () => {
              throw new Error('foreign decision was disclosed');
            },
            () => undefined,
          );
          await driver.admitResource(options.createRequest(
            'policy.admit-resource',
            {
              policyDigest,
              resourceApiVersion: 'workload.memeloop.io/v1alpha1',
              resourceKind: 'AgentWorkload',
            },
            'stale',
            2,
          )).then(
            () => {
              throw new Error('stale fencing epoch was accepted');
            },
            () => undefined,
          );
        },
      },
    ],
  };
}
