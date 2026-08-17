import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { OrchestrationError } from '../errors.js';
import type { ToolOperationEffect, ToolRiskLevel } from '../resources.js';

import type { DriverConformanceSuite } from './driverConformance.js';
import { canonicalDriverValue, type DriverRequestEnvelope } from './driverRequest.js';
import { assertFencedDriverRequestEnvelope, findIdempotentDriverHandle, rememberIdempotentDriverHandle } from './driverState.js';

export interface ManagedToolDescriptor {
  name: string;
  version: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  schemaDigest: string;
  effect: ToolOperationEffect;
  risk: ToolRiskLevel;
  targets: string[];
  supportsIdempotency: boolean;
  supportsFencing: boolean;
  supportsEvidence: boolean;
}

export interface ToolCatalogSnapshot {
  catalogDigest: string;
  tools: ManagedToolDescriptor[];
}

export interface ToolManagementCapabilities {
  name: string;
  supportsStreaming: boolean;
  supportsCancellation: boolean;
  supportsBackpressure: boolean;
  supportsUnknownEffectReconciliation: boolean;
  maxOutputBytes: number;
  maxOutputChunks: number;
  persistence: 'process' | 'host' | 'external';
  threatAssumptions: string[];
}

export interface PreparedToolExecution {
  preparationHandle: string;
  resourceUid: string;
  toolName: string;
  version: string;
  schemaDigest: string;
  catalogDigest: string;
  target: string;
  effect: ToolOperationEffect;
  idempotencyKey?: string;
  cleaned: boolean;
}

export interface AuthorizedToolExecution {
  authorizationHandle: string;
  preparationHandle: string;
  resourceUid: string;
  policyDecisionHandle: string;
  policyDigest: string;
  authorizedAt: string;
  expiresAt: string;
}

export type ManagedToolExecutionPhase =
  | 'Prepared'
  | 'Running'
  | 'Completed'
  | 'Failed'
  | 'Cancelled'
  | 'Unknown';

export interface ManagedToolExecution {
  executionHandle: string;
  preparationHandle: string;
  authorizationHandle: string;
  resourceUid: string;
  phase: ManagedToolExecutionPhase;
  startedAt?: string;
  completedAt?: string;
  outputBytes: number;
  outputChunks: number;
  error?: { code: string; message: string };
  cleaned: boolean;
}

export interface ManagedToolOutputChunk {
  executionHandle: string;
  index: number;
  data: string;
  final: boolean;
}

export interface ManagedToolEvidence {
  evidenceHandle: string;
  executionHandle: string;
  resourceUid: string;
  outcome: ManagedToolExecutionPhase;
  outputDigest: string;
  recordedAt: string;
}

export interface ToolManagementDriver {
  getCapabilities(): Promise<ToolManagementCapabilities>;
  discover(
    request: DriverRequestEnvelope<{ namePrefix?: string }>,
  ): Promise<ToolCatalogSnapshot>;
  describe(
    request: DriverRequestEnvelope<{
      name: string;
      version?: string;
      catalogDigest: string;
    }>,
  ): Promise<ManagedToolDescriptor | undefined>;
  prepare(
    request: DriverRequestEnvelope<{
      name: string;
      version: string;
      schemaDigest: string;
      catalogDigest: string;
      target: string;
      effect: ToolOperationEffect;
      operationIdempotencyKey?: string;
    }>,
  ): Promise<PreparedToolExecution>;
  authorize(
    request: DriverRequestEnvelope<{
      preparationHandle: string;
      policyDecisionHandle: string;
      policyDigest: string;
      ttlMs: number;
    }>,
  ): Promise<AuthorizedToolExecution>;
  invoke(
    request: DriverRequestEnvelope<{
      preparationHandle: string;
      authorizationHandle: string;
      arguments: Record<string, unknown>;
    }>,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<ManagedToolOutputChunk>;
  inspect(
    request: DriverRequestEnvelope<{
      executionHandle?: string;
      preparationHandle?: string;
    }>,
  ): Promise<ManagedToolExecution | undefined>;
  reconcileUnknownEffect(
    request: DriverRequestEnvelope<{
      executionHandle: string;
      resultObserved: boolean;
      evidenceDigest?: string;
    }>,
  ): Promise<ManagedToolExecution>;
  collectEvidence(
    request: DriverRequestEnvelope<{ executionHandle: string }>,
  ): Promise<ManagedToolEvidence>;
  cleanup(
    request: DriverRequestEnvelope<{
      preparationHandle: string;
      executionHandle?: string;
    }>,
  ): Promise<void>;
}

export interface FakeToolManagementState {
  preparations: Map<string, PreparedToolExecution>;
  authorizations: Map<string, AuthorizedToolExecution>;
  executions: Map<string, ManagedToolExecution>;
  outputs: Map<string, ManagedToolOutputChunk[]>;
  evidence: Map<string, ManagedToolEvidence>;
  idempotency: Map<string, string>;
  idempotencyFingerprints: Map<string, string>;
  fences: Map<string, number>;
  nextHandle: number;
}

export function createFakeToolManagementState(): FakeToolManagementState {
  return {
    preparations: new Map(),
    authorizations: new Map(),
    executions: new Map(),
    outputs: new Map(),
    evidence: new Map(),
    idempotency: new Map(),
    idempotencyFingerprints: new Map(),
    fences: new Map(),
    nextHandle: 1,
  };
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function requiredString(value: unknown, field: string, maximum = 256): string {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as Record<string, unknown>)[field] !== 'string'
  ) invalid(`tool payload '${field}' is required`);
  const result = (value as Record<string, string>)[field];
  if (!result || result.length > maximum) invalid(`tool payload '${field}' is invalid`);
  return result;
}

