import type { ControlStore, ControlStoreActor } from '../controlStore.js';
import { OrchestrationError } from '../errors.js';
import {
  createPolicyDecisionManifest,
  POLICY_DECISION_API_VERSION,
  POLICY_DECISION_KIND,
  type PolicyDecisionResource,
  type PolicyDecisionSpec,
  type PolicyDecisionStatus,
} from '../resources.js';

import { assertDriverRequestEnvelope, canonicalDriverValue, type DriverRequestEnvelope } from './driverRequest.js';
import type { PolicyApprovalManagementDriver, PolicyDecision, PolicyDecisionKind } from './policyApprovalManagement.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/;

export interface PolicyEvaluation {
  outcome: 'allow' | 'deny';
  reasons: string[];
  obligations?: string[];
}

interface PersistedPolicyEvaluation {
  outcome: 'allow' | 'deny' | 'pending';
  reasons: string[];
  obligations?: string[];
}

export interface ControlStorePolicyApprovalAdapterOptions {
  store: ControlStore;
  name: string;
  authorizeRequest(request: DriverRequestEnvelope): boolean | Promise<boolean>;
  evaluateResourceAdmission?(
    request: Parameters<PolicyApprovalManagementDriver['admitResource']>[0],
  ): PolicyEvaluation | Promise<PolicyEvaluation>;
  evaluatePlacement?(
    request: Parameters<PolicyApprovalManagementDriver['authorizePlacement']>[0],
  ): PolicyEvaluation | Promise<PolicyEvaluation>;
  evaluateToolOperation?(
    request: Parameters<PolicyApprovalManagementDriver['authorizeToolOperation']>[0],
    approval: PolicyDecision | undefined,
  ): PolicyEvaluation | Promise<PolicyEvaluation>;
  evaluateTransition?(
    request: Parameters<PolicyApprovalManagementDriver['verifyTransition']>[0],
  ): PolicyEvaluation | Promise<PolicyEvaluation>;
  maxApprovalTtlMs?: number;
  now?: () => Date;
  persistence: 'host' | 'external';
  threatAssumptions: string[];
}

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function unsupported(message: string): never {
  throw new OrchestrationError({
    code: 'UNSUPPORTED',
    message,
    retryable: false,
  });
}

function exactFields(
  payload: unknown,
  allowed: readonly string[],
  location: string,
): void {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    invalid(`managed policy ${location} must be an object`);
  }
  const unknown = Object.keys(payload).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    invalid(`managed policy ${location} contains unsupported fields: ${unknown.join(', ')}`);
  }
}

function boundedString(
  value: unknown,
  field: string,
  maximum = 1024,
): string {
  if (typeof value !== 'string' || !value || value.length > maximum) {
    invalid(`managed policy ${field} is invalid`);
  }
  return value;
}

function canonicalDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalDriverValue(value));
  return globalThis.crypto.subtle.digest('SHA-256', bytes).then((result) =>
    `sha256:${
      [...new Uint8Array(result)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    }`
  );
}

function assertDigest(value: unknown, field: string): string {
  const digest = boundedString(value, field, 80);
  if (!SHA256.test(digest)) invalid(`managed policy ${field} must be canonical`);
  return digest;
}

function decisionName(fingerprintDigest: string): string {
  return `decision-${fingerprintDigest.slice('sha256:'.length, 62)}`;
}

function handleName(handle: string): string {
  const prefix = 'policy-decision:';
  if (!handle.startsWith(prefix)) invalid('managed policy decision handle is invalid');
  return boundedString(handle.slice(prefix.length), 'decision handle', 253);
}

function validateEvaluation(
  value: PersistedPolicyEvaluation,
): PersistedPolicyEvaluation {
  if (
    !value ||
    !['allow', 'deny', 'pending'].includes(value.outcome) ||
    !Array.isArray(value.reasons) ||
    value.reasons.length < 1 ||
    value.reasons.length > 16 ||
    value.reasons.some((reason) => typeof reason !== 'string' || !reason || reason.length > 1024) ||
    (value.obligations !== undefined &&
      (
        !Array.isArray(value.obligations) ||
        value.obligations.length > 16 ||
        value.obligations.some((obligation) =>
          typeof obligation !== 'string' ||
          !obligation ||
          obligation.length > 1024
        )
      ))
  ) invalid('managed policy evaluator returned invalid evidence');
  return value;
}

