import type { ProviderRegistryResolver } from '../llm/providerRegistry.js';
import type { LoopProfile } from '../loopAPI/types.js';
import { safeErrorMessageFromUnknown } from '../safeError.js';
import type { AgentFrameworkContext, ILLMProvider } from '../types.js';

import { OrchestrationError } from './errors.js';
import type { AgentRunResource, AgentWorkloadResource, ModelEndpointResource, NetworkAttachmentResource } from './resources.js';
import { BUILTIN_RUNTIME_CLASSES, type RuntimeClassSpec } from './scripts/scriptRuntime.js';

/**
 * Loop Runtime Driver (plan §10.2, Phase 4.2).
 *
 * The cognition-plane counterpart of the tool execution driver (24.28): a
 * LoopRuntimeDriver starts an AgentLoopRun-equivalent execution for a bound
 * AgentWorkload and reports a terminal outcome. The in-process
 * implementation runs the loop in the current process through the existing
 * profile/script machinery — the same contracts apply as for remote drivers
 * (no authorization bypass; scripts re-pass the host load gate on import).
 */

export interface LoopRunStartRequest {
  /** Bound workload being executed. */
  workload: AgentWorkloadResource;
  /** AgentRun resource tracking this attempt. */
  run: AgentRunResource;
  /** Fenced ModelEndpoint selected independently for this run. */
  modelEndpoint?: ModelEndpointResource;
  /** Independently bound and prepared network attachment for this run. */
  networkAttachment?: NetworkAttachmentResource;
  /** Ephemeral host-resolved mounts; never persisted in ControlStore. */
  volumeMounts?: Array<{
    name: string;
    mountPath: string;
    readOnly: boolean;
  }>;
  /**
   * Script source resolved by the host for `spec.scriptReference` workloads.
   * The driver re-admits it through the host script load gate before import.
   */
  scriptSource?: string;
  /** Message delivered to the loop as its input. */
  message?: string;
}

export interface LoopRunOutcome {
  phase: 'Completed' | 'Failed' | 'Cancelled';
  summary?: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface LoopRunHandle {
  /** Terminal outcome of the run. */
  wait(): Promise<LoopRunOutcome>;
  /** Request cancellation; the loop observes it through the cancellation set. */
  cancel(): Promise<void>;
}

export interface LoopRuntimeDriver {
  start(request: LoopRunStartRequest): Promise<LoopRunHandle>;
}

export interface InProcessLoopRuntimeDriverOptions {
  /**
   * Resolve a provider for an independently placed endpoint. Downstream hosts
   * use this port for remote ModelGateway transports. Returning undefined
   * fails closed.
   */
  resolveModelProvider?: (
    endpoint: ModelEndpointResource,
    request: LoopRunStartRequest,
  ) => Promise<ILLMProvider | undefined>;
}

function toErrorData(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof OrchestrationError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: 'INTERNAL',
    message: safeErrorMessageFromUnknown(error, { fallback: 'Loop runtime failed' }),
    retryable: false,
  };
}

/** Extract text from a loop step; tolerates raw string yields (AgentAgent runScript passes them through unwrapped). */
function extractMessageText(step: unknown): string {
  if (typeof step === 'string') return step;
  if (step && typeof step === 'object') {
    const record = step as { type?: unknown; data?: unknown };
    if (record.type === 'message' && typeof record.data === 'string') return record.data;
  }
  return '';
}

/** Preserve the exact logical provider/model catalog while fencing execution through one run provider. */
function routeProvidersThrough(
  registry: ProviderRegistryResolver,
  provider: ILLMProvider,
): ProviderRegistryResolver {
  return Object.freeze({
    get(name: string) {
      return registry.get(name) === undefined ? undefined : provider;
    },
    getConfig: (name: string) => registry.getConfig(name),
    list: () => registry.list(),
    listConfigs: () => registry.listConfigs(),
    resolve(providerId: string, modelId: string) {
      return { ...registry.resolve(providerId, modelId), provider };
    },
  });
}

/**
 * In-process LoopRuntimeDriver: executes profile workloads through the
 * definition store and script workloads through a synthesized AgentAgent
 * profile whose source was resolved (and admitted) upstream.
 */