async function digest(value: unknown): Promise<string> {
  const result = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalDriverValue(value)),
  );
  return `sha256:${
    [...new Uint8Array(result)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }`;
}

function descriptorInput(descriptor: ManagedToolDescriptor): unknown {
  return {
    ...descriptor,
    targets: [...descriptor.targets].sort(),
  };
}

/**
 * Complete durable-state reference for the §10.3 lifecycle. Policy authority
 * is supplied by an injected trusted verifier, never by an `allow` payload.
 */
export function createFakeToolManagementDriver(options: {
  state?: FakeToolManagementState;
  now?: () => Date;
  tools?: ManagedToolDescriptor[];
  verifyPolicyDecision?: (input: {
    handle: string;
    policyDigest: string;
    resourceUid: string;
    tool: ManagedToolDescriptor;
    target: string;
  }) => boolean | Promise<boolean>;
  executor?: (
    tool: ManagedToolDescriptor,
    target: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
    resourceUid?: string,
  ) => AsyncIterable<string>;
  maxOutputBytes?: number;
  maxOutputChunks?: number;
  capabilities?: Partial<ToolManagementCapabilities>;
} = {}): ToolManagementDriver {
  const state = options.state ?? createFakeToolManagementState();
  const now = options.now ?? (() => new Date());
  const tools: ManagedToolDescriptor[] = structuredClone(
    options.tools ?? [{
      name: 'fs.read',
      version: '1.0.0',
      description: 'Read a bounded file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      outputSchema: { type: 'string' },
      schemaDigest: 'sha256:31e0f368a8e9c4e233ed93f0bf08c77cd9531be5977bf8325bf4ffd2f5fcea47',
      effect: 'read',
      risk: 'low',
      targets: ['workspace'],
      supportsIdempotency: true,
      supportsFencing: true,
      supportsEvidence: true,
    }, {
      name: 'fs.write',
      version: '1.0.0',
      description: 'Write a bounded file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      outputSchema: { type: 'string' },
      schemaDigest: 'sha256:31e0f368a8e9c4e233ed93f0bf08c77cd9531be5977bf8325bf4ffd2f5fcea47',
      effect: 'update',
      risk: 'high',
      targets: ['workspace'],
      supportsIdempotency: true,
      supportsFencing: true,
      supportsEvidence: true,
    }],
  );
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  const maxOutputChunks = options.maxOutputChunks ?? 256;
  const verifyPolicyDecision = options.verifyPolicyDecision ??
    ((input: { handle: string }) => input.handle === 'policy-decision:allow');
  const schemaValidatorOptions = {
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    strict: false,
    useDefaults: false,
    validateFormats: false,
  } as const;
  const draft7Validator = new Ajv(schemaValidatorOptions);
  const draft2019Validator = new Ajv2019(schemaValidatorOptions);
  const draft2020Validator = new Ajv2020(schemaValidatorOptions);
  const inputValidators = new Map<string, ValidateFunction>();
  for (const descriptor of tools) {
    try {
      const schemaVersion = descriptor.inputSchema.$schema;
      const validator = schemaVersion === undefined ||
          schemaVersion === 'http://json-schema.org/draft-07/schema#' ||
          schemaVersion === 'https://json-schema.org/draft-07/schema#'
        ? draft7Validator
        : schemaVersion === 'https://json-schema.org/draft/2019-09/schema'
        ? draft2019Validator
        : schemaVersion === 'https://json-schema.org/draft/2020-12/schema'
        ? draft2020Validator
        : undefined;
      if (!validator) {
        invalid(`tool catalog descriptor '${descriptor.name}' uses an unsupported input schema draft`);
      }
      inputValidators.set(
        `${descriptor.name}\0${descriptor.version}`,
        validator.compile(descriptor.inputSchema),
      );
    } catch {
      invalid(`tool catalog descriptor '${descriptor.name}' has an invalid input schema`);
    }
  }

  let catalogDigestPromise: Promise<string> | undefined;
  function catalogDigest(): Promise<string> {
    catalogDigestPromise ??= (async () => {
      for (const descriptor of tools) {
        const actualSchemaDigest = await digest({
          inputSchema: descriptor.inputSchema,
          outputSchema: descriptor.outputSchema,
        });
        if (
          !SHA256.test(descriptor.schemaDigest) ||
          descriptor.schemaDigest !== actualSchemaDigest ||
          !descriptor.name ||
          !descriptor.version ||
          !descriptor.targets.length
        ) invalid(`tool catalog descriptor '${descriptor.name}' is invalid`);
      }
      return digest(
        tools
          .map(descriptorInput)
          .sort((left, right) => canonicalDriverValue(left).localeCompare(canonicalDriverValue(right))),
      );
    })();
    return catalogDigestPromise;
  }

  function validate<T>(
    request: DriverRequestEnvelope<T>,
    expectedMethod: string,
    actorKinds: Array<'controller' | 'verifier' | 'admin'> = ['controller'],
  ): void {
    assertFencedDriverRequestEnvelope(request, {
      now,
      fences: state.fences,
      expectedMethod,
      fenceName: 'tool',
      actorKinds,
    });
  }

  function owned<T extends { resourceUid: string }>(
    collection: Map<string, T>,
    handle: string,
    resourceUid: string,
    kind: string,
  ): T {
    const value = collection.get(handle);
    if (!value) {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `${kind} '${handle}' was not found`,
        retryable: false,
      });
    }
    if (value.resourceUid !== resourceUid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `${kind} '${handle}' belongs to another resource`,
        retryable: false,
      });
    }
    return value;
  }

  function tool(name: string, version?: string): ManagedToolDescriptor | undefined {
    return tools.find((candidate) => candidate.name === name && (version === undefined || candidate.version === version));
  }

  function opaque(prefix: string): string {
    return `${prefix}:${state.nextHandle++}`;
  }

  function idempotency(
    request: DriverRequestEnvelope,
    operation: string,
  ): string | undefined {
    return findIdempotentDriverHandle(state, request, operation, 'tool');
  }

  function remember(
    request: DriverRequestEnvelope,
    operation: string,
    handle: string,
  ): void {
    rememberIdempotentDriverHandle(state, request, operation, handle);
  }

  async function* defaultExecutor(
    descriptor: ManagedToolDescriptor,
    target: string,
    arguments_: Record<string, unknown>,
  ): AsyncIterable<string> {
    yield JSON.stringify({ tool: descriptor.name, target, arguments: arguments_ });
  }

  return {
    async getCapabilities() {
      return {
        name: options.capabilities?.name ?? 'fake-tool-management',
        supportsStreaming: true,
        supportsCancellation: true,
        supportsBackpressure: true,
        supportsUnknownEffectReconciliation: true,
        maxOutputBytes,
        maxOutputChunks,
        persistence: options.capabilities?.persistence ?? 'host',
        threatAssumptions: options.capabilities?.threatAssumptions ?? [
          'the injected catalog, policy verifier, executor, and durable state are trusted',
        ],
      };
    },
    async discover(request) {
      validate(request, 'tool.discover', ['controller', 'verifier', 'admin']);
      if (
        request.payload.namePrefix !== undefined &&
        (typeof request.payload.namePrefix !== 'string' ||
          request.payload.namePrefix.length > 128)
      ) invalid('tool namePrefix is invalid');
      const prefix = request.payload.namePrefix ?? '';
      return {
        catalogDigest: await catalogDigest(),
        tools: tools
          .filter((candidate) => candidate.name.startsWith(prefix))
          .map((candidate) => structuredClone(candidate)),
      };
    },
    async describe(request) {
      validate(request, 'tool.describe', ['controller', 'verifier', 'admin']);
      if (requiredString(request.payload, 'catalogDigest', 80) !== await catalogDigest()) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: 'tool catalog digest is stale',
          retryable: false,
        });
      }
      return structuredClone(tool(
        requiredString(request.payload, 'name'),
        request.payload.version,
      ));
    },
    async prepare(request) {
      validate(request, 'tool.prepare');
      const expectedCatalog = await catalogDigest();
      if (request.payload.catalogDigest !== expectedCatalog) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: 'tool catalog changed before preparation',
          retryable: false,
        });
      }
      const descriptor = tool(
        requiredString(request.payload, 'name'),
        requiredString(request.payload, 'version'),
      );
      if (!descriptor) {
        throw new OrchestrationError({
          code: 'NOT_FOUND',
          message: 'tool descriptor was not found',
          retryable: false,
        });
      }
      if (
        !SHA256.test(request.payload.schemaDigest) ||
        request.payload.schemaDigest !== descriptor.schemaDigest ||
        request.payload.effect !== descriptor.effect
      ) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: 'tool schema or effect does not match the catalog descriptor',
          retryable: false,
        });
      }
      const target = requiredString(request.payload, 'target');
      if (!descriptor.targets.includes(target)) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: `tool target '${target}' is not allowed`,
          retryable: false,
        });
      }
      if (
        request.payload.operationIdempotencyKey &&
        !descriptor.supportsIdempotency
      ) invalid('tool does not support operation idempotency');
      const previous = idempotency(request, 'prepare');
      if (previous) {
        return structuredClone(owned(
          state.preparations,
          previous,
          request.resource.uid,
          'tool preparation',
        ));
      }
      const preparation: PreparedToolExecution = {
        preparationHandle: opaque('tool-preparation'),
        resourceUid: request.resource.uid,
        toolName: descriptor.name,
        version: descriptor.version,
        schemaDigest: descriptor.schemaDigest,
        catalogDigest: expectedCatalog,
        target,
        effect: descriptor.effect,
        ...(request.payload.operationIdempotencyKey
          ? { idempotencyKey: request.payload.operationIdempotencyKey }
          : {}),
        cleaned: false,
      };
      state.preparations.set(preparation.preparationHandle, preparation);
      remember(request, 'prepare', preparation.preparationHandle);
      return structuredClone(preparation);
    },
    async authorize(request) {
      validate(request, 'tool.authorize', ['controller', 'admin']);
      const preparation = owned(
        state.preparations,
        requiredString(request.payload, 'preparationHandle'),
        request.resource.uid,
        'tool preparation',
      );
      if (preparation.cleaned) invalid('tool preparation was cleaned');
      const policyDigest = requiredString(request.payload, 'policyDigest', 80);
      if (!SHA256.test(policyDigest)) invalid('tool policyDigest is invalid');
      const policyDecisionHandle = requiredString(
        request.payload,
        'policyDecisionHandle',
        2048,
      );
      if (
        !Number.isSafeInteger(request.payload.ttlMs) ||
        request.payload.ttlMs < 1 ||
        request.payload.ttlMs > 60_000
      ) invalid('tool authorization ttlMs must be between 1 and 60000');
      const descriptor = tool(preparation.toolName, preparation.version) as ManagedToolDescriptor;
      if (
        !await verifyPolicyDecision({
          handle: policyDecisionHandle,
          policyDigest,
          resourceUid: request.resource.uid,
          tool: descriptor,
          target: preparation.target,
        })
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'trusted policy decision did not authorize this tool operation',
          retryable: false,
        });
      }
      const previous = idempotency(request, 'authorize');
      if (previous) {
        return structuredClone(owned(
          state.authorizations,
          previous,
          request.resource.uid,
          'tool authorization',
        ));
      }
      const authorization: AuthorizedToolExecution = {
        authorizationHandle: opaque('tool-authorization'),
        preparationHandle: preparation.preparationHandle,
        resourceUid: request.resource.uid,
        policyDecisionHandle,
        policyDigest,
        authorizedAt: now().toISOString(),
        expiresAt: new Date(now().getTime() + request.payload.ttlMs).toISOString(),
      };
      state.authorizations.set(authorization.authorizationHandle, authorization);
      remember(request, 'authorize', authorization.authorizationHandle);
      return structuredClone(authorization);
    },
    async *invoke(request, invokeOptions = {}) {
      validate(request, 'tool.invoke');
      const preparation = owned(
        state.preparations,
        requiredString(request.payload, 'preparationHandle'),
        request.resource.uid,
        'tool preparation',
      );
      const authorization = owned(
        state.authorizations,
        requiredString(request.payload, 'authorizationHandle'),
        request.resource.uid,
        'tool authorization',
      );
      if (
        preparation.cleaned ||
        authorization.preparationHandle !== preparation.preparationHandle ||
        Date.parse(authorization.expiresAt) <= now().getTime()
      ) invalid('tool preparation and authorization binding is invalid');
      if (
        request.payload.arguments === null ||
        typeof request.payload.arguments !== 'object' ||
        Array.isArray(request.payload.arguments)
      ) invalid('tool arguments must be an object');
      const descriptor = tool(
        preparation.toolName,
        preparation.version,
      ) as ManagedToolDescriptor;
      const validateArguments = inputValidators.get(
        `${descriptor.name}\0${descriptor.version}`,
      );
      if (!validateArguments?.(request.payload.arguments)) {
        invalid('tool arguments do not match the bound input schema');
      }
      const previous = idempotency(request, 'invoke');
      if (previous) {
        const execution = owned(
          state.executions,
          previous,
          request.resource.uid,
          'tool execution',
        );
        if (execution.phase === 'Running' || execution.phase === 'Unknown') {
          throw new OrchestrationError({
            code: 'UNKNOWN_EFFECT',
            message: 'tool invocation retry observed an uncertain prior effect',
            retryable: false,
          });
        }
        for (const chunk of state.outputs.get(execution.executionHandle) ?? []) {
          yield structuredClone(chunk);
        }
        return;
      }
      const execution: ManagedToolExecution = {
        executionHandle: opaque('tool-execution'),
        preparationHandle: preparation.preparationHandle,
        authorizationHandle: authorization.authorizationHandle,
        resourceUid: request.resource.uid,
        phase: 'Running',
        startedAt: now().toISOString(),
        outputBytes: 0,
        outputChunks: 0,
        cleaned: false,
      };
      state.executions.set(execution.executionHandle, execution);
      state.outputs.set(execution.executionHandle, []);
      remember(request, 'invoke', execution.executionHandle);
      const execute = options.executor ?? defaultExecutor;
      try {
        for await (
          const value of execute(
            descriptor,
            preparation.target,
            request.payload.arguments,
            invokeOptions.signal,
            request.resource.uid,
          )
        ) {
          if (invokeOptions.signal?.aborted) {
            throw new DOMException('tool invocation cancelled', 'AbortError');
          }
          if (typeof value !== 'string') invalid('tool output chunk must be a string');
          const bytes = new TextEncoder().encode(value).byteLength;
          if (
            execution.outputChunks + 1 > maxOutputChunks ||
            execution.outputBytes + bytes > maxOutputBytes
          ) {
            throw new OrchestrationError({
              code: 'EXHAUSTED',
              message: 'tool output quota exceeded',
              retryable: false,
            });
          }
          execution.outputBytes += bytes;
          execution.outputChunks += 1;
          const chunk: ManagedToolOutputChunk = {
            executionHandle: execution.executionHandle,
            index: execution.outputChunks - 1,
            data: value,
            final: false,
          };
          state.outputs.get(execution.executionHandle)?.push(chunk);
          yield structuredClone(chunk);
        }
        execution.phase = 'Completed';
        execution.completedAt = now().toISOString();
        const final: ManagedToolOutputChunk = {
          executionHandle: execution.executionHandle,
          index: execution.outputChunks,
          data: '',
          final: true,
        };
        state.outputs.get(execution.executionHandle)?.push(final);
        yield structuredClone(final);
      } catch (error) {
        const cancelled = invokeOptions.signal?.aborted;
        execution.phase = cancelled
          ? preparation.effect === 'read' ? 'Cancelled' : 'Unknown'
          : error instanceof OrchestrationError && error.code === 'EXHAUSTED'
          ? preparation.effect === 'read' ? 'Failed' : 'Unknown'
          : preparation.effect === 'read'
          ? 'Failed'
          : 'Unknown';
        execution.completedAt = now().toISOString();
        execution.error = {
          code: cancelled
            ? 'CANCELLED'
            : error instanceof OrchestrationError
            ? error.code
            : 'INTERNAL',
          message: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }
    },
    async inspect(request) {
      validate(request, 'tool.inspect', ['controller', 'verifier', 'admin']);
      const executionHandle = request.payload.executionHandle;
      const preparationHandle = request.payload.preparationHandle;
      if (Boolean(executionHandle) === Boolean(preparationHandle)) {
        invalid('tool inspect requires exactly one execution or preparation handle');
      }
      const execution = executionHandle
        ? state.executions.get(executionHandle)
        : [...state.executions.values()]
          .reverse()
          .find((candidate) => candidate.preparationHandle === preparationHandle);
      if (!execution) return undefined;
      if (execution.resourceUid !== request.resource.uid) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'tool execution belongs to another resource',
          retryable: false,
        });
      }
      return structuredClone(execution);
    },
    async reconcileUnknownEffect(request) {
      validate(request, 'tool.reconcile-unknown', ['controller', 'verifier', 'admin']);
      const execution = owned(
        state.executions,
        requiredString(request.payload, 'executionHandle'),
        request.resource.uid,
        'tool execution',
      );
      if (execution.phase !== 'Unknown') return structuredClone(execution);
      const preparation = owned(
        state.preparations,
        execution.preparationHandle,
        request.resource.uid,
        'tool preparation',
      );
      if (request.payload.resultObserved) {
        if (!request.payload.evidenceDigest || !SHA256.test(request.payload.evidenceDigest)) {
          invalid('observed tool result requires canonical evidenceDigest');
        }
        execution.phase = 'Completed';
        execution.error = undefined;
      } else if (preparation.effect === 'read' || preparation.idempotencyKey) {
        execution.phase = 'Prepared';
        execution.error = undefined;
        for (const [key, handle] of state.idempotency) {
          if (handle === execution.executionHandle) {
            state.idempotency.delete(key);
            state.idempotencyFingerprints.delete(key);
          }
        }
      }
      return structuredClone(execution);
    },
    async collectEvidence(request) {
      validate(request, 'tool.collect-evidence', ['controller', 'verifier', 'admin']);
      const execution = owned(
        state.executions,
        requiredString(request.payload, 'executionHandle'),
        request.resource.uid,
        'tool execution',
      );
      const descriptor = tool(
        owned(
          state.preparations,
          execution.preparationHandle,
          request.resource.uid,
          'tool preparation',
        ).toolName,
      );
      if (!descriptor?.supportsEvidence) invalid('tool does not support evidence');
      const previous = idempotency(request, 'evidence');
      if (previous) {
        return structuredClone(owned(
          state.evidence,
          previous,
          request.resource.uid,
          'tool evidence',
        ));
      }
      const evidence: ManagedToolEvidence = {
        evidenceHandle: opaque('tool-evidence'),
        executionHandle: execution.executionHandle,
        resourceUid: request.resource.uid,
        outcome: execution.phase,
        outputDigest: await digest(state.outputs.get(execution.executionHandle) ?? []),
        recordedAt: now().toISOString(),
      };
      state.evidence.set(evidence.evidenceHandle, evidence);
      remember(request, 'evidence', evidence.evidenceHandle);
      return structuredClone(evidence);
    },
    async cleanup(request) {
      validate(request, 'tool.cleanup');
      const preparation = owned(
        state.preparations,
        requiredString(request.payload, 'preparationHandle'),
        request.resource.uid,
        'tool preparation',
      );
      if (request.payload.executionHandle) {
        const execution = owned(
          state.executions,
          request.payload.executionHandle,
          request.resource.uid,
          'tool execution',
        );
        if (execution.phase === 'Running' || execution.phase === 'Unknown') {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: 'running or unknown tool execution cannot be cleaned',
            retryable: false,
          });
        }
        execution.cleaned = true;
      }
      preparation.cleaned = true;
    },
  };
}

