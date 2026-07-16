import type {
  OrchestrationApplyOptions,
  OrchestrationDeleteOptions,
  OrchestrationGetOptions,
  OrchestrationListOptions,
  OrchestrationManifestMetadata,
  OrchestrationResourceManifest,
  OrchestrationResourceQuery,
  OrchestrationResourceReference,
} from '../../orchestration/index.js';
import type { BuiltinToolImpl } from './types.js';

export const ORCHESTRATION_TOOL_ID = 'orchestration';

export const orchestrationConfigSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['capabilities', 'apply', 'get', 'list', 'delete'],
      description: 'Declarative orchestration resource operation.',
    },
    resource: {
      type: 'object',
      description: 'Resource manifest for apply. status and actor fields are not accepted.',
    },
    reference: {
      type: 'object',
      description: 'Resource reference for get or delete.',
    },
    query: {
      type: 'object',
      description: 'Resource query for list.',
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
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
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
    throw new Error('record values must be strings');
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
  if (!apiVersion || !kind) throw new Error('resource requires apiVersion and kind');
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
    throw new Error('reference requires apiVersion, kind, and name or uid');
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
  if (!kind) throw new Error('query requires kind');
  return {
    apiVersion: optionalString(query.apiVersion),
    kind,
    namespace: optionalString(query.namespace),
    labels: stringRecord(query.labels),
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
    resourceVersion: optionalString(options.resourceVersion),
    propagationPolicy: validPropagationPolicy,
    dryRun: optionalBoolean(options.dryRun),
  };
}

export const orchestrationImpl: BuiltinToolImpl = async (arguments_, context) => {
  const client = context.orchestration;
  if (!client) return { error: 'Orchestration manager not configured.' };

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
      case 'delete':
        return await client.delete(referenceValue(arguments_.reference), deleteOptions(arguments_.options));
      default:
        return { error: 'orchestration requires a supported action' };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};