/**
 * Durable production Policy/Approval adapter. Policy outcomes come only from
 * host-injected evaluators or authenticated admin/verifier requests; caller
 * payloads contain no allow bit.
 */
export function createControlStorePolicyApprovalAdapter(
  options: ControlStorePolicyApprovalAdapterOptions,
): PolicyApprovalManagementDriver {
  const now = options.now ?? (() => new Date());
  const maxApprovalTtlMs = options.maxApprovalTtlMs ?? 15 * 60_000;
  if (
    !options.name ||
    !options.threatAssumptions.length ||
    !Number.isSafeInteger(maxApprovalTtlMs) ||
    maxApprovalTtlMs < 1
  ) invalid('managed policy adapter options are invalid');

  let mutations = Promise.resolve();

  async function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = mutations;
    let release!: () => void;
    mutations = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function authorize<T>(
    request: DriverRequestEnvelope<T>,
    method: string,
    fields: string[],
    actorKinds: ControlStoreActor['kind'][],
  ): Promise<void> {
    exactFields(request.payload, fields, `${method} payload`);
    assertDriverRequestEnvelope(request, {
      now,
      requireFencing: true,
      requireCapability: true,
      expectedMethod: method,
    });
    if (!actorKinds.includes(request.actor.kind)) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `managed policy actor kind '${request.actor.kind}' cannot call ${method}`,
        retryable: false,
      });
    }
    if (!await options.authorizeRequest(request)) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'managed policy capability was rejected',
        retryable: false,
      });
    }
    await rejectStaleFence(request);
  }

  async function resourceForHandle(
    handle: string,
    subjectUid: string,
  ): Promise<PolicyDecisionResource> {
    const resource = await options.store.get<PolicyDecisionSpec, PolicyDecisionStatus>({
      apiVersion: POLICY_DECISION_API_VERSION,
      kind: POLICY_DECISION_KIND,
      name: handleName(handle),
    }) as PolicyDecisionResource | null;
    if (!resource) {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: 'managed policy decision was not found',
        retryable: false,
      });
    }
    if (resource.spec.subjectRef.uid !== subjectUid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'managed policy decision belongs to another resource',
        retryable: false,
      });
    }
    return resource;
  }

  function toDecision(resource: PolicyDecisionResource): PolicyDecision {
    let status: PolicyDecisionStatus = resource.status ?? {
      outcome: resource.spec.initialOutcome,
      decidedBy: resource.spec.requestedBy,
      decidedAt: resource.spec.decidedAt,
      reasons: resource.spec.reasons,
    };
    if (
      status.outcome === 'pending' &&
      resource.spec.approval &&
      Date.parse(resource.spec.approval.expiresAt) <= now().getTime()
    ) {
      status = {
        outcome: 'deny',
        decidedBy: resource.spec.requestedBy,
        decidedAt: resource.spec.approval.expiresAt,
        reasons: ['approval expired without an administrator resolution'],
      };
    }
    return {
      decisionHandle: `policy-decision:${resource.metadata.name}`,
      resourceUid: resource.spec.subjectRef.uid,
      kind: resource.spec.decisionKind,
      outcome: status.outcome,
      policyDigest: resource.spec.policyDigest,
      inputDigest: resource.spec.inputDigest,
      actorId: status.decidedBy,
      reasons: status.reasons,
      obligations: resource.spec.obligations,
      decidedAt: status.decidedAt,
      ...(resource.spec.approval
        ? {
          approval: {
            ...resource.spec.approval,
            ...(status.outcome !== 'pending'
              ? {
                decidedBy: status.decidedBy,
                resolvedAt: status.decidedAt,
                ...(status.resolutionInputDigest
                  ? { resolutionInputDigest: status.resolutionInputDigest }
                  : {}),
              }
              : {}),
          },
        }
        : {}),
    };
  }

  async function rejectStaleFence(
    request: DriverRequestEnvelope,
  ): Promise<void> {
    const decisions = await options.store.list<PolicyDecisionSpec, PolicyDecisionStatus>({
      apiVersion: POLICY_DECISION_API_VERSION,
      kind: POLICY_DECISION_KIND,
    });
    const maximum = (decisions.items as PolicyDecisionResource[])
      .filter((item) => item.spec.subjectRef.uid === request.resource.uid)
      .reduce(
        (value, item) => Math.max(value, item.spec.fencingEpoch),
        0,
      );
    if ((request.fencingEpoch as number) < maximum) {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: `managed policy fencing epoch is stale; current epoch is ${maximum}`,
        retryable: false,
      });
    }
  }

  async function persist(
    request: DriverRequestEnvelope,
    kind: PolicyDecisionKind,
    policyDigest: string,
    evaluation: PersistedPolicyEvaluation,
    approval?: PolicyDecisionSpec['approval'],
  ): Promise<PolicyDecision> {
    assertDigest(policyDigest, 'policyDigest');
    const normalized = validateEvaluation(evaluation);
    return serialized(async () => {
      await rejectStaleFence(request);
      const inputDigest = await canonicalDigest(request.payload);
      const requestFingerprint = await canonicalDigest({
        method: request.method,
        resource: request.resource,
        fencingEpoch: request.fencingEpoch,
        actor: request.actor,
        session: request.session,
        capabilityHandleRef: request.capabilityHandleRef,
        payloadSchemaDigest: request.payloadSchemaDigest,
        payload: request.payload,
      });
      const identityDigest = await canonicalDigest({
        resourceUid: request.resource.uid,
        method: request.method,
        idempotencyKey: request.idempotencyKey,
      });
      const name = decisionName(identityDigest);
      const existing = await options.store.get<PolicyDecisionSpec, PolicyDecisionStatus>({
        apiVersion: POLICY_DECISION_API_VERSION,
        kind: POLICY_DECISION_KIND,
        name,
      }) as PolicyDecisionResource | null;
      if (existing) {
        if (
          existing.spec.requestFingerprint !== requestFingerprint ||
          existing.spec.decisionKind !== kind
        ) {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: 'managed policy idempotency input drifted',
            retryable: false,
          });
        }
        return toDecision(existing);
      }
      const decidedAt = now().toISOString();
      const manifest = createPolicyDecisionManifest(name, {
        subjectRef: {
          apiVersion: request.resource.apiVersion,
          kind: request.resource.kind,
          name: request.resource.name,
          uid: request.resource.uid,
          generation: request.resource.generation,
        },
        decisionKind: kind,
        policyDigest,
        inputDigest,
        requestFingerprint,
        idempotencyKey: request.idempotencyKey,
        fencingEpoch: request.fencingEpoch as number,
        requestedBy: request.actor.id,
        reasons: normalized.reasons,
        obligations: normalized.obligations ?? [],
        decidedAt,
        initialOutcome: normalized.outcome,
        ...(approval ? { approval } : {}),
      });
      let created: PolicyDecisionResource;
      try {
        created = await options.store.create<PolicyDecisionSpec, PolicyDecisionStatus>(
          request.actor,
          manifest,
          { idempotencyKey: `managed-policy:${identityDigest}` },
        ) as PolicyDecisionResource;
      } catch (error) {
        const raced = await options.store.get<PolicyDecisionSpec, PolicyDecisionStatus>({
          apiVersion: POLICY_DECISION_API_VERSION,
          kind: POLICY_DECISION_KIND,
          name,
        }) as PolicyDecisionResource | null;
        if (!raced || raced.spec.requestFingerprint !== requestFingerprint) throw error;
        return toDecision(raced);
      }
      return toDecision(created);
    });
  }

  const decisions: PolicyDecisionKind[] = ['approval'];
  if (options.evaluateResourceAdmission) decisions.push('resource-admission');
  if (options.evaluatePlacement) decisions.push('placement');
  if (options.evaluateToolOperation) decisions.push('tool-operation');
  if (options.evaluateTransition) decisions.push('transition');

  return {
    async getCapabilities() {
      return {
        name: options.name,
        decisions: [...decisions],
        defaultOutcome: 'deny',
        supportsDurableApproval: true,
        supportsExplanation: true,
        persistence: options.persistence,
        threatAssumptions: [...options.threatAssumptions],
      };
    },
    async admitResource(request) {
      await authorize(request, 'policy.admit-resource', [
        'policyDigest',
        'resourceApiVersion',
        'resourceKind',
      ], ['controller', 'admin']);
      if (!options.evaluateResourceAdmission) {
        unsupported('managed resource admission is not configured');
      }
      const policyDigest = assertDigest(request.payload.policyDigest, 'policyDigest');
      boundedString(request.payload.resourceApiVersion, 'resourceApiVersion');
      boundedString(request.payload.resourceKind, 'resourceKind');
      const evaluation = await options.evaluateResourceAdmission(request);
      return persist(request, 'resource-admission', policyDigest, evaluation);
    },
    async authorizePlacement(request) {
      await authorize(request, 'policy.authorize-placement', [
        'policyDigest',
        'nodeId',
        'nodeTrustClass',
        'requiredTrustClass',
        'attested',
        'driverConformancePassed',
      ], ['controller', 'admin']);
      if (!options.evaluatePlacement) {
        unsupported('managed placement authorization is not configured');
      }
      const policyDigest = assertDigest(request.payload.policyDigest, 'policyDigest');
      boundedString(request.payload.nodeId, 'nodeId');
      if (
        !['trusted', 'restricted', 'quarantine'].includes(
          request.payload.nodeTrustClass,
        ) ||
        !['trusted', 'restricted', 'quarantine'].includes(
          request.payload.requiredTrustClass,
        ) ||
        typeof request.payload.attested !== 'boolean' ||
        typeof request.payload.driverConformancePassed !== 'boolean'
      ) invalid('managed placement payload is invalid');
      const evaluation = await options.evaluatePlacement(request);
      return persist(request, 'placement', policyDigest, evaluation);
    },
    async authorizeToolOperation(request) {
      await authorize(request, 'policy.authorize-tool-operation', [
        'policyDigest',
        'toolName',
        'effect',
        'operationDigest',
        'approvalDecisionHandle',
      ], ['controller', 'admin']);
      if (!options.evaluateToolOperation) {
        unsupported('managed tool authorization is not configured');
      }
      const policyDigest = assertDigest(request.payload.policyDigest, 'policyDigest');
      boundedString(request.payload.toolName, 'toolName');
      const operationDigest = assertDigest(
        request.payload.operationDigest,
        'operationDigest',
      );
      if (
        !['read', 'create', 'update', 'delete', 'execute', 'unknown'].includes(
          request.payload.effect,
        )
      ) invalid('managed tool effect is invalid');
      let approval: PolicyDecision | undefined;
      if (request.payload.approvalDecisionHandle !== undefined) {
        const resource = await resourceForHandle(
          boundedString(
            request.payload.approvalDecisionHandle,
            'approvalDecisionHandle',
          ),
          request.resource.uid,
        );
        approval = toDecision(resource);
        if (
          approval.kind !== 'approval' ||
          approval.outcome !== 'allow' ||
          approval.policyDigest !== policyDigest ||
          approval.approval?.subjectDigest !== operationDigest ||
          Date.parse(approval.approval.expiresAt) <= now().getTime()
        ) {
          throw new OrchestrationError({
            code: 'FORBIDDEN',
            message: 'managed tool approval is invalid, expired, or cross-scoped',
            retryable: false,
          });
        }
      }
      const evaluation = await options.evaluateToolOperation(request, approval);
      return persist(request, 'tool-operation', policyDigest, evaluation);
    },
    async requestApproval(request) {
      await authorize(request, 'policy.request-approval', [
        'policyDigest',
        'subjectKind',
        'subjectDigest',
        'reason',
        'ttlMs',
      ], ['controller', 'admin']);
      const policyDigest = assertDigest(request.payload.policyDigest, 'policyDigest');
      const subjectDigest = assertDigest(
        request.payload.subjectDigest,
        'subjectDigest',
      );
      if (
        !['tool-operation', 'resource', 'placement', 'transition'].includes(
          request.payload.subjectKind,
        ) ||
        !Number.isSafeInteger(request.payload.ttlMs) ||
        request.payload.ttlMs < 1 ||
        request.payload.ttlMs > maxApprovalTtlMs
      ) invalid('managed approval request is invalid');
      boundedString(request.payload.reason, 'reason');
      const requestedAt = now();
      return persist(
        request,
        'approval',
        policyDigest,
        {
          outcome: 'pending',
          reasons: ['approval awaits an authenticated administrator decision'],
          obligations: ['deny if unresolved or expired'],
        },
        {
          subjectDigest,
          requestedBy: request.actor.id,
          requestedAt: requestedAt.toISOString(),
          expiresAt: new Date(
            requestedAt.getTime() + request.payload.ttlMs,
          ).toISOString(),
        },
      );
    },
    async resolveApproval(request) {
      await authorize(request, 'policy.resolve-approval', [
        'approvalDecisionHandle',
        'outcome',
        'reason',
      ], ['admin']);
      if (request.payload.outcome !== 'allow' && request.payload.outcome !== 'deny') {
        invalid('managed approval resolution is invalid');
      }
      const reason = boundedString(request.payload.reason, 'reason');
      return serialized(async () => {
        await rejectStaleFence(request);
        const resource = await resourceForHandle(
          boundedString(
            request.payload.approvalDecisionHandle,
            'approvalDecisionHandle',
          ),
          request.resource.uid,
        );
        if (resource.spec.decisionKind !== 'approval' || !resource.spec.approval) {
          invalid('managed policy decision is not an approval');
        }
        if (Date.parse(resource.spec.approval.expiresAt) <= now().getTime()) {
          throw new OrchestrationError({
            code: 'TIMEOUT',
            message: 'managed approval expired before resolution',
            retryable: false,
          });
        }
        const resolutionInputDigest = await canonicalDigest(request.payload);
        const currentOutcome = resource.status?.outcome ??
          resource.spec.initialOutcome;
        if (currentOutcome !== 'pending') {
          if (
            currentOutcome !== request.payload.outcome ||
            resource.status?.resolutionInputDigest !== resolutionInputDigest
          ) {
            throw new OrchestrationError({
              code: 'CONFLICT',
              message: 'managed approval resolution is immutable',
              retryable: false,
            });
          }
          return toDecision(resource);
        }
        const status: PolicyDecisionStatus = {
          outcome: request.payload.outcome,
          decidedBy: request.actor.id,
          decidedAt: now().toISOString(),
          reasons: [reason],
          resolutionInputDigest,
        };
        const updated = await options.store.updateStatus<
          PolicyDecisionSpec
        >(
          request.actor,
          {
            apiVersion: POLICY_DECISION_API_VERSION,
            kind: POLICY_DECISION_KIND,
            name: resource.metadata.name,
          },
          status,
          {
            resourceVersion: resource.metadata.resourceVersion,
            idempotencyKey: `managed-policy-resolve:${resource.metadata.uid}:${request.idempotencyKey}`,
          },
        ) as PolicyDecisionResource;
        return toDecision(updated);
      });
    },
    async verifyTransition(request) {
      await authorize(request, 'policy.verify-transition', [
        'policyDigest',
        'transition',
        'from',
        'to',
        'evidenceDigest',
      ], ['verifier']);
      if (!options.evaluateTransition) {
        unsupported('managed transition verification is not configured');
      }
      const policyDigest = assertDigest(request.payload.policyDigest, 'policyDigest');
      boundedString(request.payload.transition, 'transition');
      boundedString(request.payload.from, 'from');
      boundedString(request.payload.to, 'to');
      assertDigest(request.payload.evidenceDigest, 'evidenceDigest');
      const evaluation = await options.evaluateTransition(request);
      return persist(request, 'transition', policyDigest, evaluation);
    },
    async explainDecision(request) {
      await authorize(request, 'policy.explain-decision', ['decisionHandle'], [
        'controller',
        'verifier',
        'admin',
      ]);
      const resource = await resourceForHandle(
        boundedString(request.payload.decisionHandle, 'decisionHandle'),
        request.resource.uid,
      );
      const decision = toDecision(resource);
      return {
        decision,
        summary: `${decision.kind} ${decision.outcome}: ${decision.reasons.join('; ')}`,
      };
    },
  };
}
