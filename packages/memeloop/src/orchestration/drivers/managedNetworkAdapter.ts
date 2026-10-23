import { OrchestrationError } from '../errors.js';
import type { NodeTrustClass } from '../resources.js';

import { assertDriverRequestEnvelope, canonicalDriverValue, type DriverRequestEnvelope } from './driverRequest.js';
import { canDriverSatisfyClass, type NetworkAttachRequest, type NetworkDriver, type NetworkEnforcementLevel } from './networkDriver.js';
import {
  assertNetworkPreparePayload,
  assertNetworkUpdatePayload,
  countManagedNetworkPolicyRules,
  type ManagedNetworkStatus,
  type NetworkManagementCapabilities,
  type NetworkManagementDriver,
  type NetworkPreparePayload,
} from './networkManagement.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const FEATURES = new Set([
  'dns',
  'proxy',
  'ingress',
  'egress',
  'bandwidth',
  'service-access',
]);
const ENFORCEMENT_RANK: Record<NetworkEnforcementLevel, number> = {
  none: 0,
  process: 1,
  namespace: 2,
  host: 3,
  external: 4,
};

interface NativeNetwork {
  nativeHandle: string;
  resourceUid: string;
  fencingEpoch: number;
  status: ManagedNetworkStatus;
  attachRequest: NetworkAttachRequest;
}

interface IdempotencyRecord {
  fingerprint: string;
  networkHandle: string;
}

export interface ResolvedManagedNetworkRequest {
  attachRequest: NetworkAttachRequest;
  /** Digest independently calculated from the current NetworkClass desired state. */
  networkClassDigest: string;
  /** Digest independently calculated from the effective policy passed to the native driver. */
  policyDigest: string;
}

export interface ManagedNetworkAdapterOptions {
  supportedTrustClasses: NodeTrustClass[];
  threatAssumptions: string[];
  maxPolicyRules: number;
  resolveAttachRequest(
    request: DriverRequestEnvelope<NetworkPreparePayload>,
  ): Promise<ResolvedManagedNetworkRequest>;
  verifyCapability(request: DriverRequestEnvelope): Promise<boolean> | boolean;
  now?: () => Date;
}

function failure(code: OrchestrationError['code'], message: string): never {
  throw new OrchestrationError({ code, message, retryable: false });
}

function requiredHandle(payload: unknown): string {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).some((field) => field !== 'networkHandle') ||
    typeof (payload as { networkHandle?: unknown }).networkHandle !== 'string' ||
    !(payload as { networkHandle: string }).networkHandle
  ) {
    failure('INVALID', 'network operation requires only an opaque networkHandle');
  }
  return (payload as { networkHandle: string }).networkHandle;
}

function idempotencyFingerprint(request: DriverRequestEnvelope): string {
  return canonicalDriverValue({
    capabilityHandleRef: request.capabilityHandleRef,
    session: request.session,
    run: request.run,
    payloadSchemaDigest: request.payloadSchemaDigest,
    payload: request.payload,
  });
}

/**
 * Wrap a host's narrow CNI-like driver in the complete managed protocol.
 *
 * The wrapper deliberately advertises process persistence: native handles and
 * capability/fencing state cannot be adopted after a host process restart.
 */
