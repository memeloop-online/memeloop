import type { NetworkAttachmentResource, NetworkAttachmentStatus, NetworkClassResource } from './resources.js';

/**
 * NetworkDriver: the CNI-like contract between the runtime and node network
 * implementations (process env, proxy, netns, firewall, eBPF, ...). Drivers
 * declare what they can enforce; the control plane validates a NetworkClass
 * against driver capabilities before scheduling, and never starts a workload
 * whose `enforcement: required` class cannot be fully enforced.
 */

export type NetworkEnforceableFeature = 'dns' | 'proxy' | 'ingress' | 'egress' | 'bandwidth' | 'service-access';
export type NetworkEnforcementLevel = 'none' | 'process' | 'namespace' | 'host' | 'external';

export interface NetworkDriverCapabilities {
  /** Driver name referenced by NetworkClass.spec.driver. */
  name: string;
  /** Features this driver can enforce. */
  enforcedFeatures: NetworkEnforceableFeature[];
  /** Strongest isolation boundary the driver actually controls. */
  enforcementLevel: NetworkEnforcementLevel;
}

export interface NetworkAttachRequest {
  attachment: NetworkAttachmentResource;
  networkClass: NetworkClassResource;
  /** Opaque sandbox handle (process, container, namespace) to attach. */
  sandboxRef: string;
}

export interface NetworkDriverHealth {
  healthy: boolean;
  detail?: string;
  checkedAt: string;
}

export interface NetworkDriver {
  getCapabilities(): Promise<NetworkDriverCapabilities>;
  /**
   * Attach a workload sandbox to the network described by its class. On
   * success the status carries an opaque `handle` consumers must not parse;
   * degraded features (best-effort classes only) are listed in `degraded`.
   */
  prepare(request: NetworkAttachRequest): Promise<NetworkAttachmentStatus>;
  check(handle: string): Promise<NetworkAttachmentStatus | null>;
  update(handle: string, request: NetworkAttachRequest): Promise<NetworkAttachmentStatus>;
  resolveService(name: string, handle?: string): Promise<string | undefined>;
  release(handle: string): Promise<void>;
  getHealth(): Promise<NetworkDriverHealth>;
}

export interface NetworkClassSatisfaction {
  satisfied: boolean;
  /** Features present in the class that the driver cannot enforce. */
  unsupportedFeatures: NetworkEnforceableFeature[];
  reason?: string;
}

/** Features configured by the class that require driver enforcement. */
export function featuresRequiredByClass(networkClass: NetworkClassResource): NetworkEnforceableFeature[] {
  const spec = networkClass.spec;
  const features: NetworkEnforceableFeature[] = [];
  if (spec.dns && spec.dns.policy !== 'default') features.push('dns');
  if (spec.proxy) features.push('proxy');
  if (spec.ingress && (spec.ingress.defaultAction !== undefined || (spec.ingress.allow?.length ?? 0) > 0)) {
    features.push('ingress');
  }
  if (spec.egress) features.push('egress');
  if (spec.bandwidth) features.push('bandwidth');
  if (spec.serviceAccess) features.push('service-access');
  return features;
}

/**
 * Validate that a driver can satisfy a NetworkClass. For
 * `enforcement: required` every configured feature must be enforceable and
 * the driver must support required enforcement; for `best-effort` the check
 * reports which features would degrade instead of failing.
 */
export function canDriverSatisfyClass(
  capabilities: NetworkDriverCapabilities,
  networkClass: NetworkClassResource,
): NetworkClassSatisfaction {
  const required = featuresRequiredByClass(networkClass);
  const unsupported = required.filter((feature) => !capabilities.enforcedFeatures.includes(feature));

  if (networkClass.spec.enforcement === 'required') {
    if (capabilities.enforcementLevel === 'none' || capabilities.enforcementLevel === 'process') {
      return {
        satisfied: false,
        unsupportedFeatures: unsupported,
        reason: `driver '${capabilities.name}' enforcement level '${capabilities.enforcementLevel}' cannot provide required isolation`,
      };
    }
    if (unsupported.length > 0) {
      return {
        satisfied: false,
        unsupportedFeatures: unsupported,
        reason: `driver '${capabilities.name}' cannot enforce required features: ${unsupported.join(', ')}`,
      };
    }
    return { satisfied: true, unsupportedFeatures: [] };
  }

  return {
    satisfied: true,
    unsupportedFeatures: unsupported,
    ...(unsupported.length > 0
      ? { reason: `features degrade under best-effort: ${unsupported.join(', ')}` }
      : {}),
  };
}
