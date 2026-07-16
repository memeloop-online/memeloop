import {
  canDriverSatisfyClass,
  type NetworkAttachmentStatus,
  type NetworkAttachRequest,
  type NetworkDriver,
  type NetworkDriverCapabilities,
  type NetworkDriverHealth,
} from 'memeloop';

/**
 * Process-level network driver (plan 24.39).
 *
 * Enforcement level: `process` — the driver injects proxy/service environment
 * variables into the workload's process environment. This affects cooperative
 * processes only; it provides NO protection from a hostile host or from a
 * workload that deliberately ignores its environment. The driver reports this
 * truthfully: `supportsRequiredEnforcement` is false and only the `proxy`
 * feature is claimed, so `enforcement: required` NetworkClasses are rejected
 * by validation instead of silently downgraded.
 */

export interface ProcessNetworkDriverOptions {
  /** Resolve a named service endpoint (e.g. `model-gateway` → `gateway://default`). */
  resolveService?: (name: string) => Promise<string | undefined>;
  /** Proxy endpoint used when a mandatory proxy class gives no explicit address. */
  defaultProxy?: string;
  now?: () => Date;
}

export const PROCESS_NETWORK_DRIVER_NAME = 'process-env';
export const MODEL_GATEWAY_SERVICE_NAME = 'model-gateway';
export const MODEL_GATEWAY_ENV = 'MEMELOOP_MODEL_GATEWAY';

interface ProcessNetworkAttachmentRecord {
  status: NetworkAttachmentStatus;
  environmentPatch: Record<string, string>;
}

export interface ProcessNetworkDriver extends NetworkDriver {
  /** Environment variables the runtime must inject for an attached sandbox. */
  getEnvironmentPatch(handle: string): Record<string, string> | undefined;
}

function serviceAccessRequested(networkClass: NetworkAttachRequest['networkClass']): boolean {
  const access = networkClass.spec.serviceAccess;
  return Boolean(access?.allowControlPlane || access?.allowClusterServices || access?.allowModelGateway);
}

export function createProcessNetworkDriver(options: ProcessNetworkDriverOptions = {}): ProcessNetworkDriver {
  const now = options.now ?? (() => new Date());
  const attachments = new Map<string, ProcessNetworkAttachmentRecord>();

  async function attach(request: NetworkAttachRequest): Promise<NetworkAttachmentStatus> {
    // sandboxRef is accepted by contract; the process driver does not need it
    // because it patches the environment rather than attaching a namespace.
    const { attachment, networkClass } = request;
    const base: NetworkAttachmentStatus = { phase: 'Pending' };

    const satisfaction = canDriverSatisfyClass(
      {
        name: PROCESS_NETWORK_DRIVER_NAME,
        enforcedFeatures: ['proxy'],
        supportsRequiredEnforcement: false,
      },
      networkClass,
    );

    if (!satisfaction.satisfied) {
      return {
        ...base,
        phase: 'Failed',
        error: { code: 'FORBIDDEN', message: satisfaction.reason ?? 'network class cannot be satisfied', retryable: false },
      };
    }

    const environmentPatch: Record<string, string> = {};
    const degraded = [...satisfaction.unsupportedFeatures];

    const proxy = networkClass.spec.proxy;
    if (proxy) {
      const address = proxy.httpsProxy ?? proxy.httpProxy ?? options.defaultProxy;
      if (!address && proxy.mandatory) {
        return {
          ...base,
          phase: 'Failed',
          error: {
            code: 'UNAVAILABLE',
            message: 'network class requires a mandatory proxy but no proxy endpoint is configured',
            retryable: true,
          },
        };
      }
      if (proxy.httpProxy) environmentPatch.HTTP_PROXY = proxy.httpProxy;
      if (proxy.httpsProxy) environmentPatch.HTTPS_PROXY = proxy.httpsProxy;
      if (!proxy.httpProxy && !proxy.httpsProxy && address) {
        // Class leaves the address to the driver default; prefer HTTPS.
        environmentPatch.HTTPS_PROXY = address;
      }
      if (proxy.noProxy && proxy.noProxy.length > 0) {
        environmentPatch.NO_PROXY = proxy.noProxy.join(',');
      }
      if (proxy.mandatory) {
        // Process-level enforcement cannot block a workload that ignores its
        // environment — mandatory proxy is honored for cooperative processes
        // only, so the bypass risk is always reported as degraded.
        degraded.push('proxy-bypass');
      }
    }

    if (serviceAccessRequested(networkClass) && networkClass.spec.serviceAccess?.allowModelGateway && options.resolveService) {
      const gateway = await options.resolveService(MODEL_GATEWAY_SERVICE_NAME);
      if (gateway) {
        environmentPatch[MODEL_GATEWAY_ENV] = gateway;
      }
    }

    const handle = `procnet:${attachment.metadata.name}:${now().getTime().toString(36)}`;
    const status: NetworkAttachmentStatus = {
      phase: 'Attached',
      handle,
      ...(degraded.length > 0 ? { degraded } : {}),
      attachedAt: now().toISOString(),
    };
    attachments.set(handle, { status, environmentPatch });
    return status;
  }

  async function detach(handle: string): Promise<void> {
    attachments.delete(handle);
  }

  return {
    async getCapabilities(): Promise<NetworkDriverCapabilities> {
      return {
        name: PROCESS_NETWORK_DRIVER_NAME,
        enforcedFeatures: ['proxy'],
        supportsRequiredEnforcement: false,
      };
    },
    attach,
    detach,
    async getHealth(): Promise<NetworkDriverHealth> {
      return {
        healthy: true,
        detail: 'process-level enforcement only (cooperative processes; no protection from a hostile host)',
        checkedAt: now().toISOString(),
      };
    },
    getEnvironmentPatch(handle: string) {
      return attachments.get(handle)?.environmentPatch;
    },
  };
}
