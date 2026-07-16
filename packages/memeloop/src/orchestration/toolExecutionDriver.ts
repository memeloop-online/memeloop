import type { BuiltinToolContext, BuiltinToolImpl } from '../tools/builtins/types.js';
import type { IToolRegistry } from '../types.js';
import { evaluateToolAdmission, type ToolAdmissionPolicy } from './admission.js';
import type { ToolOperationResource, ToolOperationResult, ToolOperationStatus } from './resources.js';

export interface ToolExecutionDriver {
  execute(operation: ToolOperationResource): Promise<ToolOperationResource>;
}

export interface InProcessToolExecutionDriverOptions {
  context: BuiltinToolContext;
  /**
   * Host-bound trusted admission policy. Enforced before approval checks and
   * tool lookup; the model, scripts, and agent configuration cannot override
   * it. Denied operations fail with `FORBIDDEN` and are still audited.
   */
  admission?: ToolAdmissionPolicy;
  auditor?: (operation: ToolOperationResource, result: ToolOperationResult) => void;
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
  async function execute(operation: ToolOperationResource): Promise<ToolOperationResource> {
    const startedAt = new Date().toISOString();
    const toolId = operation.spec.toolRef.name;
    const tool = registry.getTool(toolId);

    const pendingStatus: ToolOperationStatus = {
      ...operation.status,
      phase: 'Running',
      startedAt,
      attempts: (operation.status?.attempts ?? 0) + 1,
    };
    const runningOperation: ToolOperationResource = { ...operation, status: pendingStatus };

    function failed(result: ToolOperationResult): ToolOperationResource {
      options.auditor?.(runningOperation, result);
      return {
        ...runningOperation,
        status: {
          ...runningOperation.status,
          phase: 'Failed',
          result,
          completedAt: new Date().toISOString(),
        },
      };
    }

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
        return failed({
          error: {
            code: 'FORBIDDEN',
            message: decision.reason ?? 'ToolOperation requires approval; approval flow not implemented in in-process driver',
            retryable: false,
            details: { admissionSource: decision.source },
          },
        });
      }
    }

    if (operation.spec.policy?.requireApproval) {
      return failed({
        error: {
          code: 'FORBIDDEN',
          message: 'ToolOperation requires approval; approval flow not implemented in in-process driver',
          retryable: false,
        },
      });
    }

    if (typeof tool !== 'function') {
      return failed({
        error: { code: 'UNSUPPORTED', message: `Tool "${toolId}" is not available as a function executor`, retryable: false },
      });
    }

    try {
      const impl = tool as BuiltinToolImpl;
      const raw = await impl(operation.spec.arguments ?? {}, options.context);
      let value: unknown;
      if (isAsyncIterable(raw)) {
        const chunks: unknown[] = [];
        for await (const chunk of raw) {
          chunks.push(chunk);
        }
        value = chunks;
      } else {
        value = raw;
      }

      const { text, structured } = normalizeToolResult(value, options.maxOutputLength);
      const result: ToolOperationResult = { value: structured ?? text };
      options.auditor?.(runningOperation, result);
      return {
        ...runningOperation,
        status: {
          ...runningOperation.status,
          phase: 'Completed',
          result,
          completedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failed({ error: { code: 'INTERNAL', message, retryable: false } });
    }
  }

  return { execute };
}
