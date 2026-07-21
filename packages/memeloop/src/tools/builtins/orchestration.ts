import type {
  AgentOrchestrationClient,
  OrchestrationApplyOptions,
  OrchestrationConditionStatus,
  OrchestrationDeleteOptions,
  OrchestrationGetOptions,
  OrchestrationListOptions,
  OrchestrationManifestMetadata,
  OrchestrationPreconditions,
  OrchestrationResourceManifest,
  OrchestrationResourceQuery,
  OrchestrationResourceReference,
} from '../../orchestration/index.js';
import { OrchestrationError, toOrchestrationErrorData, waitForCondition } from '../../orchestration/index.js';
import type { BuiltinToolImpl } from './types.js';

export const ORCHESTRATION_TOOL_ID = 'orchestration';

export const orchestrationConfigSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['capabilities', 'apply', 'get', 'list', 'wait', 'delete'],
      description: 'Declarative orchestration resource operation.',
    },
    resource: {
      type: 'object',
      description: 'Resource manifest for apply. status and actor fields are not accepted.',
    },
    reference: {
      type: 'object',
      description: 'Resource reference for get, wait, or delete.',
    },
    query: {
      type: 'object',
      description: 'Resource query for list.',
    },
    condition: {
      type: 'object',
      description: 'Condition to wait for. Required when action is wait.',
    },
    options: {
      type: 'object',
      description: 'Operation options. Only documented fields are forwarded.',
    },
  },
  required: ['action'],
} as const;

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function invalidError(message: string): OrchestrationError {
  return new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = objectValue(value, 'record');
  const entries = Object.entries(record);
  if (entries.some(([, entry]) => typeof entry !== 'string')) {
    throw invalidError('record values must be strings');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function metadataValue(value: unknown): OrchestrationManifestMetadata {
  const metadata = objectValue(value, 'resource.metadata');
  return {
    name: optionalString(metadata.name),
    generateName: optionalString(metadata.generateName),
    namespace: optionalString(metadata.namespace),
    labels: stringRecord(metadata.labels),
    annotations: stringRecord(metadata.annotations),
  };
}

function resourceValue(value: unknown): OrchestrationResourceManifest {
  const resource = objectValue(value, 'resource');
  const apiVersion = optionalString(resource.apiVersion);
  const kind = optionalString(resource.kind);
  if (!apiVersion || !kind) throw invalidError('resource requires apiVersion and kind');
  return {
    apiVersion,
    kind,
    metadata: metadataValue(resource.metadata),
    spec: objectValue(resource.spec, 'resource.spec'),
  };
}

function referenceValue(value: unknown): OrchestrationResourceReference {
  const reference = objectValue(value, 'reference');
  const apiVersion = optionalString(reference.apiVersion);
  const kind = optionalString(reference.kind);
  const name = optionalString(reference.name);
  const uid = optionalString(reference.uid);
  if (!apiVersion || !kind || (!name && !uid)) {
    throw invalidError('reference requires apiVersion, kind, and name or uid');
  }
  return {
    apiVersion,
    kind,
    name,
    namespace: optionalString(reference.namespace),
    uid,
  };
}

function queryValue(value: unknown): OrchestrationResourceQuery {
  const query = objectValue(value, 'query');
  const kind = optionalString(query.kind);
  if (!kind) throw invalidError('query requires kind');
  return {
    apiVersion: optionalString(query.apiVersion),
    kind,
    namespace: optionalString(query.namespace),
    labels: stringRecord(query.labels),
  };
}

function preconditionsValue(value: unknown): OrchestrationPreconditions | undefined {
  if (value === undefined) return undefined;
  const preconditions = objectValue(value, 'options.preconditions');
  return {
    uid: optionalString(preconditions.uid),
    resourceVersion: optionalString(preconditions.resourceVersion),
    generation: typeof preconditions.generation === 'number' ? preconditions.generation : undefined,
  };
}

function applyOptions(value: unknown): OrchestrationApplyOptions | undefined {
  if (value === undefined) return undefined;
  const options = objectValue(value, 'options');
  return {
    idempotencyKey: optionalString(options.idempotencyKey),
    fieldManager: optionalString(options.fieldManager),
    force: optionalBoolean(options.force),
    dryRun: optionalBoolean(options.dryRun),
    preconditions: preconditionsValue(options.preconditions),
  };
}

function getOptions(value: unknown): OrchestrationGetOptions | undefined {
  if (value === undefined) return undefined;
  const options = objectValue(value, 'options');
  return { resourceVersion: optionalString(options.resourceVersion) };
}

function listOptions(value: unknown): OrchestrationListOptions | undefined {
  if (value === undefined) return undefined;
  const options = objectValue(value, 'options');
  return {
    resourceVersion: optionalString(options.resourceVersion),
    resourceVersionMatch: options.resourceVersionMatch === 'exact' || options.resourceVersionMatch === 'not-older-than'
      ? options.resourceVersionMatch
      : undefined,
    limit: typeof options.limit === 'number' ? options.limit : undefined,
    continueToken: optionalString(options.continueToken),
  };
}

function deleteOptions(value: unknown): OrchestrationDeleteOptions | undefined {
  if (value === undefined) return undefined;
  const options = objectValue(value, 'options');
  const propagationPolicy = options.propagationPolicy;
  const validPropagationPolicy = propagationPolicy === 'orphan' || propagationPolicy === 'background' || propagationPolicy === 'foreground'
    ? propagationPolicy
    : undefined;
  return {
    idempotencyKey: optionalString(options.idempotencyKey),
    preconditions: preconditionsValue(options.preconditions),
    propagationPolicy: validPropagationPolicy,
    dryRun: optionalBoolean(options.dryRun),
  };
}

function waitConditionValue(value: unknown): { type: string; status: OrchestrationConditionStatus } {
  const condition = objectValue(value, 'condition');
  const type = optionalString(condition.type);
  if (!type) throw invalidError('condition requires type');
  const status = condition.status === 'True' || condition.status === 'False' || condition.status === 'Unknown'
    ? condition.status
    : 'True';
  return { type, status };
}

function waitOptions(value: unknown): { timeout?: number; interval?: number } {
  if (value === undefined) return {};
  const options = objectValue(value, 'options');
  const timeout = typeof options.timeout === 'number' ? options.timeout : undefined;
  const interval = typeof options.interval === 'number' ? options.interval : undefined;
  if (timeout !== undefined && timeout <= 0) throw invalidError('timeout must be positive');
  if (interval !== undefined && interval <= 0) throw invalidError('interval must be positive');
  return { timeout, interval };
}

async function waitForResourceCondition(
  context: Parameters<BuiltinToolImpl>[1],
  client: AgentOrchestrationClient,
  reference: OrchestrationResourceReference,
  condition: { type: string; status: OrchestrationConditionStatus },
  options: { timeout?: number; interval?: number },
): Promise<{ observedResourceVersion: string; matched: true }> {
  return waitForCondition(
    () => client.get(reference, { resourceVersion: undefined }),
    condition,
    {
      ...options,
      isCancelled: () =>
        context.isCancelled?.() === true ||
        (context.activeToolConversationId !== undefined && context.conversationCancellation?.has(context.activeToolConversationId) === true),
    },
  );
}

export const orchestrationImpl: BuiltinToolImpl = async (arguments_, context) => {
  const client = context.orchestration;
  if (!client) {
    return {
      error: {
        code: 'UNSUPPORTED',
        message: 'Orchestration manager not configured.',
        retryable: false,
      },
    };
  }

  try {
    switch (arguments_.action) {
      case 'capabilities':
        return await client.getCapabilities();
      case 'apply':
        return await client.apply(resourceValue(arguments_.resource), applyOptions(arguments_.options));
      case 'get':
        return await client.get(referenceValue(arguments_.reference), getOptions(arguments_.options));
      case 'list':
        return await client.list(queryValue(arguments_.query), listOptions(arguments_.options));
      case 'wait':
        return await waitForResourceCondition(
          context,
          client,
          referenceValue(arguments_.reference),
          waitConditionValue(arguments_.condition),
          waitOptions(arguments_.options),
        );
      case 'delete':
        return await client.delete(referenceValue(arguments_.reference), deleteOptions(arguments_.options));
      default:
        throw invalidError('orchestration requires a supported action');
    }
  } catch (error) {
    return { error: toOrchestrationErrorData(error) };
  }
};
