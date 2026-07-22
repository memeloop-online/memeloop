import type { LoopProfile } from '../loopAPI/types.js';
import type { AgentFrameworkContext } from '../types.js';

import { OrchestrationError } from './errors.js';
import type { AgentRunResource, AgentWorkloadResource } from './resources.js';

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

function toErrorData(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof OrchestrationError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
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

/**
 * In-process LoopRuntimeDriver: executes profile workloads through the
 * definition store and script workloads through a synthesized AgentAgent
 * profile whose source was resolved (and admitted) upstream.
 */
export function createInProcessLoopRuntimeDriver(context: AgentFrameworkContext): LoopRuntimeDriver {
  return {
    async start(request) {
      const { workload, run } = request;
      const conversationId = `looprun:${run.metadata.namespace ?? 'default'}:${run.metadata.name}`;
      const message = request.message ?? workload.metadata.name;

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
        runner = await createAgentLoopScriptRunner(context, profile, conversationId);
      } else if (workload.spec.profileId) {
        runner = await createAgentLoopRunner(context, { definitionId: workload.spec.profileId, conversationId });
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
          if (context.conversationCancellation?.has(conversationId)) {
            context.conversationCancellation.delete(conversationId);
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
          context.conversationCancellation?.add(conversationId);
        },
      };
    },
  };
}
