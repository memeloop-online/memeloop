import { toolSchemaToJsonSchema } from '../../tools/schemaRegistry.js';
import type { IToolRegistry } from '../../types.js';
import type { ControllerReconcileRequest } from '../controllerRunner.js';
import { OrchestrationError } from '../errors.js';
import type { ToolOperationApprovalEvidence, ToolOperationEffect, ToolOperationResource, ToolRiskLevel } from '../resources.js';

import { canonicalDriverValue, type DriverRequestEnvelope } from './driverRequest.js';
import type { ToolExecutionDriver } from './toolExecutionDriver.js';
import { createFakeToolManagementDriver, createFakeToolManagementState, type ManagedToolDescriptor, type ToolManagementDriver } from './toolManagement.js';

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalDriverValue(value));
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${
    [...new Uint8Array(result)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }`;
}

function riskForEffect(effect: ToolOperationEffect): ToolRiskLevel {
  switch (effect) {
    case 'read': {
      return 'medium';
    }
    case 'create':
    case 'update': {
      return 'high';
    }
    case 'delete':
    case 'execute':
    case 'unknown': {
      return 'critical';
    }
  }
}

/** Build content-addressed descriptors from the schemas actually registered by the host. */
export async function createManagedToolDescriptors(
  registry: IToolRegistry,
  nodeId: string,
): Promise<ManagedToolDescriptor[]> {
  const descriptors: ManagedToolDescriptor[] = [];
  for (const name of [...registry.listTools()].sort()) {
    const registeredSchema = registry.getToolParameterSchema?.(name);
    if (registeredSchema === undefined) {
      // Host tools without a portable schema are not safe to expose through
      // the managed catalog. They remain available to their owning host, but
      // cannot be prepared or executed as managed operations.
      continue;
    }
    const inputSchema = toolSchemaToJsonSchema(registeredSchema);
    const outputSchema: Record<string, unknown> = {};
    const schemaDigest = await digest({ inputSchema, outputSchema });
    const metadata = registry.getToolMetadata?.(name);
    const target = `local-tool://${encodeURIComponent(nodeId)}/${encodeURIComponent(name)}`;
    const effect = registry.getToolEffect?.(name) ?? 'execute';
    descriptors.push({
      name,
      version: `1.0.0-${effect}`,
      description: metadata?.description ?? `Host-registered tool ${name}`,
      inputSchema,
      outputSchema,
      schemaDigest,
      effect,
      risk: riskForEffect(effect),
      targets: [target],
      supportsIdempotency: effect === 'read',
      supportsFencing: true,
      supportsEvidence: true,
    });
  }
  return descriptors;
}

export interface ManagedToolPolicyDecision {
  handle: string;
  policyDigest: string;
  approval?: ToolOperationApprovalEvidence;
}

export interface ManagedToolExecutionRouteOptions {
  descriptors: ManagedToolDescriptor[];
  resolveOperation(resourceUid: string): Promise<ToolOperationResource | undefined>;
  authorizeOperation(
    operation: ToolOperationResource,
    signal?: AbortSignal,
  ): Promise<ManagedToolPolicyDecision>;
  authorizeRequest(request: DriverRequestEnvelope): boolean | Promise<boolean>;
  createRequest<T>(input: {
    method: string;
    payload: T;
    operation: ToolOperationResource;
    actor: ControllerReconcileRequest['actor'];
    leaseEpoch: string;
    idempotencyKey: string;
    payloadFields: string[];
  }): DriverRequestEnvelope<T>;
  name: string;
  maxOutputBytes?: number;
  maxOutputChunks?: number;
  now?: () => Date;
  threatAssumptions: string[];
}

export interface ManagedToolExecutionRoute {
  managementDriver: ToolManagementDriver;
  executionDriver: ToolExecutionDriver;
}

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function exactFields(payload: unknown, allowed: readonly string[], location: string): void {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    invalid(`managed tool ${location} must be an object`);
  }
  const unknown = Object.keys(payload).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    invalid(`managed tool ${location} contains unsupported fields: ${unknown.join(', ')}`);
  }
}

/**
 * Round-trip the existing ToolExecutionDriver through the complete managed
 * lifecycle while keeping live results and approval evidence host-local.
 */
