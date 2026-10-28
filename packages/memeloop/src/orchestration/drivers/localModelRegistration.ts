import {
  createModelClassManifest,
  createModelEndpointManifest,
  MODEL_CLASS_API_VERSION,
  MODEL_CLASS_KIND,
  type ModelClassManifest,
  type ModelEndpointManifest,
} from '../resources.js';
import { modelClassNameForSpec, type ModelProviderDriver, type ModelProviderHealth } from './modelProviderDriver.js';

/**
 * Local model endpoint registration (plan 24.36).
 *
 * A worker advertises the models its ModelProviderDriver can serve as
 * ModelClass + ModelEndpoint manifests. Advertisement carries digest, health,
 * capacity, modalities, data policy, and node trust so the scheduler can
 * place model calls without contacting the node. Local model output is data
 * only — it can never authorize tool admission, which is host-bound.
 */

export interface LocalModelAdvertisementOptions {
  nodeId: string;
  trust: 'trusted' | 'restricted' | 'quarantine';
  /** Prefix for opaque endpoint handles (default `local://<nodeId>`). */
  endpointPrefix?: string;
  capacity?: {
    maxConcurrent?: number;
    tokensPerMinute?: number;
  };
  dataPolicy?: {
    classification?: string;
    retention?: string;
  };
}

export interface LocalModelAdvertisement {
  modelClasses: ModelClassManifest[];
  endpoints: ModelEndpointManifest[];
  health: ModelProviderHealth;
}

function sanitizeModelName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
}

/**
 * Build declarative manifests for every model the driver serves. Endpoint
 * handles are opaque (`<prefix>/<provider>/<model>`) and never embed
 * credentials or URLs.
 */
export async function describeLocalModelEndpoints(
  driver: ModelProviderDriver,
  options: LocalModelAdvertisementOptions,
): Promise<LocalModelAdvertisement> {
  const [models, health] = await Promise.all([driver.listModels(), driver.getHealth()]);
  const prefix = options.endpointPrefix ?? `local://${options.nodeId}`;

  const modelClasses: ModelClassManifest[] = [];
  const endpoints: ModelEndpointManifest[] = [];

  for (const model of models) {
    const baseName = modelClassNameForSpec(model);
    modelClasses.push(createModelClassManifest(baseName, model));
    endpoints.push(createModelEndpointManifest(`${baseName}-${sanitizeModelName(options.nodeId)}`, {
      modelClassRef: { apiVersion: MODEL_CLASS_API_VERSION, kind: MODEL_CLASS_KIND, name: baseName },
      ...(model.digest ? { modelDigest: model.digest } : {}),
      nodeId: options.nodeId,
      trust: options.trust,
      endpoint: `${prefix}/${model.provider}/${model.model}`,
      ...(options.capacity ? { capacity: options.capacity } : {}),
      ...(options.dataPolicy ? { dataPolicy: options.dataPolicy } : {}),
    }));
  }

  return { modelClasses, endpoints, health };
}

export type ModelEndpointTrust = 'trusted' | 'restricted' | 'quarantine';

const TRUST_RANK: Record<ModelEndpointTrust, number> = {
  quarantine: 0,
  restricted: 1,
  trusted: 2,
};

export interface ModelSelectionRequirements {
  /** Required ModelClass name. */
  modelClassName: string;
  /** Required model digest; endpoints with a mismatching digest are excluded. */
  modelDigest?: string;
  /** Minimum acceptable node trust (default `quarantine` — any node qualifies). */
  minimumTrust?: ModelEndpointTrust;
  /** Exclude endpoints whose status reports unhealthy (default true). */
  requireHealthy?: boolean;
  /** Required spare concurrency. */
  minConcurrent?: number;
}

export interface SelectableModelEndpoint {
  manifest: ModelEndpointManifest;
  status?: {
    healthy?: boolean;
  };
}

/**
 * Pick the best endpoint for a model call: filters by class name, digest,
 * trust, health, and capacity, then prefers the highest-capacity endpoint.
 * Returns null when nothing qualifies — the caller must surface a scheduling
 * failure rather than silently falling back to an unvetted endpoint.
 */
export function selectModelEndpoint(
  endpoints: SelectableModelEndpoint[],
  requirements: ModelSelectionRequirements,
): ModelEndpointManifest | null {
  const minimumTrustRank = TRUST_RANK[requirements.minimumTrust ?? 'quarantine'];
  const requireHealthy = requirements.requireHealthy ?? true;

  const candidates = endpoints.filter(({ manifest, status }) => {
    if (manifest.spec.modelClassRef.name !== requirements.modelClassName) return false;
    if (requirements.modelDigest && manifest.spec.modelDigest !== requirements.modelDigest) return false;
    const trustRank = TRUST_RANK[manifest.spec.trust ?? 'quarantine'];
    if (trustRank < minimumTrustRank) return false;
    if (requireHealthy && status?.healthy === false) return false;
    if (requirements.minConcurrent !== undefined) {
      const capacity = manifest.spec.capacity?.maxConcurrent ?? 0;
      if (capacity < requirements.minConcurrent) return false;
    }
    return true;
  });

  candidates.sort((a, b) => (b.manifest.spec.capacity?.maxConcurrent ?? 0) - (a.manifest.spec.capacity?.maxConcurrent ?? 0));

  return candidates[0]?.manifest ?? null;
}
