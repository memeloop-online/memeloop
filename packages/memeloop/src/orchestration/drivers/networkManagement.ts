import { OrchestrationError } from '../errors.js';
import type { NodeTrustClass } from '../resources.js';

import type { DriverConformanceSuite } from './driverConformance.js';
import { canonicalDriverValue, type DriverRequestEnvelope } from './driverRequest.js';
import { assertFencedDriverRequestEnvelope } from './driverState.js';
import type { NetworkEnforceableFeature, NetworkEnforcementLevel } from './networkDriver.js';

const ENFORCEMENT_RANK: Record<NetworkEnforcementLevel, number> = {
  none: 0,
  process: 1,
  namespace: 2,
  host: 3,
  external: 4,
};
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const FEATURES: NetworkEnforceableFeature[] = [
  'dns',
  'proxy',
  'ingress',
  'egress',
  'bandwidth',
  'service-access',
];

export interface NetworkManagementCapabilities {
  name: string;
  enforcedFeatures: NetworkEnforceableFeature[];
  enforcementLevel: NetworkEnforcementLevel;
  supportedTrustClasses: NodeTrustClass[];
  supportsPolicyUpdate: boolean;
  supportsServiceResolution: boolean;
  persistence: 'process' | 'host' | 'external';
  maxPolicyRules: number;
  threatAssumptions: string[];
}

export interface ManagedNetworkPolicy {
  digest: string;
  dns?: {
    policy: 'default' | 'custom' | 'none';
    servers?: string[];
  };
  proxy?: {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string[];
    mandatory?: boolean;
  };
  ingress?: {
    defaultAction: 'allow' | 'deny';
    rules?: Array<{ target: string; ports?: number[]; protocol?: string; action?: 'allow' | 'deny' }>;
  };
  egress?: {
    defaultAction: 'allow' | 'deny';
    rules?: Array<{ target: string; ports?: number[]; protocol?: string; action?: 'allow' | 'deny' }>;
  };
  bandwidth?: {
    ingressKbps?: number;
    egressKbps?: number;
  };
  serviceAllowlist?: string[];
  dataClassification?: 'public' | 'internal' | 'confidential' | 'restricted';
}

export interface NetworkPreparePayload {
  sandboxHandle: string;
  networkClass: string;
  networkClassDigest: string;
  requestedFeatures: NetworkEnforceableFeature[];
  minimumEnforcementLevel: NetworkEnforcementLevel;
  trustClass: NodeTrustClass;
  policy: ManagedNetworkPolicy;
}

export interface ManagedNetworkStatus {
  networkHandle: string;
  resourceUid: string;
  phase: 'Ready' | 'Released';
  enforcementLevel: NetworkEnforcementLevel;
  verifiedFeatures: NetworkEnforceableFeature[];
  degradedFeatures: NetworkEnforceableFeature[];
  policyDigest: string;
  fencingEpoch: number;
  updatedAt: string;
}

export interface ManagedServiceResolution {
  networkHandle: string;
  resourceUid: string;
  serviceName: string;
  serviceHandle: string;
  resolvedAt: string;
}

/** Complete §10.5 managed CNI-like surface. */
export interface NetworkManagementDriver {
  getCapabilities(): Promise<NetworkManagementCapabilities>;
  prepareNetwork(
    request: DriverRequestEnvelope<NetworkPreparePayload>,
  ): Promise<ManagedNetworkStatus>;
  checkNetwork(
    request: DriverRequestEnvelope<{ networkHandle: string }>,
  ): Promise<ManagedNetworkStatus | undefined>;
  resolveService(
    request: DriverRequestEnvelope<{
      networkHandle: string;
      serviceName: string;
    }>,
  ): Promise<ManagedServiceResolution>;
  updatePolicy(
    request: DriverRequestEnvelope<{
      networkHandle: string;
      requestedFeatures: NetworkEnforceableFeature[];
      minimumEnforcementLevel: NetworkEnforcementLevel;
      policy: ManagedNetworkPolicy;
    }>,
  ): Promise<ManagedNetworkStatus>;
  releaseNetwork(
    request: DriverRequestEnvelope<{ networkHandle: string }>,
  ): Promise<void>;
}