export function createManagedToolExecutionRoute(
  narrowDriver: ToolExecutionDriver,
  options: ManagedToolExecutionRouteOptions,
): ManagedToolExecutionRoute {
  if (!options.descriptors.length || !options.threatAssumptions.length) {
    invalid('managed tool route requires a non-empty catalog and threat assumptions');
  }
  const pendingDecisions = new Map<string, ManagedToolPolicyDecision>();
  const approvalEvidence = new Map<string, ToolOperationApprovalEvidence>();
  const state = createFakeToolManagementState();
  const engine = createFakeToolManagementDriver({
    state,
    now: options.now,
    tools: options.descriptors,
    maxOutputBytes: options.maxOutputBytes,
    maxOutputChunks: options.maxOutputChunks,
    capabilities: {
      name: options.name,
      persistence: 'process',
      threatAssumptions: options.threatAssumptions,
    },
    async verifyPolicyDecision(input) {
      const operation = await options.resolveOperation(input.resourceUid);
      const pending = pendingDecisions.get(input.resourceUid);
      if (
        !operation ||
        !pending ||
        pending.handle !== input.handle ||
        pending.policyDigest !== input.policyDigest ||
        operation.spec.toolRef.name !== input.tool.name ||
        operation.spec.effect !== input.tool.effect ||
        !input.tool.targets.includes(input.target)
      ) {
        return false;
      }
      if (pending.approval) {
        approvalEvidence.set(input.resourceUid, pending.approval);
      }
      return true;
    },
    async *executor(descriptor, _target, arguments_, signal, resourceUid) {
      if (!resourceUid) invalid('managed tool executor has no resource identity');
      const operation = await options.resolveOperation(resourceUid);
      if (
        !operation ||
        operation.spec.toolRef.name !== descriptor.name ||
        operation.spec.effect !== descriptor.effect ||
        canonicalDriverValue(operation.spec.arguments ?? {}) !== canonicalDriverValue(arguments_)
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'resolved ToolOperation differs from the managed invocation',
          retryable: false,
        });
      }
      const approval = approvalEvidence.get(resourceUid);
      const executed = await narrowDriver.execute(
        approval
          ? {
            ...operation,
            status: { ...operation.status, approval },
          }
          : operation,
        { signal },
      );
      yield JSON.stringify(executed);
    },
  });

  async function authorize<T>(
    request: DriverRequestEnvelope<T>,
    fields: readonly string[],
  ): Promise<void> {
    exactFields(request.payload, fields, `${request.method} payload`);
    if (!(await options.authorizeRequest(request))) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'managed tool capability was rejected',
        retryable: false,
      });
    }
  }

  const managementDriver: ToolManagementDriver = {
    getCapabilities: () => engine.getCapabilities(),
    async discover(request) {
      await authorize(request, ['namePrefix']);
      return engine.discover(request);
    },
    async describe(request) {
      await authorize(request, ['name', 'version', 'catalogDigest']);
      return engine.describe(request);
    },
    async prepare(request) {
      await authorize(request, [
        'name',
        'version',
        'schemaDigest',
        'catalogDigest',
        'target',
        'effect',
        'operationIdempotencyKey',
      ]);
      return engine.prepare(request);
    },
    async authorize(request) {
      await authorize(request, [
        'preparationHandle',
        'policyDecisionHandle',
        'policyDigest',
        'ttlMs',
      ]);
      return engine.authorize(request);
    },
    async *invoke(request, invokeOptions) {
      await authorize(request, ['preparationHandle', 'authorizationHandle', 'arguments']);
      yield* engine.invoke(request, invokeOptions);
    },
    async inspect(request) {
      await authorize(request, ['executionHandle', 'preparationHandle']);
      return engine.inspect(request);
    },
    async reconcileUnknownEffect(request) {
      await authorize(request, ['executionHandle', 'resultObserved', 'evidenceDigest']);
      return engine.reconcileUnknownEffect(request);
    },
    async collectEvidence(request) {
      await authorize(request, ['executionHandle']);
      return engine.collectEvidence(request);
    },
    async cleanup(request) {
      await authorize(request, ['preparationHandle', 'executionHandle']);
      return engine.cleanup(request);
    },
  };

  const executionDriver: ToolExecutionDriver = {
    async execute(operation, executionOptions = {}) {
      const actor = executionOptions.actor;
      const leaseEpoch = executionOptions.leaseEpoch;
      if (!actor || !leaseEpoch) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'managed tool execution requires controller actor and fencing epoch',
          retryable: false,
        });
      }
      const request = <T>(method: string, payload: T, suffix: string, payloadFields: string[]) =>
        options.createRequest({
          method,
          payload,
          operation,
          actor,
          leaseEpoch,
          idempotencyKey: `${operation.metadata.uid}:${suffix}`,
          payloadFields,
        });
      const snapshot = await managementDriver.discover(
        request('tool.discover', {}, 'discover', ['namePrefix']),
      );
      const descriptor = snapshot.tools.find(
        (candidate) =>
          candidate.name === operation.spec.toolRef.name &&
          candidate.effect === operation.spec.effect,
      );
      if (!descriptor) {
        throw new OrchestrationError({
          code: 'NOT_FOUND',
          message: 'managed tool descriptor was not found',
          retryable: false,
        });
      }
      if (
        operation.spec.toolRef.schemaDigest &&
        operation.spec.toolRef.schemaDigest !== descriptor.schemaDigest
      ) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: 'ToolOperation schema digest differs from the managed catalog',
          retryable: false,
        });
      }
      const preparation = await managementDriver.prepare(
        request(
          'tool.prepare',
          {
            name: descriptor.name,
            version: descriptor.version,
            schemaDigest: descriptor.schemaDigest,
            catalogDigest: snapshot.catalogDigest,
            target: descriptor.targets[0],
            effect: descriptor.effect,
            ...(operation.spec.idempotencyKey && descriptor.supportsIdempotency
              ? { operationIdempotencyKey: operation.spec.idempotencyKey }
              : {}),
          },
          'prepare',
          [
            'name',
            'version',
            'schemaDigest',
            'catalogDigest',
            'target',
            'effect',
            'operationIdempotencyKey',
          ],
        ),
      );
      const policy = await options.authorizeOperation(operation, executionOptions.signal);
      pendingDecisions.set(operation.metadata.uid, policy);
      const authorization = await managementDriver
        .authorize(
          request(
            'tool.authorize',
            {
              preparationHandle: preparation.preparationHandle,
              policyDecisionHandle: policy.handle,
              policyDigest: policy.policyDigest,
              ttlMs: Math.min(60_000, Math.max(1, operation.spec.timeoutMs ?? 30_000)),
            },
            'authorize',
            ['preparationHandle', 'policyDecisionHandle', 'policyDigest', 'ttlMs'],
          ),
        )
        .finally(() => {
          pendingDecisions.delete(operation.metadata.uid);
        });
      try {
        const chunks: string[] = [];
        let executionHandle: string | undefined;
        for await (
          const chunk of managementDriver.invoke(
            request(
              'tool.invoke',
              {
                preparationHandle: preparation.preparationHandle,
                authorizationHandle: authorization.authorizationHandle,
                arguments: operation.spec.arguments ?? {},
              },
              'invoke',
              ['preparationHandle', 'authorizationHandle', 'arguments'],
            ),
            { signal: executionOptions.signal },
          )
        ) {
          executionHandle = chunk.executionHandle;
          if (!chunk.final) chunks.push(chunk.data);
        }
        if (!executionHandle || chunks.length !== 1) {
          invalid('managed narrow tool execution returned an invalid result stream');
        }
        const executed = JSON.parse(chunks[0]) as ToolOperationResource;
        const evidence = await managementDriver.collectEvidence(
          request('tool.collect-evidence', { executionHandle }, 'evidence', ['executionHandle']),
        );
        await managementDriver.cleanup(
          request(
            'tool.cleanup',
            {
              preparationHandle: preparation.preparationHandle,
              executionHandle,
            },
            'cleanup',
            ['preparationHandle', 'executionHandle'],
          ),
        );
        return {
          ...executed,
          status: {
            ...executed.status,
            result: {
              ...executed.status?.result,
              evidenceRef: evidence.outputDigest,
            },
          },
        };
      } finally {
        approvalEvidence.delete(operation.metadata.uid);
      }
    },
  };

  return { managementDriver, executionDriver };
}
