import { safeErrorMessageFromUnknown } from '../../safeError.js';
import type { BuiltinToolContext, BuiltinToolImpl } from '../../tools/builtins/types.js';
import type { IToolRegistry } from '../../types.js';
import type { ControlStoreActor } from '../controlStore.js';
import type { ToolOperationApprovalEvidence, ToolOperationResource, ToolOperationResult, ToolOperationStatus } from '../resources.js';
import { evaluateToolAdmission, type ToolAdmissionPolicy } from '../security/admission.js';

export interface ToolExecutionDriver {
  execute(
    operation: ToolOperationResource,
    options?: {
      signal?: AbortSignal;
      /** Optional authenticated actor binding for managed routes. */
      actor?: ControlStoreActor;
      leaseEpoch?: string;
    },
  ): Promise<ToolOperationResource>;
}

export type ToolOperationApprovalDecision = ToolOperationApprovalEvidence;

export interface ToolOperationApprovalRequest {
  operation: ToolOperationResource;
  /** Trusted policy explanation; never interpreted as authority by itself. */
  reason?: string;
  signal?: AbortSignal;
}

/** Host-owned approval boundary. Implementations bind authenticated users and durable audit. */
export interface ToolOperationApprovalBroker {
  requestApproval(request: ToolOperationApprovalRequest): Promise<ToolOperationApprovalDecision>;
}

export interface InProcessToolExecutionDriverOptions {
  context: BuiltinToolContext;
  /**
   * Host-bound trusted admission policy. Enforced before approval checks and
   * tool lookup; the model, scripts, and agent configuration cannot override
   * it. Denied operations fail with `FORBIDDEN` and are still audited.
   */
  admission?: ToolAdmissionPolicy;
  approvalBroker?: ToolOperationApprovalBroker;
  auditor?: (
    operation: ToolOperationResource,
    result: ToolOperationResult,
  ) => Promise<void> | void;
  /** Receives audit sink failures without changing the durable operation result. */
  onAuditError?: (
    error: unknown,
    operation: ToolOperationResource,
    result: ToolOperationResult,
  ) => void;
  maxOutputLength?: number;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value != null && typeof value === 'object' && Symbol.asyncIterator in value;
}

function normalizeToolResult(value: unknown, maxOutputLength?: number): { text: string; structured?: unknown } {
  if (typeof value === 'string') {
    const text = maxOutputLength && value.length > maxOutputLength ? `${value.slice(0, maxOutputLength)}...` : value;
    return { text };
  }
  if (value && typeof value === 'object') {
    let text = '';
    if ('summary' in value && typeof value.summary === 'string') {
      text = value.summary;
    } else if ('result' in value && typeof value.result === 'string') {
      text = value.result;
    } else {
      text = JSON.stringify(value);
    }
    const truncated = maxOutputLength && text.length > maxOutputLength ? `${text.slice(0, maxOutputLength)}...` : text;
    return { text: truncated, structured: value };
  }
  return { text: String(value) };
}