interface IdempotencyRecord {
  fingerprint: string;
  resultHandle: string;
}

export interface FakeNetworkManagementState {
  networks: Map<string, ManagedNetworkStatus>;
  services: Map<string, ManagedServiceResolution>;
  idempotency: Map<string, IdempotencyRecord>;
  fences: Map<string, number>;
  nextHandle: number;
}

export function createFakeNetworkManagementState(): FakeNetworkManagementState {
  return {
    networks: new Map(),
    services: new Map(),
    idempotency: new Map(),
    fences: new Map(),
    nextHandle: 1,
  };
}

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`network ${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyFields(
  value: unknown,
  allowed: readonly string[],
  location: string,
): Record<string, unknown> {
  const candidate = record(value, location);
  const fields = Object.keys(candidate).filter((field) => !allowed.includes(field));
  if (fields.length > 0) {
    invalid(`network ${location} contains unsupported fields: ${fields.join(', ')}`);
  }
  return candidate;
}

function requiredString(payload: unknown, field: string): string {
  const value = payload !== null && typeof payload === 'object'
    ? (payload as Record<string, unknown>)[field]
    : undefined;
  if (typeof value !== 'string' || !value || value.length > 2048) {
    invalid(`network payload '${field}' is required and must be bounded`);
  }
  return value;
}

export function countManagedNetworkPolicyRules(policy: ManagedNetworkPolicy): number {
  return (policy.ingress?.rules?.length ?? 0) +
    (policy.egress?.rules?.length ?? 0) +
    (policy.serviceAllowlist?.length ?? 0);
}

function validateRules(value: unknown, location: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 1024) {
    invalid(`network ${location} must be a bounded array`);
  }
  for (const [index, rule] of value.entries()) {
    const candidate = onlyFields(
      rule,
      ['target', 'ports', 'protocol', 'action'],
      `${location}[${index}]`,
    );
    requiredString(candidate, 'target');
    if (
      candidate.ports !== undefined &&
      (
        !Array.isArray(candidate.ports) ||
        candidate.ports.length > 256 ||
        candidate.ports.some(
          (port) => !Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535,
        )
      )
    ) {
      invalid(`network ${location}[${index}].ports must contain valid ports`);
    }
    if (
      candidate.protocol !== undefined &&
      !['tcp', 'udp', 'http', 'https', 'any'].includes(candidate.protocol as string)
    ) {
      invalid(`network ${location}[${index}].protocol is unsupported`);
    }
    if (
      candidate.action !== undefined &&
      candidate.action !== 'allow' &&
      candidate.action !== 'deny'
    ) {
      invalid(`network ${location}[${index}].action is unsupported`);
    }
  }
}

function boundedStrings(value: unknown, location: string): void {
  if (
    !Array.isArray(value) ||
    value.length > 1024 ||
    value.some((item) => typeof item !== 'string' || !item || item.length > 2048)
  ) {
    invalid(`network ${location} must be a bounded string array`);
  }
}

export function assertManagedNetworkPolicy(value: unknown): asserts value is ManagedNetworkPolicy {
  const policy = onlyFields(value, [
    'digest',
    'dns',
    'proxy',
    'ingress',
    'egress',
    'bandwidth',
    'serviceAllowlist',
    'dataClassification',
  ], 'policy');
  if (typeof policy.digest !== 'string' || !SHA256.test(policy.digest)) {
    invalid('network policy digest must be canonical sha256');
  }
  if (policy.dns !== undefined) {
    const dns = onlyFields(policy.dns, ['policy', 'servers'], 'policy.dns');
    if (!['default', 'custom', 'none'].includes(dns.policy as string)) {
      invalid('network policy.dns.policy is unsupported');
    }
    if (dns.servers !== undefined) boundedStrings(dns.servers, 'policy.dns.servers');
  }
  if (policy.proxy !== undefined) {
    const proxy = onlyFields(
      policy.proxy,
      ['httpProxy', 'httpsProxy', 'noProxy', 'mandatory'],
      'policy.proxy',
    );
    for (const field of ['httpProxy', 'httpsProxy'] as const) {
      if (
        proxy[field] !== undefined &&
        (typeof proxy[field] !== 'string' || !proxy[field] || proxy[field].length > 2048)
      ) {
        invalid(`network policy.proxy.${field} must be a bounded endpoint`);
      }
    }
    if (proxy.noProxy !== undefined) boundedStrings(proxy.noProxy, 'policy.proxy.noProxy');
    if (proxy.mandatory !== undefined && typeof proxy.mandatory !== 'boolean') {
      invalid('network policy.proxy.mandatory must be boolean');
    }
  }
  for (const direction of ['ingress', 'egress'] as const) {
    if (policy[direction] === undefined) continue;
    const section = onlyFields(
      policy[direction],
      ['defaultAction', 'rules'],
      `policy.${direction}`,
    );
    if (section.defaultAction !== 'allow' && section.defaultAction !== 'deny') {
      invalid(`network policy.${direction}.defaultAction is unsupported`);
    }
    validateRules(section.rules, `policy.${direction}.rules`);
  }
  if (policy.bandwidth !== undefined) {
    const bandwidth = onlyFields(
      policy.bandwidth,
      ['ingressKbps', 'egressKbps'],
      'policy.bandwidth',
    );
    for (const field of ['ingressKbps', 'egressKbps'] as const) {
      if (
        bandwidth[field] !== undefined &&
        (!Number.isSafeInteger(bandwidth[field]) || (bandwidth[field] as number) < 1)
      ) {
        invalid(`network policy.bandwidth.${field} must be a positive safe integer`);
      }
    }
  }
  if (policy.serviceAllowlist !== undefined) {
    boundedStrings(policy.serviceAllowlist, 'policy.serviceAllowlist');
  }
  if (
    policy.dataClassification !== undefined &&
    !['public', 'internal', 'confidential', 'restricted'].includes(
      policy.dataClassification as string,
    )
  ) {
    invalid('network policy.dataClassification is unsupported');
  }
}

/** Fail closed on payload extensions so older drivers cannot ignore new policy fields. */
export function assertNetworkPreparePayload(value: unknown): asserts value is NetworkPreparePayload {
  const payload = onlyFields(value, [
    'sandboxHandle',
    'networkClass',
    'networkClassDigest',
    'requestedFeatures',
    'minimumEnforcementLevel',
    'trustClass',
    'policy',
  ], 'prepare payload');
  requiredString(payload, 'sandboxHandle');
  requiredString(payload, 'networkClass');
  if (
    typeof payload.networkClassDigest !== 'string' ||
    !SHA256.test(payload.networkClassDigest)
  ) {
    invalid('network class digest must be canonical sha256');
  }
  if (
    !Array.isArray(payload.requestedFeatures) ||
    payload.requestedFeatures.length > FEATURES.length ||
    new Set(payload.requestedFeatures).size !== payload.requestedFeatures.length ||
    payload.requestedFeatures.some((feature) => !FEATURES.includes(feature as NetworkEnforceableFeature))
  ) {
    invalid('network requestedFeatures must be a unique supported feature array');
  }
  if (
    typeof payload.minimumEnforcementLevel !== 'string' ||
    !Object.hasOwn(ENFORCEMENT_RANK, payload.minimumEnforcementLevel)
  ) {
    invalid('network minimumEnforcementLevel is unsupported');
  }
  if (!['trusted', 'restricted', 'quarantine'].includes(payload.trustClass as string)) {
    invalid('network trustClass is unsupported');
  }
  assertManagedNetworkPolicy(payload.policy);
}

function assertHandlePayload(
  value: unknown,
  allowed: readonly string[] = ['networkHandle'],
): void {
  const payload = onlyFields(value, allowed, 'operation payload');
  requiredString(payload, 'networkHandle');
}

export function assertNetworkUpdatePayload(value: unknown): void {
  const payload = onlyFields(value, [
    'networkHandle',
    'requestedFeatures',
    'minimumEnforcementLevel',
    'policy',
  ], 'update payload');
  requiredString(payload, 'networkHandle');
  assertNetworkPreparePayload({
    sandboxHandle: 'validation-only',
    networkClass: 'validation-only',
    networkClassDigest: `sha256:${'0'.repeat(64)}`,
    requestedFeatures: payload.requestedFeatures,
    minimumEnforcementLevel: payload.minimumEnforcementLevel,
    trustClass: 'trusted',
    policy: payload.policy,
  });
}

export function createFakeNetworkManagementDriver(options: {
  state?: FakeNetworkManagementState;
  now?: () => Date;
  capabilities?: Partial<NetworkManagementCapabilities>;
} = {}): NetworkManagementDriver {
  const state = options.state ?? createFakeNetworkManagementState();
  const now = options.now ?? (() => new Date());
  const capabilities: NetworkManagementCapabilities = {
    name: 'fake-managed-network',
    enforcedFeatures: [
      'dns',
      'proxy',
      'ingress',
      'egress',
      'bandwidth',
      'service-access',
    ],
    enforcementLevel: 'external',
    supportedTrustClasses: ['trusted', 'restricted', 'quarantine'],
    supportsPolicyUpdate: true,
    supportsServiceResolution: true,
    persistence: 'external',
    maxPolicyRules: 64,
    threatAssumptions: [
      'the external enforcement plane and durable state are trusted',
    ],
    ...options.capabilities,
  };

  function validate<T>(
    request: DriverRequestEnvelope<T>,
    method: string,
  ): number {
    return assertFencedDriverRequestEnvelope(request, {
      now,
      fences: state.fences,
      requireRun: true,
      expectedMethod: method,
      fenceName: 'network',
      actorKinds: ['controller', 'admin'],
      forbiddenMessage: () => 'network lifecycle requires a controller or admin actor',
    });
  }

  function nextHandle(prefix: string): string {
    const handle = `${prefix}:${state.nextHandle}`;
    state.nextHandle += 1;
    return handle;
  }

  function getNetwork(
    handle: string,
    resourceUid: string,
  ): ManagedNetworkStatus {
    const network = state.networks.get(handle);
    if (!network) {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `network handle '${handle}' was not found`,
        retryable: false,
      });
    }
    if (network.resourceUid !== resourceUid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `network handle '${handle}' belongs to another resource`,
        retryable: false,
      });
    }
    return network;
  }

  function validatePolicy(
    requestedFeatures: NetworkEnforceableFeature[],
    minimum: NetworkEnforcementLevel,
    policy: ManagedNetworkPolicy,
    trustClass?: NodeTrustClass,
  ): { verified: NetworkEnforceableFeature[]; degraded: NetworkEnforceableFeature[] } {
    if (!SHA256.test(policy.digest)) invalid('network policy digest must be canonical sha256');
    if (!Array.isArray(requestedFeatures) || new Set(requestedFeatures).size !== requestedFeatures.length) {
      invalid('network requestedFeatures must be a unique array');
    }
    if (countManagedNetworkPolicyRules(policy) > capabilities.maxPolicyRules) {
      throw new OrchestrationError({
        code: 'EXHAUSTED',
        message: 'network policy exceeds the driver rule limit',
        retryable: false,
      });
    }
    if (
      ENFORCEMENT_RANK[capabilities.enforcementLevel] <
        ENFORCEMENT_RANK[minimum]
    ) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `driver enforcement '${capabilities.enforcementLevel}' is below required '${minimum}'`,
        retryable: false,
      });
    }
    if (
      trustClass !== undefined &&
      !capabilities.supportedTrustClasses.includes(trustClass)
    ) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `network driver does not support trust class '${trustClass}'`,
        retryable: false,
      });
    }
    const verified = requestedFeatures.filter((feature) => capabilities.enforcedFeatures.includes(feature));
    const degraded = requestedFeatures.filter((feature) => !capabilities.enforcedFeatures.includes(feature));
    if (degraded.length > 0 && minimum !== 'none' && minimum !== 'process') {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `network driver cannot enforce: ${degraded.join(', ')}`,
        retryable: false,
      });
    }
    return { verified, degraded };
  }

  function idempotent(
    request: DriverRequestEnvelope,
    operation: string,
  ): string | undefined {
    const key = `${request.resource.uid}:${operation}:${request.idempotencyKey}`;
    const fingerprint = canonicalDriverValue(request.payload);
    const existing = state.idempotency.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: `network ${operation} idempotency key was reused with different input`,
          retryable: false,
        });
      }
      return existing.resultHandle;
    }
    return undefined;
  }

  function remember(
    request: DriverRequestEnvelope,
    operation: string,
    resultHandle: string,
  ): void {
    state.idempotency.set(
      `${request.resource.uid}:${operation}:${request.idempotencyKey}`,
      { fingerprint: canonicalDriverValue(request.payload), resultHandle },
    );
  }

  return {
    async getCapabilities() {
      return structuredClone(capabilities);
    },
    async prepareNetwork(request) {
      const fence = validate(request, 'network.prepare');
      assertNetworkPreparePayload(request.payload);
      const replay = idempotent(request, 'prepare');
      if (replay) return structuredClone(getNetwork(replay, request.resource.uid));
      requiredString(request.payload, 'sandboxHandle');
      requiredString(request.payload, 'networkClass');
      if (!SHA256.test(request.payload.networkClassDigest)) {
        invalid('network class digest must be canonical sha256');
      }
      const checked = validatePolicy(
        request.payload.requestedFeatures,
        request.payload.minimumEnforcementLevel,
        request.payload.policy,
        request.payload.trustClass,
      );
      const network: ManagedNetworkStatus = {
        networkHandle: nextHandle('network'),
        resourceUid: request.resource.uid,
        phase: 'Ready',
        enforcementLevel: capabilities.enforcementLevel,
        verifiedFeatures: checked.verified,
        degradedFeatures: checked.degraded,
        policyDigest: request.payload.policy.digest,
        fencingEpoch: fence,
        updatedAt: now().toISOString(),
      };
      state.networks.set(network.networkHandle, network);
      remember(request, 'prepare', network.networkHandle);
      return structuredClone(network);
    },
    async checkNetwork(request) {
      const fence = validate(request, 'network.check');
      assertHandlePayload(request.payload);
      const handle = requiredString(request.payload, 'networkHandle');
      const network = state.networks.get(handle);
      if (!network) return undefined;
      const current = getNetwork(handle, request.resource.uid);
      const updated = { ...current, fencingEpoch: fence, updatedAt: now().toISOString() };
      state.networks.set(handle, updated);
      return structuredClone(updated);
    },
    async resolveService(request) {
      validate(request, 'network.resolve-service');
      assertHandlePayload(request.payload, ['networkHandle', 'serviceName']);
      if (!capabilities.supportsServiceResolution) {
        throw new OrchestrationError({
          code: 'UNSUPPORTED',
          message: 'network service resolution is unsupported',
          retryable: false,
        });
      }
      const handle = requiredString(request.payload, 'networkHandle');
      getNetwork(handle, request.resource.uid);
      const serviceName = requiredString(request.payload, 'serviceName');
      const replay = idempotent(request, 'resolve-service');
      if (replay) {
        return structuredClone(state.services.get(replay) as ManagedServiceResolution);
      }
      const resolution: ManagedServiceResolution = {
        networkHandle: handle,
        resourceUid: request.resource.uid,
        serviceName,
        serviceHandle: nextHandle('network-service'),
        resolvedAt: now().toISOString(),
      };
      state.services.set(resolution.serviceHandle, resolution);
      remember(request, 'resolve-service', resolution.serviceHandle);
      return structuredClone(resolution);
    },
    async updatePolicy(request) {
      const fence = validate(request, 'network.update-policy');
      assertNetworkUpdatePayload(request.payload);
      if (!capabilities.supportsPolicyUpdate) {
        throw new OrchestrationError({
          code: 'UNSUPPORTED',
          message: 'network policy update is unsupported',
          retryable: false,
        });
      }
      const handle = requiredString(request.payload, 'networkHandle');
      const current = getNetwork(handle, request.resource.uid);
      const replay = idempotent(request, 'update-policy');
      if (replay) return structuredClone(getNetwork(replay, request.resource.uid));
      const checked = validatePolicy(
        request.payload.requestedFeatures,
        request.payload.minimumEnforcementLevel,
        request.payload.policy,
      );
      const updated: ManagedNetworkStatus = {
        ...current,
        verifiedFeatures: checked.verified,
        degradedFeatures: checked.degraded,
        policyDigest: request.payload.policy.digest,
        fencingEpoch: fence,
        updatedAt: now().toISOString(),
      };
      state.networks.set(handle, updated);
      remember(request, 'update-policy', handle);
      return structuredClone(updated);
    },
    async releaseNetwork(request) {
      validate(request, 'network.release');
      assertHandlePayload(request.payload);
      const handle = requiredString(request.payload, 'networkHandle');
      const current = state.networks.get(handle);
      if (!current) return;
      getNetwork(handle, request.resource.uid);
      state.networks.delete(handle);
      for (const [serviceHandle, service] of state.services) {
        if (service.networkHandle === handle) state.services.delete(serviceHandle);
      }
    },
  };
}

export function createNetworkManagementConformanceSuite(options: {
  createRequest<T>(
    method: string,
    payload: T,
    idempotencyKey: string,
    fencingEpoch?: number,
    resourceUid?: string,
  ): DriverRequestEnvelope<T>;
  recreate(driver: NetworkManagementDriver): NetworkManagementDriver;
}): DriverConformanceSuite {
  const policy = (character: string): ManagedNetworkPolicy => ({
    digest: `sha256:${character.repeat(64)}`,
    egress: {
      defaultAction: 'deny',
      rules: [{ target: 'model-gateway', ports: [443], protocol: 'https' }],
    },
    serviceAllowlist: ['model-gateway'],
    dataClassification: 'confidential',
  });
  const prepare = (key: string, fence = 4, resourceUid?: string) =>
    options.createRequest(
      'network.prepare',
      {
        sandboxHandle: 'opaque-sandbox',
        networkClass: 'external-restricted',
        networkClassDigest: `sha256:${'a'.repeat(64)}`,
        requestedFeatures: ['egress', 'service-access'] as NetworkEnforceableFeature[],
        minimumEnforcementLevel: 'external' as const,
        trustClass: 'quarantine' as const,
        policy: policy('b'),
      },
      key,
      fence,
      resourceUid,
    );

  return {
    interfaceKind: 'network',
    tests: [
      {
        name: 'declares enforceable capabilities and threat assumptions',
        description: 'Capabilities state real enforcement, trust, persistence, and limits',
        run: async (value) => {
          const capabilities = await (value as NetworkManagementDriver).getCapabilities();
          if (!capabilities.name || !capabilities.enforcedFeatures.length) {
            throw new Error('network capabilities are incomplete');
          }
          if (!capabilities.supportedTrustClasses.length || !capabilities.threatAssumptions.length) {
            throw new Error('network trust/threat declarations are incomplete');
          }
          if (capabilities.maxPolicyRules < 1) throw new Error('network rule limit is invalid');
        },
      },
      {
        name: 'prepares idempotently and binds exact policy input',
        description: 'Prepare verifies enforcement and rejects idempotency drift',
        run: async (value) => {
          const driver = value as NetworkManagementDriver;
          const request = prepare('prepare-same');
          const first = await driver.prepareNetwork(request);
          const second = await driver.prepareNetwork(request);
          if (first.networkHandle !== second.networkHandle) {
            throw new Error('network prepare is not idempotent');
          }
          let driftRejected = false;
          try {
            await driver.prepareNetwork({
              ...request,
              payload: { ...request.payload, policy: policy('c') },
            });
          } catch (error) {
            driftRejected = error instanceof OrchestrationError && error.code === 'CONFLICT';
          }
          if (!driftRejected) throw new Error('network prepare accepted idempotency drift');
          if (first.enforcementLevel !== 'external' || first.degradedFeatures.length) {
            throw new Error('network prepare made a false/degraded enforcement claim');
          }
        },
      },
      {
        name: 'checks, updates, resolves, and releases complete lifecycle',
        description: 'Managed policy and service handles converge through cleanup',
        run: async (value) => {
          const driver = value as NetworkManagementDriver;
          const network = await driver.prepareNetwork(prepare('lifecycle'));
          const checked = await driver.checkNetwork(options.createRequest(
            'network.check',
            { networkHandle: network.networkHandle },
            'check',
            4,
          ));
          if (checked?.phase !== 'Ready') throw new Error('network check lost Ready state');
          const updated = await driver.updatePolicy(options.createRequest(
            'network.update-policy',
            {
              networkHandle: network.networkHandle,
              requestedFeatures: ['egress'] as NetworkEnforceableFeature[],
              minimumEnforcementLevel: 'host' as const,
              policy: policy('d'),
            },
            'update',
            4,
          ));
          if (updated.policyDigest !== policy('d').digest) throw new Error('policy update did not converge');
          const resolution = await driver.resolveService(options.createRequest(
            'network.resolve-service',
            { networkHandle: network.networkHandle, serviceName: 'model-gateway' },
            'resolve',
            4,
          ));
          if (!resolution.serviceHandle) throw new Error('service resolution did not return an opaque handle');
          await driver.releaseNetwork(options.createRequest(
            'network.release',
            { networkHandle: network.networkHandle },
            'release',
            4,
          ));
          const missing = await driver.checkNetwork(options.createRequest(
            'network.check',
            { networkHandle: network.networkHandle },
            'check-after-release',
            4,
          ));
          if (missing !== undefined) throw new Error('released network remained inspectable');
        },
      },
      {
        name: 'adopts durable handles and rejects stale fencing',
        description: 'A recreated driver observes state and stale controllers fail closed',
        run: async (value) => {
          const driver = value as NetworkManagementDriver;
          const network = await driver.prepareNetwork(prepare('restart', 7));
          const restarted = options.recreate(driver);
          const adopted = await restarted.checkNetwork(options.createRequest(
            'network.check',
            { networkHandle: network.networkHandle },
            'adopt',
            8,
          ));
          if (adopted?.networkHandle !== network.networkHandle) throw new Error('network was not adopted');
          let staleRejected = false;
          try {
            await restarted.checkNetwork(options.createRequest(
              'network.check',
              { networkHandle: network.networkHandle },
              'stale',
              6,
            ));
          } catch (error) {
            staleRejected = error instanceof OrchestrationError && error.code === 'STALE_EPOCH';
          }
          if (!staleRejected) throw new Error('stale network fencing epoch was accepted');
        },
      },
      {
        name: 'rejects foreign handles',
        description: 'Opaque network handles remain scoped to their resource UID',
        run: async (value) => {
          const driver = value as NetworkManagementDriver;
          const network = await driver.prepareNetwork(prepare('scope-a', 9, 'network-a'));
          let foreignRejected = false;
          try {
            await driver.checkNetwork(options.createRequest(
              'network.check',
              { networkHandle: network.networkHandle },
              'scope-b',
              9,
              'network-b',
            ));
          } catch (error) {
            foreignRejected = error instanceof OrchestrationError && error.code === 'FORBIDDEN';
          }
          if (!foreignRejected) throw new Error('foreign network handle was accepted');
        },
      },
    ],
  };
}