export function createToolManagementConformanceSuite(options: {
  createRequest<T>(
    method: string,
    payload: T,
    idempotencyKey: string,
    fencingEpoch?: number,
    resourceUid?: string,
    actorKind?: 'controller' | 'verifier' | 'admin',
  ): DriverRequestEnvelope<T>;
  recreate(driver: ToolManagementDriver): ToolManagementDriver;
}): DriverConformanceSuite {
  const policyDigest = `sha256:${'b'.repeat(64)}`;

  async function prepare(
    driver: ToolManagementDriver,
    suffix: string,
    epoch = 1,
    resourceUid = 'tool-uid-1',
    operationIdempotencyKey?: string,
    toolName = 'fs.read',
  ): Promise<PreparedToolExecution> {
    const snapshot = await driver.discover(options.createRequest(
      'tool.discover',
      {},
      `discover-${suffix}`,
      epoch,
      resourceUid,
    ));
    const descriptor = snapshot.tools.find((candidate) => candidate.name === toolName);
    if (!descriptor) throw new Error(`tool '${toolName}' was not discovered`);
    return driver.prepare(options.createRequest(
      'tool.prepare',
      {
        name: descriptor.name,
        version: descriptor.version,
        schemaDigest: descriptor.schemaDigest,
        catalogDigest: snapshot.catalogDigest,
        target: descriptor.targets[0],
        effect: descriptor.effect,
        ...(operationIdempotencyKey ? { operationIdempotencyKey } : {}),
      },
      `prepare-${suffix}`,
      epoch,
      resourceUid,
    ));
  }

  async function authorize(
    driver: ToolManagementDriver,
    preparation: PreparedToolExecution,
    suffix: string,
    epoch = 1,
    resourceUid = 'tool-uid-1',
  ): Promise<AuthorizedToolExecution> {
    return driver.authorize(options.createRequest(
      'tool.authorize',
      {
        preparationHandle: preparation.preparationHandle,
        policyDecisionHandle: 'policy-decision:allow',
        policyDigest,
        ttlMs: 30_000,
      },
      `authorize-${suffix}`,
      epoch,
      resourceUid,
    ));
  }

  return {
    interfaceKind: 'tool-execution',
    tests: [
      {
        name: 'declares streaming, cancellation, backpressure, reconciliation, and persistence',
        description: 'Managed execution capabilities are explicit',
        run: async (value) => {
          const capabilities = await (value as ToolManagementDriver).getCapabilities();
          if (
            !capabilities.supportsStreaming ||
            !capabilities.supportsCancellation ||
            !capabilities.supportsBackpressure ||
            !capabilities.supportsUnknownEffectReconciliation ||
            capabilities.maxOutputBytes < 1 ||
            !capabilities.threatAssumptions.length
          ) throw new Error('tool capabilities are incomplete');
        },
      },
      {
        name: 'catalog discovery, description, preparation, and authorization bind exact metadata',
        description: 'Names cannot bypass schema, target, effect, or policy binding',
        run: async (value) => {
          const driver = value as ToolManagementDriver;
          const snapshot = await driver.discover(options.createRequest(
            'tool.discover',
            { namePrefix: 'fs.' },
            'catalog',
          ));
          const descriptor = await driver.describe(options.createRequest(
            'tool.describe',
            {
              name: snapshot.tools[0].name,
              version: snapshot.tools[0].version,
              catalogDigest: snapshot.catalogDigest,
            },
            'describe',
          ));
          const preparation = await prepare(driver, 'metadata');
          const authorization = await authorize(driver, preparation, 'metadata');
          if (
            !descriptor ||
            descriptor.schemaDigest !== preparation.schemaDigest ||
            authorization.preparationHandle !== preparation.preparationHandle
          ) throw new Error('tool metadata binding failed');
          await driver.authorize(options.createRequest(
            'tool.authorize',
            {
              preparationHandle: preparation.preparationHandle,
              policyDecisionHandle: 'caller-claims-allow',
              policyDigest,
              ttlMs: 30_000,
            },
            'forged-policy',
          )).then(
            () => {
              throw new Error('caller-controlled authorization was accepted');
            },
            () => undefined,
          );
        },
      },
      {
        name: 'invoke streams bounded output and retry replays the completed result',
        description: 'Streaming output applies backpressure and converges idempotently',
        run: async (value) => {
          const driver = value as ToolManagementDriver;
          const preparation = await prepare(driver, 'invoke');
          const authorization = await authorize(driver, preparation, 'invoke');
          const invalidRequest = options.createRequest(
            'tool.invoke',
            {
              preparationHandle: preparation.preparationHandle,
              authorizationHandle: authorization.authorizationHandle,
              arguments: { path: 42, unexpected: true },
            },
            'invoke-invalid-schema',
          );
          await (async () => {
            for await (const _chunk of driver.invoke(invalidRequest)) {
              void _chunk;
              // Invalid input must fail before yielding output.
            }
          })().then(
            () => {
              throw new Error('tool input outside the bound schema was accepted');
            },
            (error: unknown) => {
              if (
                !(error instanceof OrchestrationError) ||
                error.code !== 'INVALID'
              ) {
                throw error;
              }
            },
          );
          const request = options.createRequest(
            'tool.invoke',
            {
              preparationHandle: preparation.preparationHandle,
              authorizationHandle: authorization.authorizationHandle,
              arguments: { path: 'README.md' },
            },
            'invoke',
          );
          const first: ManagedToolOutputChunk[] = [];
          for await (const chunk of driver.invoke(request)) first.push(chunk);
          const replay: ManagedToolOutputChunk[] = [];
          for await (const chunk of driver.invoke(request)) replay.push(chunk);
          const execution = await driver.inspect(options.createRequest(
            'tool.inspect',
            { executionHandle: first[0].executionHandle },
            'inspect-invoke',
          ));
          if (
            !first.at(-1)?.final ||
            canonicalDriverValue(first) !== canonicalDriverValue(replay) ||
            execution?.phase !== 'Completed'
          ) throw new Error('tool streaming or retry did not converge');
        },
      },
      {
        name: 'unknown effects require evidence while restart preserves lifecycle and evidence',
        description: 'An uncertain side effect is never blindly repeated',
        run: async (value) => {
          let driver = value as ToolManagementDriver;
          const preparation = await prepare(
            driver,
            'unknown',
            1,
            'tool-uid-1',
            'effect-1',
            'fs.write',
          );
          const authorization = await authorize(driver, preparation, 'unknown');
          const controller = new AbortController();
          controller.abort();
          await (async () => {
            for await (
              const _chunk of driver.invoke(
                options.createRequest(
                  'tool.invoke',
                  {
                    preparationHandle: preparation.preparationHandle,
                    authorizationHandle: authorization.authorizationHandle,
                    arguments: { path: 'README.md' },
                  },
                  'unknown',
                ),
                { signal: controller.signal },
              )
            ) {
              // no-op
            }
          })().then(
            () => {
              throw new Error('cancelled invocation completed');
            },
            () => undefined,
          );
          driver = options.recreate(driver);
          const unknown = await driver.inspect(options.createRequest(
            'tool.inspect',
            { preparationHandle: preparation.preparationHandle },
            'inspect-unknown',
          ));
          if (unknown?.phase !== 'Unknown') {
            throw new Error('side-effect cancellation was not marked unknown');
          }
          const reconciled = await driver.reconcileUnknownEffect(options.createRequest(
            'tool.reconcile-unknown',
            {
              executionHandle: unknown.executionHandle,
              resultObserved: false,
            },
            'reconcile-unknown',
          ));
          if (reconciled.phase !== 'Prepared') {
            throw new Error('idempotent unknown effect was not made retryable');
          }
          const retry = driver.invoke(options.createRequest(
            'tool.invoke',
            {
              preparationHandle: preparation.preparationHandle,
              authorizationHandle: authorization.authorizationHandle,
              arguments: { path: 'README.md' },
            },
            'unknown',
          ));
          const retried: ManagedToolOutputChunk[] = [];
          for await (const chunk of retry) retried.push(chunk);
          if (!retried.at(-1)?.final) throw new Error('reconciled invocation did not complete');
        },
      },
      {
        name: 'fencing, ownership, idempotency drift, evidence, and cleanup fail closed',
        description: 'Distributed retries and handles remain isolated',
        run: async (value) => {
          let driver = value as ToolManagementDriver;
          const preparation = await prepare(driver, 'security', 3);
          const authorization = await authorize(driver, preparation, 'security', 3);
          await driver.authorize(options.createRequest(
            'tool.authorize',
            {
              preparationHandle: preparation.preparationHandle,
              policyDecisionHandle: 'policy-decision:allow',
              policyDigest,
              ttlMs: 30_000,
            },
            'verifier-authorize',
            3,
            'tool-uid-1',
            'verifier',
          )).then(
            () => {
              throw new Error('verifier actor authorized tool execution');
            },
            () => undefined,
          );
          const chunks: ManagedToolOutputChunk[] = [];
          for await (
            const chunk of driver.invoke(options.createRequest(
              'tool.invoke',
              {
                preparationHandle: preparation.preparationHandle,
                authorizationHandle: authorization.authorizationHandle,
                arguments: { path: 'README.md' },
              },
              'security',
              3,
            ))
          ) chunks.push(chunk);
          driver = options.recreate(driver);
          const evidence = await driver.collectEvidence(options.createRequest(
            'tool.collect-evidence',
            { executionHandle: chunks[0].executionHandle },
            'evidence',
            3,
          ));
          if (!evidence.outputDigest.startsWith('sha256:')) {
            throw new Error('tool evidence is incomplete');
          }
          await driver.inspect(options.createRequest(
            'tool.inspect',
            { executionHandle: chunks[0].executionHandle },
            'foreign',
            3,
            'foreign-tool-uid',
          )).then(
            () => {
              throw new Error('foreign tool execution was disclosed');
            },
            () => undefined,
          );
          await driver.cleanup(options.createRequest(
            'tool.cleanup',
            {
              preparationHandle: preparation.preparationHandle,
              executionHandle: chunks[0].executionHandle,
            },
            'cleanup',
            3,
          ));
          await driver.discover(options.createRequest(
            'tool.discover',
            {},
            'stale',
            2,
          )).then(
            () => {
              throw new Error('stale tool fencing epoch was accepted');
            },
            () => undefined,
          );
        },
      },
    ],
  };
}

/**
 * Catalog discovery is a separately selectable manifest kind. Reuse only the
 * unified driver's catalog cases; execution evidence cannot admit a catalog.
 */
export function createToolCatalogConformanceSuite(
  options: Parameters<typeof createToolManagementConformanceSuite>[0],
): DriverConformanceSuite {
  const unified = createToolManagementConformanceSuite(options);
  return {
    interfaceKind: 'tool-catalog',
    tests: unified.tests.slice(0, 2),
  };
}
