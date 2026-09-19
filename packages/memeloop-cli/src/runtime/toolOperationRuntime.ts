import { randomBytes } from 'node:crypto';

import {
  type AgentWorkloadResource,
  type ControlStoreActor,
  createControllerRunner,
  createControlStorePolicyApprovalAdapter,
  createInProcessToolExecutionDriver,
  createManagedToolDescriptors,
  createManagedToolExecutionRoute,
  createToolExecutorManifest,
  createToolOperationBindingController,
  createToolOperationExecutionController,
  defaultAdmissionPolicyForTrustClass,
  evaluateToolAdmission,
  isAgentWorkload,
  isToolExecutor,
  isToolOperation,
  OrchestrationError,
  TOOL_EXECUTOR_API_VERSION,
  TOOL_EXECUTOR_KIND,
  TOOL_OPERATION_KIND,
  type ToolExecutorResource,
  type ToolOperationResource,
} from 'memeloop';

import type { DriverRequestEnvelope, PolicyApprovalManagementDriver, ToolManagementDriver } from 'memeloop';
import { createDriverRequestBuilder, sha256DriverValue } from './envelopeBuilders.js';
import { createToolOperationLifecycle, type ToolOperationControllers } from './toolOperationLifecycle.js';
import type { ManagedPolicyRequestFactory, ToolOperationRuntimeOptions, ToolOperationRuntimeResult } from './toolOperationTypes.js';
export type { ToolOperationControllers } from './toolOperationTypes.js';
export type { ManagedPolicyRequestFactory, ToolOperationRuntimeOptions, ToolOperationRuntimeResult } from './toolOperationTypes.js';