export function createInProcessLoopRuntimeDriver(
  context: AgentFrameworkContext,
  options: InProcessLoopRuntimeDriverOptions = {},
): LoopRuntimeDriver {
  return {
    async start(request) {
      const { workload, run } = request;
      const conversationId = `looprun:${run.metadata.namespace ?? 'default'}:${run.metadata.name}`;
      const message = request.message ?? workload.metadata.name;
      let executionContext = context;

      if (
        request.networkAttachment ||
        workload.spec.networkPolicy?.networkClass ||
        request.volumeMounts?.length ||
        workload.spec.storagePolicy?.volumes?.length
      ) {
        throw new OrchestrationError({
          code: 'UNSUPPORTED',
          message: `in-process workload '${workload.metadata.name}' cannot consume isolated network/volume dependencies`,
          retryable: false,
        });
      }

      if (workload.spec.modelPolicy?.modelClass) {
        const endpoint = request.modelEndpoint;
        if (
          !endpoint ||
          run.status?.assignedModelEndpoint?.uid !== endpoint.metadata.uid ||
          endpoint.spec.modelClassRef.name !== workload.spec.modelPolicy.modelClass
        ) {
          throw new OrchestrationError({
            code: 'INVALID',
            message: `run '${run.metadata.name}' has no valid fenced ModelEndpoint binding`,
            retryable: false,
          });
        }
        if (options.resolveModelProvider) {
          const provider = await options.resolveModelProvider(endpoint, request);
          if (!provider) {
            throw new OrchestrationError({
              code: 'UNAVAILABLE',
              message: `ModelEndpoint '${endpoint.metadata.name}' has no reachable provider transport`,
              retryable: true,
            });
          }
          executionContext = {
            ...context,
            llmProvider: provider,
            ...(context.modelProviderRegistry === undefined
              ? {}
              : {
                modelProviderRegistry: routeProvidersThrough(
                  context.modelProviderRegistry,
                  provider,
                ),
              }),
          };
        } else if (endpoint.spec.nodeId !== workload.status?.assignedNode) {
          throw new OrchestrationError({
            code: 'UNSUPPORTED',
            message: `remote ModelEndpoint '${endpoint.metadata.name}' requires a host ModelGateway transport`,
            retryable: false,
          });
        }
      }

      // Lazy import: a top-level value import of runtime.js creates a module
      // initialization cycle (orchestration/index → loopRuntimeDriver →
      // runtime → builtinLoopsPlugin → agent-agent-loop → orchestration).
      const { createAgentLoopRunner, createAgentLoopScriptRunner } = await import('../runtime.js');

      let runner: ((input: { conversationId: string; message: string }) => AsyncIterable<unknown>) | null = null;

      if (workload.spec.scriptReference) {
        if (!request.scriptSource) {
          throw new OrchestrationError({
            code: 'INVALID',
            message: `workload '${workload.metadata.name}' has scriptReference '${workload.spec.scriptReference}' but no script source was resolved`,
            retryable: false,
          });
        }
        const profile: LoopProfile = {
          id: `workload:${workload.metadata.name}`,
          name: workload.metadata.name,
          description: 'AgentWorkload script execution',
          loopId: 'agent-agent-loop',
          scriptReference: { kind: 'source', source: request.scriptSource },
        };
        runner = await createAgentLoopScriptRunner(executionContext, profile, conversationId);
      } else if (workload.spec.profileId) {
        runner = await createAgentLoopRunner(executionContext, { definitionId: workload.spec.profileId, conversationId });
      } else {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `workload '${workload.metadata.name}' has neither scriptReference nor profileId`,
          retryable: false,
        });
      }

      if (!runner) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `no loop runner for workload '${workload.metadata.name}' (profile '${workload.spec.profileId ?? ''}' not found)`,
          retryable: false,
        });
      }

      const waitPromise = (async (): Promise<LoopRunOutcome> => {
        try {
          let summary = '';
          for await (const step of runner({ conversationId, message })) {
            summary += extractMessageText(step);
          }
          if (executionContext.conversationCancellation?.has(conversationId)) {
            executionContext.conversationCancellation.delete(conversationId);
            return { phase: 'Cancelled', summary };
          }
          return { phase: 'Completed', summary };
        } catch (error) {
          return { phase: 'Failed', error: toErrorData(error) };
        }
      })();

      return {
        wait: () => waitPromise,
        async cancel() {
          executionContext.conversationCancellation?.add(conversationId);
        },
      };
    },
  };
}

// ─── RuntimeClass routing ─────────────────────────────────────────────

export interface RuntimeClassRoutingDriverOptions {
  /**
   * Driver for profile workloads and for script workloads whose RuntimeClass
   * declares `isolation: 'none'`.
   */
  inProcessDriver: LoopRuntimeDriver;
  /**
   * Driver for script workloads whose RuntimeClass declares
   * `isolation: 'process'` (all built-in classes do). When absent, such
   * workloads fail closed with UNSUPPORTED rather than silently running
   * in-process (plan 24.18: declared isolation must be real).
   */
  processDriver?: LoopRuntimeDriver;
  /** RuntimeClass specs by name (defaults to the built-in classes). */
  runtimeClasses?: Record<string, RuntimeClassSpec>;
}

/**
 * Route a bound workload to the driver that honors its declared RuntimeClass
 * isolation. Unknown or missing classes fail closed — admission (plan 24.18)
 * assigns a RuntimeClass before scheduling, and there is no silent fallback
 * to a weaker isolation level.
 */
export function createRuntimeClassRoutingDriver(options: RuntimeClassRoutingDriverOptions): LoopRuntimeDriver {
  const runtimeClasses = options.runtimeClasses ?? BUILTIN_RUNTIME_CLASSES;

  function resolveDriver(workload: AgentWorkloadResource): LoopRuntimeDriver {
    if (!workload.spec.scriptReference) {
      // Profile workloads run host-trusted definitions in-process.
      return options.inProcessDriver;
    }
    const className = workload.spec.runtimeClass;
    if (!className) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: `script workload '${workload.metadata.name}' has no runtimeClass; admission (plan 24.18) must assign one before scheduling`,
        retryable: false,
      });
    }
    const spec = runtimeClasses[className];
    if (!spec) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: `script workload '${workload.metadata.name}' references unknown RuntimeClass '${className}' — fail-closed, no silent fallback (plan 24.18)`,
        retryable: false,
      });
    }
    if (spec.isolation === 'none') return options.inProcessDriver;
    if (spec.isolation === 'process') {
      if (!options.processDriver) {
        throw new OrchestrationError({
          code: 'UNSUPPORTED',
          message: `RuntimeClass '${className}' declares process isolation but no process LoopRuntimeDriver is configured`,
          retryable: false,
        });
      }
      return options.processDriver;
    }
    throw new OrchestrationError({
      code: 'UNSUPPORTED',
      message: `RuntimeClass '${className}' declares '${spec.isolation}' isolation; no LoopRuntimeDriver provides it`,
      retryable: false,
    });
  }

  return {
    async start(request) {
      return resolveDriver(request.workload).start(request);
    },
  };
}
