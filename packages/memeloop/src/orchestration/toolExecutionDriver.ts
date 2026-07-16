import type { BuiltinToolContext, BuiltinToolImpl } from '../tools/builtins/types.js';
import type { IToolRegistry } from '../types.js';
import type { ToolOperationResource, ToolOperationResult, ToolOperationStatus } from './resources.js';

export interface ToolExecutionDriver {
  execute(operation: ToolOperationResource): Promise<ToolOperationResource>;
}

export interface InProcessToolExecutionDriverOptions {
  context: BuiltinToolContext;
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

    if (operation.spec.policy?.requireApproval) {
      const result: ToolOperationResult = {
        error: {
          code: 'FORBIDDEN',
          message: 'ToolOperation requires approval; approval flow not implemented in in-process driver',
          retryable: false,
        },
      };
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

    if (typeof tool !== 'function') {
      const result: ToolOperationResult = {
        error: { code: 'UNSUPPORTED', message: `Tool "${toolId}" is not available as a function executor`, retryable: false },
      };
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
      const result: ToolOperationResult = { error: { code: 'INTERNAL', message, retryable: false } };
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
  }

  return { execute };
}