export function createManagedNetworkAdapter(
  nativeDriver: NetworkDriver,
  options: ManagedNetworkAdapterOptions,
): NetworkManagementDriver {
  if (
    options.supportedTrustClasses.length === 0 ||
    options.threatAssumptions.length === 0 ||
    !Number.isSafeInteger(options.maxPolicyRules) ||
    options.maxPolicyRules < 1
  ) {
    failure('INVALID', 'managed network adapter requires bounded trust, threat, and rule declarations');
  }

  const now = options.now ?? (() => new Date());
  const networks = new Map<string, NativeNetwork>();
  const fences = new Map<string, number>();
  const idempotency = new Map<string, IdempotencyRecord>();

  async function capabilities(): Promise<NetworkManagementCapabilities> {
    const actual = await nativeDriver.getCapabilities();
    if (
      !actual.name ||
      new Set(actual.enforcedFeatures).size !== actual.enforcedFeatures.length ||
      actual.enforcedFeatures.some((feature) => !FEATURES.has(feature)) ||
      !Object.hasOwn(ENFORCEMENT_RANK, actual.enforcementLevel)
    ) {
      failure('INVALID', 'native network driver capabilities are incomplete');
    }
    return {
      ...actual,
      supportedTrustClasses: [...options.supportedTrustClasses],
      supportsPolicyUpdate: false,
      supportsServiceResolution: true,
      persistence: 'process',
      maxPolicyRules: options.maxPolicyRules,
      threatAssumptions: [...options.threatAssumptions],
    };
  }

  async function validate<T>(
    request: DriverRequestEnvelope<T>,
    method: string,
  ): Promise<number> {
    assertDriverRequestEnvelope(request, {
      now,
      requireRun: true,
      requireFencing: true,
      requireCapability: true,
      expectedMethod: method,
    });
    if (request.actor.kind !== 'controller' && request.actor.kind !== 'admin') {
      failure('FORBIDDEN', 'network lifecycle requires a controller or admin actor');
    }
    if (!await options.verifyCapability(request)) {
      failure('FORBIDDEN', 'network capability is invalid for this host session');
    }
    const epoch = request.fencingEpoch as number;
    const current = fences.get(request.resource.uid) ?? 0;
    if (epoch < current) {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: `stale network fencing epoch ${epoch}; current epoch is ${current}`,
        retryable: false,
      });
    }
    fences.set(request.resource.uid, epoch);
    return epoch;
  }

  function scoped(handle: string, resourceUid: string): NativeNetwork {
    const network = networks.get(handle);
    if (!network) failure('NOT_FOUND', `network handle '${handle}' was not found`);
    if (network.resourceUid !== resourceUid) {
      failure('FORBIDDEN', `network handle '${handle}' belongs to another resource`);
    }
    return network;
  }

  function idempotencyKey(request: DriverRequestEnvelope, operation: string): string {
    return `${request.resource.uid}:${operation}:${request.idempotencyKey}`;
  }

  function replay(request: DriverRequestEnvelope, operation: string): NativeNetwork | undefined {
    const existing = idempotency.get(idempotencyKey(request, operation));
    if (!existing) return undefined;
    if (existing.fingerprint !== idempotencyFingerprint(request)) {
      failure('CONFLICT', `network ${operation} idempotency key was reused with different authority or input`);
    }
    return scoped(existing.networkHandle, request.resource.uid);
  }

  function remember(
    request: DriverRequestEnvelope,
    operation: string,
    networkHandle: string,
  ): void {
    idempotency.set(idempotencyKey(request, operation), {
      fingerprint: idempotencyFingerprint(request),
      networkHandle,
    });
  }

  return {
    getCapabilities: capabilities,

    async prepareNetwork(request) {
      const epoch = await validate(request, 'network.prepare');
      assertNetworkPreparePayload(request.payload);
      const existing = replay(request, 'prepare');
      if (existing) return structuredClone(existing.status);
      if (
        !SHA256.test(request.payload.networkClassDigest) ||
        !SHA256.test(request.payload.policy.digest)
      ) {
        failure('INVALID', 'network class and policy digests must be canonical sha256');
      }

      const declared = await capabilities();
      if (countManagedNetworkPolicyRules(request.payload.policy) > declared.maxPolicyRules) {
        failure('EXHAUSTED', 'network policy exceeds the native adapter rule limit');
      }
      if (!declared.supportedTrustClasses.includes(request.payload.trustClass)) {
        failure('FORBIDDEN', `network trust class '${request.payload.trustClass}' is unsupported`);
      }
      if (
        ENFORCEMENT_RANK[declared.enforcementLevel] <
          ENFORCEMENT_RANK[request.payload.minimumEnforcementLevel]
      ) {
        failure(
          'FORBIDDEN',
          `network enforcement '${declared.enforcementLevel}' is below '${request.payload.minimumEnforcementLevel}'`,
        );
      }
      const resolved = await options.resolveAttachRequest(request);
      const { attachment, networkClass } = resolved.attachRequest;
      if (
        attachment.metadata.uid !== request.resource.uid ||
        attachment.apiVersion !== request.resource.apiVersion ||
        attachment.kind !== request.resource.kind ||
        attachment.metadata.name !== request.resource.name ||
        attachment.metadata.generation !== request.resource.generation ||
        attachment.spec.runRef?.uid !== request.run?.uid ||
        networkClass.metadata.name !== request.payload.networkClass ||
        networkClass.spec.driver !== declared.name ||
        resolved.attachRequest.sandboxRef !== request.payload.sandboxHandle ||
        resolved.networkClassDigest !== request.payload.networkClassDigest ||
        resolved.policyDigest !== request.payload.policy.digest
      ) {
        failure('FORBIDDEN', 'resolved network desired state does not match the managed request');
      }
      const satisfaction = canDriverSatisfyClass(declared, networkClass);
      if (!satisfaction.satisfied) {
        failure('FORBIDDEN', satisfaction.reason ?? 'native network driver cannot satisfy NetworkClass');
      }
      const nativeStatus = await nativeDriver.prepare(resolved.attachRequest);
      if (nativeStatus.phase !== 'Attached' || !nativeStatus.handle) {
        throw new OrchestrationError({
          code: nativeStatus.error?.code ?? 'UNAVAILABLE',
          message: nativeStatus.error?.message ?? 'native network driver did not attach the sandbox',
          retryable: nativeStatus.error?.retryable ?? true,
        });
      }
      const requested = request.payload.requestedFeatures;
      const verified = requested.filter((feature) => declared.enforcedFeatures.includes(feature));
      const degraded = requested.filter((feature) => !declared.enforcedFeatures.includes(feature));
      if (
        degraded.length > 0 &&
        ENFORCEMENT_RANK[request.payload.minimumEnforcementLevel] >
          ENFORCEMENT_RANK.process
      ) {
        failure('FORBIDDEN', `native network driver cannot enforce: ${degraded.join(', ')}`);
      }
      const colliding = networks.get(nativeStatus.handle);
      if (colliding && colliding.resourceUid !== request.resource.uid) {
        failure('CONFLICT', 'native network driver reused a handle across resource scopes');
      }
      const status: ManagedNetworkStatus = {
        networkHandle: nativeStatus.handle,
        resourceUid: request.resource.uid,
        phase: 'Ready',
        enforcementLevel: declared.enforcementLevel,
        verifiedFeatures: verified,
        degradedFeatures: degraded,
        policyDigest: request.payload.policy.digest,
        fencingEpoch: epoch,
        updatedAt: now().toISOString(),
      };
      networks.set(nativeStatus.handle, {
        nativeHandle: nativeStatus.handle,
        resourceUid: request.resource.uid,
        fencingEpoch: epoch,
        status,
        attachRequest: resolved.attachRequest,
      });
      remember(request, 'prepare', nativeStatus.handle);
      return structuredClone(status);
    },

    async checkNetwork(request) {
      const epoch = await validate(request, 'network.check');
      const handle = requiredHandle(request.payload);
      const network = networks.get(handle);
      if (!network) return undefined;
      scoped(handle, request.resource.uid);
      const nativeStatus = await nativeDriver.check(network.nativeHandle);
      if (!nativeStatus || nativeStatus.phase === 'Detached') {
        networks.delete(handle);
        return undefined;
      }
      if (nativeStatus.phase === 'Failed') {
        throw new OrchestrationError({
          code: nativeStatus.error?.code ?? 'UNAVAILABLE',
          message: nativeStatus.error?.message ?? 'native network attachment failed',
          retryable: nativeStatus.error?.retryable ?? true,
        });
      }
      network.fencingEpoch = epoch;
      network.status = {
        ...network.status,
        fencingEpoch: epoch,
        updatedAt: now().toISOString(),
      };
      return structuredClone(network.status);
    },

    async resolveService(request) {
      await validate(request, 'network.resolve-service');
      if (
        request.payload === null ||
        typeof request.payload !== 'object' ||
        Array.isArray(request.payload) ||
        Object.keys(request.payload).some(
          (field) => field !== 'networkHandle' && field !== 'serviceName',
        )
      ) {
        failure('INVALID', 'network service resolution payload is invalid');
      }
      const { networkHandle, serviceName } = request.payload;
      if (typeof networkHandle !== 'string' || typeof serviceName !== 'string' || !serviceName) {
        failure('INVALID', 'network service resolution requires bounded handles and names');
      }
      const network = scoped(networkHandle, request.resource.uid);
      const endpoint = await nativeDriver.resolveService(serviceName, network.nativeHandle);
      if (!endpoint) failure('NOT_FOUND', `network service '${serviceName}' was not resolved`);
      return {
        networkHandle,
        resourceUid: request.resource.uid,
        serviceName,
        serviceHandle: endpoint,
        resolvedAt: now().toISOString(),
      };
    },

    async updatePolicy(request) {
      await validate(request, 'network.update-policy');
      assertNetworkUpdatePayload(request.payload);
      failure(
        'UNSUPPORTED',
        'process-local network adapter requires release and prepare for a changed NetworkClass',
      );
    },

    async releaseNetwork(request) {
      await validate(request, 'network.release');
      const handle = requiredHandle(request.payload);
      const network = networks.get(handle);
      if (!network) return;
      scoped(handle, request.resource.uid);
      await nativeDriver.release(network.nativeHandle);
      networks.delete(handle);
    },
  };
}