export async function createToolOperationRuntime(
  options: ToolOperationRuntimeOptions,
): Promise<ToolOperationRuntimeResult> {
  const { controlStore, nodeId: syncNodeId, trustClass: workerTrustClass } = options;
  const { toolRegistry, builtinToolContext, logger } = options;
  const toolAdmission = options.toolExecution?.admission ??
    defaultAdmissionPolicyForTrustClass(workerTrustClass);
  let toolOperationControllers: ToolOperationControllers | undefined;
  let managedToolDriver: ToolManagementDriver | undefined;
  let managedPolicyDriver!: PolicyApprovalManagementDriver;
  let createManagedPolicyRequest!: ManagedPolicyRequestFactory;
  let authorizeHostToolOperation: ToolOperationRuntimeResult['authorizeHostToolOperation'];
  let authorizeHostExternalWorkload!: ToolOperationRuntimeResult['authorizeHostExternalWorkload'];

  if (controlStore) {
    const policyCapabilityHandle = `capability:policy:${randomBytes(32).toString('hex')}`;
    const policySessionId = `node-policy:${syncNodeId}:${randomBytes(16).toString('hex')}`;
    const buildPolicyRequest = createDriverRequestBuilder({
      actor: { id: `controller/policy-${syncNodeId}`, kind: 'controller' },
      sessionId: policySessionId,
      capabilityHandleRef: policyCapabilityHandle,
      controller: 'policy',
      deadlineMs: 60_000,
    });
    createManagedPolicyRequest = <T>(input: {
      method: string;
      payload: T;
      resource: AgentWorkloadResource | ToolOperationResource;
      actor: ControlStoreActor;
      leaseEpoch: string;
      idempotencyKey: string;
      payloadFields: string[];
    }): DriverRequestEnvelope<T> =>
      buildPolicyRequest({
        method: input.method,
        payload: input.payload,
        resource: input.resource,
        actor: input.actor,
        fencingEpoch: input.leaseEpoch,
        idempotencyKey: input.idempotencyKey,
        payloadSchema: {
          apiVersion: `drivers.memeloop.io/${input.method}/v1alpha1`,
          fields: input.payloadFields,
        },
      });
    const trustRank = {
      quarantine: 0,
      restricted: 1,
      trusted: 2,
    } as const;
    managedPolicyDriver = createControlStorePolicyApprovalAdapter({
      store: controlStore,
      name: `${syncNodeId}-control-store-policy`,
      persistence: 'host',
      authorizeRequest: (request) =>
        request.capabilityHandleRef === policyCapabilityHandle &&
        request.session?.id === policySessionId,
      evaluateResourceAdmission: (request) => {
        const allowed = new Set([
          'workload.memeloop.io/v1alpha1/AgentWorkload',
          'execution.memeloop.io/v1alpha1/ToolOperation',
          'security.memeloop.io/v1alpha1/CredentialGrant',
          'artifacts.memeloop.io/v1alpha1/ArtifactRecord',
        ]).has(
          `${request.payload.resourceApiVersion}/${request.payload.resourceKind}`,
        );
        return {
          outcome: allowed ? 'allow' : 'deny',
          reasons: [
            allowed
              ? 'resource kind is admitted by the host orchestration policy'
              : 'resource kind is not admitted by the host orchestration policy',
          ],
        };
      },
      async evaluatePlacement(request) {
        const currentResource = await controlStore.get<
          AgentWorkloadResource['spec'],
          AgentWorkloadResource['status']
        >({
          apiVersion: request.resource.apiVersion,
          kind: request.resource.kind,
          name: request.resource.name,
        });
        const current = currentResource && isAgentWorkload(currentResource)
          ? currentResource
          : null;
        const expectedPolicyDigest = current
          ? sha256DriverValue({
            placement: current.spec.placement,
            trust: current.spec.trust ?? 'restricted',
            securityProfileRef: current.spec.securityProfileRef,
          })
          : undefined;
        const requiredTrust = current?.spec.trust ?? 'restricted';
        const trustAllowed = requiredTrust === 'quarantine'
          ? request.payload.nodeTrustClass === 'quarantine'
          : request.payload.nodeTrustClass !== 'quarantine' &&
            trustRank[request.payload.nodeTrustClass] >= trustRank[requiredTrust];
        const allowed = Boolean(
          current &&
            current.metadata.uid === request.resource.uid &&
            current.metadata.generation === request.resource.generation &&
            request.payload.policyDigest === expectedPolicyDigest &&
            request.payload.requiredTrustClass === requiredTrust &&
            trustAllowed &&
            request.payload.driverConformancePassed &&
            (
              current.spec.placement?.requireAttestation !== true ||
              request.payload.attested
            ),
        );
        return {
          outcome: allowed ? 'allow' : 'deny',
          reasons: [
            allowed
              ? 'selected node matches the durable workload, trust, attestation, and admitted-driver policy'
              : 'selected node or policy input drifted from the durable workload',
          ],
          ...(allowed
            ? { obligations: ['binding controller must persist this exact decision handle'] }
            : {}),
        };
      },
      async evaluateToolOperation(request, approval) {
        const currentResource = await controlStore.get<
          ToolOperationResource['spec'],
          ToolOperationResource['status']
        >({
          apiVersion: request.resource.apiVersion,
          kind: request.resource.kind,
          name: request.resource.name,
        });
        const current = currentResource && isToolOperation(currentResource)
          ? currentResource
          : null;
        const admission = current
          ? evaluateToolAdmission(toolAdmission, current)
          : undefined;
        const expectedPolicyDigest = current
          ? sha256DriverValue({
            admission: toolAdmission,
            operationPolicy: current.spec.policy,
            tool: current.spec.toolRef.name,
            effect: current.spec.effect,
          })
          : undefined;
        const expectedOperationDigest = current
          ? sha256DriverValue({
            apiVersion: current.apiVersion,
            kind: current.kind,
            name: current.metadata.name,
            uid: current.metadata.uid,
            generation: current.metadata.generation,
            spec: current.spec,
          })
          : undefined;
        const needsApproval = admission?.action === 'require-approval' ||
          current?.spec.policy?.requireApproval === true;
        const allowed = Boolean(
          current &&
            current.metadata.uid === request.resource.uid &&
            current.metadata.generation === request.resource.generation &&
            request.payload.toolName === current.spec.toolRef.name &&
            request.payload.effect === current.spec.effect &&
            request.payload.policyDigest === expectedPolicyDigest &&
            request.payload.operationDigest === expectedOperationDigest &&
            admission?.action !== 'deny' &&
            (!needsApproval || approval?.outcome === 'allow'),
        );
        return {
          outcome: allowed ? 'allow' : 'deny',
          reasons: [
            allowed
              ? 'durable ToolOperation, host admission, and approval policy authorize execution'
              : admission?.reason ??
                'durable ToolOperation, host admission, or approval policy denied execution',
          ],
          ...(allowed
            ? { obligations: ['worker-local permission and capability checks remain required'] }
            : {}),
        };
      },
      evaluateTransition: (request) => {
        const key = `${request.payload.transition}:${request.payload.from}->${request.payload.to}`;
        const allowed = new Set([
          'ArtifactRecord:quarantined->verified',
          'Node:restricted->trusted',
        ]).has(key);
        return {
          outcome: allowed ? 'allow' : 'deny',
          reasons: [
            allowed
              ? `trusted verifier policy permits ${key}`
              : `trusted verifier policy does not permit ${key}`,
          ],
        };
      },
      threatAssumptions: [
        'the ControlStore, controller request factories, host admission configuration, and authenticated approval UI are trusted',
        'PolicyDecision resources store digests and decision evidence, never tool arguments or approval secrets',
      ],
    });
    authorizeHostExternalWorkload = async (workload, driverName) => {
      if ((workload.spec.trust ?? 'restricted') === 'trusted') {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: `external driver '${driverName}' has no independently attested trusted-node identity`,
          retryable: false,
        });
      }
      const policyDigest = sha256DriverValue({
        resource: {
          apiVersion: workload.apiVersion,
          kind: workload.kind,
          uid: workload.metadata.uid,
          generation: workload.metadata.generation,
        },
        driverName,
        runtimeClass: workload.spec.runtimeClass ?? 'default',
        requiredTrust: workload.spec.trust ?? 'restricted',
      });
      const decision = await managedPolicyDriver.admitResource(
        createManagedPolicyRequest({
          method: 'policy.admit-resource',
          payload: {
            policyDigest,
            resourceApiVersion: workload.apiVersion,
            resourceKind: workload.kind,
          },
          resource: workload,
          actor: {
            id: `controller/external-placement-${syncNodeId}`,
            kind: 'controller',
          },
          leaseEpoch: '1',
          idempotencyKey: `${workload.metadata.uid}:external-placement:${driverName}:${policyDigest}`,
          payloadFields: [
            'policyDigest',
            'resourceApiVersion',
            'resourceKind',
          ],
        }),
      );
      if (decision.outcome !== 'allow') {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: decision.reasons[0] ?? 'host policy denied external workload placement',
          retryable: false,
        });
      }
      return {
        decisionHandle: decision.decisionHandle,
        policyDigest,
      };
    };
  }
  if (options.toolExecution?.enabled !== false) {
    const managedToolDescriptors = await createManagedToolDescriptors(
      toolRegistry,
      syncNodeId,
    );
    const toolCapabilityHandle = `capability:tool:${randomBytes(32).toString('hex')}`;
    const toolSessionId = `node-tool:${syncNodeId}:${randomBytes(16).toString('hex')}`;
    const buildToolRequest = createDriverRequestBuilder({
      actor: { id: `controller/tool-${syncNodeId}`, kind: 'controller' },
      sessionId: toolSessionId,
      capabilityHandleRef: toolCapabilityHandle,
      controller: 'tool',
      deadlineMs: 60_000,
    });
    const createManagedToolRequest = <T>(input: {
      method: string;
      payload: T;
      operation: ToolOperationResource;
      actor: ControlStoreActor;
      leaseEpoch: string;
      idempotencyKey: string;
      payloadFields: string[];
    }): DriverRequestEnvelope<T> =>
      buildToolRequest({
        method: input.method,
        payload: input.payload,
        resource: input.operation,
        actor: input.actor,
        fencingEpoch: input.leaseEpoch,
        idempotencyKey: input.idempotencyKey,
        payloadSchema: {
          apiVersion: `drivers.memeloop.io/${input.method}/v1alpha1`,
          fields: input.payloadFields,
        },
      });
    const narrowToolDriver = createInProcessToolExecutionDriver(
      toolRegistry,
      {
        context: builtinToolContext,
        approvalBroker: {
          async requestApproval(request) {
            const approval = request.operation.status?.approval;
            if (!approval || approval.decision !== 'allow') {
              throw new OrchestrationError({
                code: 'FORBIDDEN',
                message: 'managed tool invocation has no bound approval evidence',
                retryable: false,
              });
            }
            return approval;
          },
        },
        ...(options.toolExecution?.maxOutputLength !== undefined
          ? { maxOutputLength: options.toolExecution.maxOutputLength }
          : {}),
        ...(options.auditToolExecution
          ? {
            async auditor(operation, result) {
              await options.auditToolExecution?.(operation, result);
            },
          }
          : {}),
      },
    );
    const managedToolRoute = createManagedToolExecutionRoute(
      narrowToolDriver,
      {
        name: `${syncNodeId}-managed-tools`,
        descriptors: managedToolDescriptors,
        authorizeRequest: (request) =>
          request.capabilityHandleRef === toolCapabilityHandle &&
          request.session?.id === toolSessionId,
        async resolveOperation(resourceUid) {
          const operations = await controlStore.list<
            ToolOperationResource['spec'],
            ToolOperationResource['status']
          >({ kind: TOOL_OPERATION_KIND });
          return operations.items.filter(isToolOperation).find(
            (operation) => operation.metadata.uid === resourceUid,
          );
        },
        authorizeOperation: authorizeHostToolOperation = async (operation, signal) => {
          const admission = evaluateToolAdmission(toolAdmission, operation);
          const approvalReason = admission.action === 'require-approval'
            ? admission.reason ??
              `ToolOperation requires approval (${admission.source})`
            : operation.spec.policy?.requireApproval
            ? 'ToolOperation policy requires approval'
            : undefined;
          const operationDigest = sha256DriverValue({
            apiVersion: operation.apiVersion,
            kind: operation.kind,
            name: operation.metadata.name,
            uid: operation.metadata.uid,
            generation: operation.metadata.generation,
            spec: operation.spec,
          });
          const policyDigest = sha256DriverValue({
            admission: toolAdmission,
            operationPolicy: operation.spec.policy,
            tool: operation.spec.toolRef.name,
            effect: operation.spec.effect,
          });
          let approval;
          let approvalDecisionHandle: string | undefined;
          if (approvalReason) {
            const broker = options.toolExecution?.approvalBroker;
            if (!broker) {
              throw new OrchestrationError({
                code: 'FORBIDDEN',
                message: `${approvalReason}; no trusted approval broker is configured`,
                retryable: false,
              });
            }
            const pending = await managedPolicyDriver.requestApproval(
              createManagedPolicyRequest({
                method: 'policy.request-approval',
                payload: {
                  policyDigest,
                  subjectKind: 'tool-operation' as const,
                  subjectDigest: operationDigest,
                  reason: approvalReason,
                  ttlMs: Math.min(
                    15 * 60_000,
                    Math.max(1, operation.spec.timeoutMs ?? 30_000),
                  ),
                },
                resource: operation,
                actor: {
                  id: `controller/tool-policy-${syncNodeId}`,
                  kind: 'controller',
                },
                leaseEpoch: operation.status?.executionClaim?.leaseEpoch ?? '1',
                idempotencyKey: `${operation.metadata.uid}:approval:${operationDigest}`,
                payloadFields: [
                  'policyDigest',
                  'subjectKind',
                  'subjectDigest',
                  'reason',
                  'ttlMs',
                ],
              }),
            );
            let resolved = pending;
            if (pending.outcome === 'pending') {
              const brokerDecision = await broker.requestApproval({
                operation,
                reason: approvalReason,
                signal,
              });
              if (
                !brokerDecision.approvalId ||
                !brokerDecision.actor ||
                !brokerDecision.decidedAt ||
                (
                  brokerDecision.decision !== 'allow' &&
                  brokerDecision.decision !== 'deny'
                ) ||
                Number.isNaN(Date.parse(brokerDecision.decidedAt))
              ) {
                throw new OrchestrationError({
                  code: 'FORBIDDEN',
                  message: brokerDecision.reason ??
                    'Trusted approval broker returned invalid evidence',
                  retryable: false,
                });
              }
              resolved = await managedPolicyDriver.resolveApproval(
                createManagedPolicyRequest({
                  method: 'policy.resolve-approval',
                  payload: {
                    approvalDecisionHandle: pending.decisionHandle,
                    outcome: brokerDecision.decision,
                    reason: brokerDecision.reason ??
                      `authenticated host approval ${brokerDecision.decision}`,
                  },
                  resource: operation,
                  actor: { id: brokerDecision.actor, kind: 'admin' },
                  leaseEpoch: operation.status?.executionClaim?.leaseEpoch ?? '1',
                  idempotencyKey: `${operation.metadata.uid}:resolve:${pending.decisionHandle}`,
                  payloadFields: [
                    'approvalDecisionHandle',
                    'outcome',
                    'reason',
                  ],
                }),
              );
            }
            if (resolved.outcome !== 'allow' || !resolved.approval) {
              throw new OrchestrationError({
                code: 'FORBIDDEN',
                message: resolved.reasons[0] ?? 'Trusted approval broker denied',
                retryable: false,
              });
            }
            approvalDecisionHandle = resolved.decisionHandle;
            approval = {
              approvalId: resolved.decisionHandle,
              actor: resolved.approval.decidedBy ?? resolved.actorId,
              decision: 'allow' as const,
              reason: resolved.reasons[0],
              decidedAt: resolved.approval.resolvedAt ?? resolved.decidedAt,
            };
          }
          const policyDecision = await managedPolicyDriver
            .authorizeToolOperation(createManagedPolicyRequest({
              method: 'policy.authorize-tool-operation',
              payload: {
                policyDigest,
                toolName: operation.spec.toolRef.name,
                effect: operation.spec.effect,
                operationDigest,
                ...(approvalDecisionHandle
                  ? { approvalDecisionHandle }
                  : {}),
              },
              resource: operation,
              actor: {
                id: `controller/tool-policy-${syncNodeId}`,
                kind: 'controller',
              },
              leaseEpoch: operation.status?.executionClaim?.leaseEpoch ?? '1',
              idempotencyKey: `${operation.metadata.uid}:tool-authorization:${operationDigest}`,
              payloadFields: [
                'policyDigest',
                'toolName',
                'effect',
                'operationDigest',
                'approvalDecisionHandle',
              ],
            }));
          if (policyDecision.outcome !== 'allow') {
            throw new OrchestrationError({
              code: 'FORBIDDEN',
              message: policyDecision.reasons[0] ??
                'Managed tool policy denied execution',
              retryable: false,
            });
          }
          return {
            handle: policyDecision.decisionHandle,
            policyDigest,
            ...(approval ? { approval } : {}),
          };
        },
        createRequest: createManagedToolRequest,
        maxOutputBytes: options.toolExecution?.maxOutputLength ?? 64 * 1024,
        maxOutputChunks: 8,
        threatAssumptions: [
          'the host tool registry, admission policy, approval broker, and controller are trusted',
          'tool implementations execute in the daemon process and are not crash-adoptable',
          'non-read cancellation or daemon loss is conservatively classified as an unknown effect',
        ],
      },
    );
    managedToolDriver = managedToolRoute.managementDriver;
    const executorActor = {
      id: `controller/tool-executor-registry-${syncNodeId}`,
      kind: 'controller' as const,
    };
    const executorName = `${syncNodeId}-builtin-tools`
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'local-builtin-tools';
    const executorManifest = createToolExecutorManifest(executorName, {
      nodeId: syncNodeId,
      trust: workerTrustClass,
      selectors: options.workloadNodeLabels,
      capabilities: [
        ...new Map(
          managedToolDescriptors.map((descriptor) => [
            descriptor.name,
            descriptor,
          ]),
        ).values(),
      ].map((descriptor) => ({
        toolClassRef: {
          apiVersion: 'tool.memeloop.io/v1alpha1',
          kind: 'ToolClass',
          name: descriptor.name,
        },
        schemaDigest: descriptor.schemaDigest,
        effects: [descriptor.effect],
        endpoint: `local-tool://${encodeURIComponent(syncNodeId)}/${encodeURIComponent(descriptor.name)}`,
        capacity: {
          maxConcurrent: options.toolExecution?.maxConcurrent ?? 8,
          queueDepth: 0,
        },
        health: { healthy: true },
      })),
    });
    const executorReference = {
      apiVersion: TOOL_EXECUTOR_API_VERSION,
      kind: TOOL_EXECUTOR_KIND,
      name: executorName,
    };
    let executor = await controlStore.get<ToolExecutorResource['spec']>(executorReference);
    if (
      executor &&
      JSON.stringify(executor.spec) !== JSON.stringify(executorManifest.spec)
    ) {
      await controlStore.delete(executorActor, executorReference, {
        preconditions: { resourceVersion: executor.metadata.resourceVersion },
      });
      executor = null;
    }
    if (!executor) {
      try {
        executor = await controlStore.create(executorActor, executorManifest);
      } catch (error) {
        if (!(error instanceof OrchestrationError) || error.code !== 'CONFLICT') throw error;
        executor = await controlStore.get<ToolExecutorResource['spec']>(executorReference);
      }
    }
    if (executor) {
      executor = await controlStore.updateStatus(
        executorActor,
        executorReference,
        { ...executor.status, healthy: true, heartbeat: new Date().toISOString() },
        { resourceVersion: executor.metadata.resourceVersion },
      );
    }

    const bindingActor = {
      id: `controller/tool-binding-${syncNodeId}`,
      kind: 'controller' as const,
    };
    const executionActor = {
      id: `controller/tool-execution-${syncNodeId}`,
      kind: 'controller' as const,
    };
    const binding = await createControllerRunner(
      controlStore,
      createToolOperationBindingController({
        actor: bindingActor,
        listExecutors: async () => {
          const list = await controlStore.list<
            ToolExecutorResource['spec'],
            ToolExecutorResource['status']
          >({
            apiVersion: TOOL_EXECUTOR_API_VERSION,
            kind: TOOL_EXECUTOR_KIND,
          });
          return list.items.filter(isToolExecutor);
        },
      }),
      {
        actor: bindingActor,
        leaseName: 'tool-operation-binding',
        watchKind: TOOL_OPERATION_KIND,
        leaseTtlMs: 5000,
      },
    );
    const toolExecutionController = createToolOperationExecutionController({
      actor: executionActor,
      nodeId: syncNodeId,
      driver: managedToolRoute.executionDriver,
    });
    const execution = await createControllerRunner(
      controlStore,
      toolExecutionController,
      {
        actor: executionActor,
        leaseName: `tool-operation-execution-${syncNodeId}`,
        watchKind: TOOL_OPERATION_KIND,
        leaseTtlMs: 5000,
      },
    );
    toolOperationControllers = createToolOperationLifecycle({
      controlStore,
      executionController: toolExecutionController,
      binding,
      execution,
      executorReference,
      executorActor,
      logger,
    });
  }
  return {
    toolOperationControllers,
    managedToolDriver,
    managedPolicyDriver,
    createManagedPolicyRequest,
    authorizeHostToolOperation,
    authorizeHostExternalWorkload,
  };
}