export function createInProcessToolExecutionDriver(
  registry: IToolRegistry,
  options: InProcessToolExecutionDriverOptions,
): ToolExecutionDriver {
  async function execute(
    operation: ToolOperationResource,
    executionOptions: {
      signal?: AbortSignal;
      actor?: ControlStoreActor;
      leaseEpoch?: string;
    } = {},
  ): Promise<ToolOperationResource> {
    const startedAt = new Date().toISOString();
    const toolId = operation.spec.toolRef.name;

    const pendingStatus: ToolOperationStatus = {
      ...operation.status,
      phase: 'Running',
      startedAt,
      attempts: (operation.status?.attempts ?? 0) + 1,
    };
    const runningOperation: ToolOperationResource = { ...operation, status: pendingStatus };
    let approval: ToolOperationStatus['approval'];

    function operationWithApproval(): ToolOperationResource {
      if (!approval) return runningOperation;
      return {
        ...runningOperation,
        status: {
          ...runningOperation.status,
          approval,
        },
      };
    }

    if (executionOptions.signal?.aborted) {
      return failed({
        error: {
          code: 'CANCELLED',
          message: 'ToolOperation cancelled before admission',
          retryable: false,
        },
      });
    }

    async function audit(
      auditedOperation: ToolOperationResource,
      result: ToolOperationResult,
    ): Promise<void> {
      try {
        await options.auditor?.(auditedOperation, result);
      } catch (error) {
        // Keep the durable ToolOperation result authoritative, while making a
        // failed audit sink observable to the host's dedicated error channel.
        options.onAuditError?.(error, auditedOperation, result);
      }
    }

    async function failed(
      result: ToolOperationResult,
    ): Promise<ToolOperationResource> {
      const auditedOperation = operationWithApproval();
      await audit(auditedOperation, result);
      return {
        ...auditedOperation,
        status: {
          ...auditedOperation.status,
          phase: 'Failed',
          result,
          completedAt: new Date().toISOString(),
        },
      };
    }

    let approvalReason: string | undefined;
    if (options.admission) {
      const decision = evaluateToolAdmission(options.admission, operation);
      if (decision.action === 'deny') {
        return failed({
          error: {
            code: 'FORBIDDEN',
            message: decision.reason ?? `ToolOperation denied by trusted admission policy (${decision.source})`,
            retryable: false,
            details: { admissionSource: decision.source },
          },
        });
      }
      if (decision.action === 'require-approval') {
        approvalReason = decision.reason ??
          `ToolOperation requires approval (${decision.source})`;
      }
    }

    if (operation.spec.policy?.requireApproval) {
      approvalReason ??= 'ToolOperation policy requires approval';
    }

    if (approvalReason) {
      if (!options.approvalBroker) {
        return failed({
          error: {
            code: 'FORBIDDEN',
            message: `${approvalReason}; no trusted approval broker is configured`,
            retryable: false,
          },
        });
      }
      try {
        const decision = await options.approvalBroker.requestApproval({
          operation: runningOperation,
          reason: approvalReason,
          signal: executionOptions.signal,
        });
        if (
          !decision.approvalId ||
          !decision.actor ||
          !decision.decidedAt ||
          (decision.decision !== 'allow' && decision.decision !== 'deny') ||
          Number.isNaN(Date.parse(decision.decidedAt))
        ) {
          return await failed({
            error: {
              code: 'FORBIDDEN',
              message: 'Trusted approval broker returned invalid evidence',
              retryable: false,
            },
          });
        }
        approval = decision;
        if (executionOptions.signal?.aborted) {
          return await failed({
            error: {
              code: 'CANCELLED',
              message: 'ToolOperation approval was cancelled',
              retryable: false,
            },
          });
        }
        if (decision.decision !== 'allow') {
          return await failed({
            error: {
              code: 'FORBIDDEN',
              message: decision.reason ?? 'ToolOperation approval was denied',
              retryable: false,
            },
          });
        }
      } catch {
        return failed({
          error: {
            code: executionOptions.signal?.aborted
              ? 'CANCELLED'
              : 'FORBIDDEN',
            message: executionOptions.signal?.aborted
              ? 'ToolOperation approval was cancelled'
              : 'Trusted approval broker failed closed',
            retryable: false,
          },
        });
      }
    }

    const tool = registry.getTool(toolId);
    if (typeof tool !== 'function') {
      return failed({
        error: { code: 'UNSUPPORTED', message: `Tool "${toolId}" is not available as a function executor`, retryable: false },
      });
    }

    try {
      const impl = tool as BuiltinToolImpl;
      const executionContext: BuiltinToolContext = executionOptions.signal
        ? { ...options.context, operationSignal: executionOptions.signal }
        : options.context;
      const raw = await impl(operation.spec.arguments ?? {}, executionContext);
      let value: unknown;
      if (isAsyncIterable(raw)) {
        const chunks: unknown[] = [];
        const iterator = raw[Symbol.asyncIterator]();
        try {
          while (true) {
            if (executionOptions.signal?.aborted) {
              throw new DOMException('ToolOperation cancelled', 'AbortError');
            }
            const item = await iterator.next();
            if (item.done) break;
            chunks.push(item.value);
          }
        } finally {
          await iterator.return?.();
        }
        value = chunks;
      } else {
        value = raw;
      }

      const { text, structured } = normalizeToolResult(value, options.maxOutputLength);
      const result: ToolOperationResult = { value: structured ?? text };
      const auditedOperation = operationWithApproval();
      await audit(auditedOperation, result);
      return {
        ...auditedOperation,
        status: {
          ...auditedOperation.status,
          phase: 'Completed',
          result,
          completedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      const aborted = executionOptions.signal?.aborted;
      const message = aborted
        ? 'ToolOperation cancelled'
        : safeErrorMessageFromUnknown(error, { fallback: 'Tool execution failed' });
      return failed({
        error: {
          code: aborted ? 'CANCELLED' : 'INTERNAL',
          message,
          retryable: false,
        },
      });
    }
  }

  return { execute };
}
