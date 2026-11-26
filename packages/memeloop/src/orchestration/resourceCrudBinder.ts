import type { AgentOrchestrationClient, OrchestrationManifestMetadata, OrchestrationResourceManifest } from './client.js';
import { OrchestrationError } from './errors.js';

export interface ResourceCrudCreateMetadata {
  name?: string;
  generateName?: string;
  namespace?: string;
  ownerReferences?: OrchestrationManifestMetadata['ownerReferences'];
  idempotencyKey?: string;
}

export interface ResourceCrudDescriptor<
  CreateOptions extends ResourceCrudCreateMetadata,
  Resource extends {
    apiVersion: string;
    kind: string;
    metadata: { name: string };
  },
> {
  apiVersion: string;
  kind: string;
  fieldManager: string;
  label: string;
  buildManifest(
    options: CreateOptions,
    defaultNamespace: string | undefined,
  ): OrchestrationResourceManifest;
  isResource(value: unknown): value is Resource;
}

export function bindResourceCrud<
  CreateOptions extends ResourceCrudCreateMetadata,
  Resource extends {
    apiVersion: string;
    kind: string;
    metadata: { name: string };
  },
>(
  client: AgentOrchestrationClient,
  defaultNamespace: string | undefined,
  descriptor: ResourceCrudDescriptor<CreateOptions, Resource>,
): {
  create(options: CreateOptions): Promise<Resource>;
  get(name: string, namespace?: string): Promise<Resource | null>;
  delete(name: string, namespace?: string): Promise<void>;
} {
  return {
    async create(options: CreateOptions): Promise<Resource> {
      const result = await client.apply(descriptor.buildManifest(options, defaultNamespace), {
        idempotencyKey: options.idempotencyKey,
        fieldManager: descriptor.fieldManager,
      });
      if (!descriptor.isResource(result)) {
        throw new OrchestrationError({
          code: 'UNKNOWN_EFFECT',
          message: `apply returned a non-${descriptor.label} resource`,
          retryable: false,
        });
      }
      return result;
    },
    async get(name: string, namespace?: string): Promise<Resource | null> {
      const result = await client.get({
        apiVersion: descriptor.apiVersion,
        kind: descriptor.kind,
        name,
        namespace: namespace ?? defaultNamespace,
      });
      return result && descriptor.isResource(result) ? result : null;
    },
    async delete(name: string, namespace?: string): Promise<void> {
      await client.delete({
        apiVersion: descriptor.apiVersion,
        kind: descriptor.kind,
        name,
        namespace: namespace ?? defaultNamespace,
      });
    },
  };
}
