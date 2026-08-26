import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import {
  assertExternalToolContracts,
  assertExternalWorkloadRuntimeContracts,
  canonicalDriverValue,
  type ControlStore,
  type ControlStoreActor,
  createControlStoreOrchestrationClient,
  createDriverManifestManifest,
  type DriverManifestAdmissionBinding,
  type DriverManifestConformance,
  type DriverManifestResource,
  type DriverManifestSpec,
  type ExternalDriverCapabilities,
  type ExternalOrchestrationDriver,
  type ExternalToolContract,
  InfrastructureDriverRegistry,
} from 'memeloop';

/**
 * External driver discovery and registration (plan 24.62 items 3–5).
 *
 * CNI-analogue discovery: the daemon reads `*.json` driver manifests from a
 * well-known directory (`<dataDir>/drivers.d/` by default), dynamically
 * imports the named module (a separate optional package — never a default
 * CLI dependency), instantiates the driver through the declared export, and
 * validates the result structurally against the ExternalOrchestrationDriver
 * contract. Valid drivers are registered into the ControlStore as
 * DriverManifest resources (item 4) so the scheduler can discover them.
 *
 * Failure posture: malformed manifests, unresolvable modules, and
 * non-conforming drivers are collected as errors and skipped — a broken
 * driver file must never take down the daemon, but it is loudly reported.
 */

export interface ExternalDriverManifestFile {
  apiVersion: 'drivers.memeloop.io/v1alpha1';
  kind: 'DriverManifest';
  metadata: { name: string; namespace?: string };
  spec: {
    driverType: 'external-orchestrator';
    /** Package name or absolute path to import. */
    module: string;
    /** SHA-256 of the exact immutable package/module bytes approved for loading. */
    packageDigest: string;
    /** Named export used as the factory (default: the module's default export). */
    export?: string;
    /** Instantiate with `new` (class export) instead of calling as a factory. */
    construct?: boolean;
    /** Opaque configuration passed to the factory/constructor. */
    config?: Record<string, unknown>;
  };
}

export interface DiscoveredExternalDriver {
  name: string;
  namespace?: string;
  driver: ExternalOrchestrationDriver;
  capabilities: ExternalDriverCapabilities;
  module: string;
  packageDigest: string;
  configurationDigest: string;
  conformance: DriverManifestConformance;
}

export interface ExternalDriverDiscoveryResult {
  drivers: DiscoveredExternalDriver[];
  errors: Array<{ file: string; error: string }>;
}

export interface DiscoverExternalDriversOptions {
  directory: string;
  signal?: AbortSignal;
  /** Module resolver (injectable for tests; defaults to dynamic import). */
  importModule?: (specifier: string) => Promise<Record<string, unknown>>;
  /** Trusted lock-integrity/bundle resolver required for bare npm specifiers. */
  resolvePackageDigest?: (
    specifier: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ) => Promise<string>;
  /** Receives raw local diagnostics; returned/persisted errors remain stable and redacted. */
  onDiagnostic?: (file: string, error: unknown) => void;
  /**
   * Trusted host harness. Driver/manifest self-reports are deliberately not
   * accepted: this callback must execute real conformance fixtures.
   */
  conformance?: ExternalDriverConformanceVerifier;
}

export interface ExternalDriverConformanceCandidate {
  name: string;
  module: string;
  driver: ExternalOrchestrationDriver;
  capabilities: ExternalDriverCapabilities;
  packageDigest: string;
  configurationDigest: string;
}

export interface ExternalDriverConformanceRun {
  suiteVersion: string;
  passedAt: string;
  fixtureDigest: string;
  verifiedBy: string;
  attestation: string;
  testsPassed: number;
  testsFailed: number;
  failure?: string;
}

export interface ExternalDriverAdmissionPayload extends DriverManifestAdmissionBinding {
  name: string;
  module: string;
  suiteVersion: string;
  passedAt: string;
  testsPassed: number;
  verifiedBy: string;
}

export interface ExternalDriverConformanceVerifier {
  run(candidate: ExternalDriverConformanceCandidate): Promise<ExternalDriverConformanceRun>;
  verifyAttestation(
    payload: ExternalDriverAdmissionPayload,
    attestation: string,
  ): boolean | Promise<boolean>;
}

const REQUIRED_DRIVER_METHODS = [
  'getCapabilities',
  'placeWorkload',
  'getWorkloadStatus',
  'stopWorkload',
  'executeToolOperation',
  'getToolOperationStatus',
  'cancelToolOperation',
  'listWorkloads',
  'listToolOperations',
  'getHealth',
] as const;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_EXTERNAL_DRIVER_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_EXTERNAL_DRIVER_MANIFEST_BYTES = 256 * 1024;
const MAX_EXTERNAL_DRIVER_CONFIG_BYTES = 64 * 1024;
const MAX_EXTERNAL_DRIVER_CONFIG_DEPTH = 32;
const MAX_EXTERNAL_DRIVER_CONFIG_NODES = 4_096;

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function externalDriverConfigurationDigest(config: Record<string, unknown> | undefined): string {
  return sha256(canonicalDriverValue(normalizeExternalDriverConfiguration(config)));
}

function cloneJsonPrimitive(value: unknown): null | boolean | number | string {
  if (
    value === null || typeof value === 'boolean' || typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) return value;
  throw new Error('external driver config must contain only finite JSON values');
}

/**
 * Detach and freeze untrusted configuration without recursive traversal. The
 * limits apply before the driver factory receives the object, preventing a
 * deeply nested manifest from consuming its stack or retaining mutable input.
 */
export function normalizeExternalDriverConfiguration(
  value: Record<string, unknown> | undefined,
): Readonly<Record<string, unknown>> {
  const sourceRoot: unknown = value ?? {};
  if (!isRecord(sourceRoot)) throw new Error('external driver config must be an object');

  type Pending = {
    source: Record<string, unknown> | unknown[];
    target: Record<string, unknown> | unknown[];
    depth: number;
  };
  const root: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const pending: Pending[] = [{ source: sourceRoot, target: root, depth: 0 }];
  const containers: Array<Record<string, unknown> | unknown[]> = [root];
  const seen: WeakSet<object> = new WeakSet([sourceRoot]);
  let nodes = 1;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const entries: Array<[string, unknown]> = Array.isArray(current.source)
      ? current.source.map((item, index) => [String(index), item])
      : Object.entries(current.source);
    for (const [key, item] of entries) {
      nodes += 1;
      if (nodes > MAX_EXTERNAL_DRIVER_CONFIG_NODES) {
        throw new Error('external driver config exceeds the node limit');
      }
      let cloned: unknown;
      if (item !== null && typeof item === 'object') {
        if (current.depth >= MAX_EXTERNAL_DRIVER_CONFIG_DEPTH) {
          throw new Error('external driver config exceeds the depth limit');
        }
        if (!Array.isArray(item) && !isRecord(item)) {
          throw new Error('external driver config must contain only JSON objects and arrays');
        }
        if (seen.has(item)) throw new Error('external driver config must not contain cycles or aliases');
        seen.add(item);
        cloned = Array.isArray(item) ? [] : Object.create(null) as Record<string, unknown>;
        containers.push(cloned as Record<string, unknown> | unknown[]);
        pending.push({
          source: item as Record<string, unknown> | unknown[],
          target: cloned as Record<string, unknown> | unknown[],
          depth: current.depth + 1,
        });
      } else {
        cloned = cloneJsonPrimitive(item);
      }
      if (Array.isArray(current.target)) current.target.push(cloned);
      else {
        Object.defineProperty(current.target, key, {
          value: cloned,
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
    }
  }

  const canonical = canonicalDriverValue(root);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_EXTERNAL_DRIVER_CONFIG_BYTES) {
    throw new Error('external driver config exceeds the byte limit');
  }
  for (let index = containers.length - 1; index >= 0; index -= 1) {
    Object.freeze(containers[index]);
  }
  return root;
}

function assertDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    throw new Error(`${field} must be a canonical sha256 digest`);
  }
}

async function readBoundedRegularUtf8File(
  file: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const link = await fs.promises.lstat(file);
  if (link.isSymbolicLink() || !link.isFile()) {
    throw new Error('external driver manifest must be one regular non-symlink file');
  }
  if (link.size > maximumBytes) throw new Error('external driver manifest exceeds the byte limit');

  const handle = await fs.promises.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() || opened.size !== link.size ||
      opened.dev !== link.dev || opened.ino !== link.ino
    ) throw new Error('external driver manifest changed before reading');
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error('external driver manifest was truncated while reading');
      offset += bytesRead;
    }
    signal?.throwIfAborted();
    const afterRead = await handle.stat();
    if (afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs) {
      throw new Error('external driver manifest changed while reading');
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('external driver manifest is not valid UTF-8');
    }
  } finally {
    await handle.close();
  }
}

async function resolveActualPackageDigest(
  module: string,
  resolver: DiscoverExternalDriversOptions['resolvePackageDigest'],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  let file: string | undefined;
  if (path.isAbsolute(module)) file = module;
  else if (module.startsWith('file:')) file = fileURLToPath(module);
  if (file) {
    const link = await fs.promises.lstat(file);
    if (link.isSymbolicLink() || !link.isFile()) {
      throw new Error('local driver package must be one regular non-symlink file');
    }
    if (link.size > MAX_EXTERNAL_DRIVER_PACKAGE_BYTES) {
      throw new Error('local driver package exceeds the bounded bundle size');
    }
    if ((link.mode & 0o022) !== 0) {
      throw new Error('local driver package must not be group/world writable');
    }
    const handle = await fs.promises.open(file, 'r');
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() || opened.size !== link.size ||
        opened.dev !== link.dev || opened.ino !== link.ino
      ) throw new Error('local driver package changed before hashing');
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, opened.size)));
      let position = 0;
      while (position < opened.size) {
        signal?.throwIfAborted();
        const length = Math.min(buffer.length, opened.size - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead === 0) throw new Error('local driver package was truncated while hashing');
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      signal?.throwIfAborted();
      const afterHash = await handle.stat();
      if (afterHash.size !== opened.size || afterHash.mtimeMs !== opened.mtimeMs) {
        throw new Error('local driver package changed while hashing');
      }
      return `sha256:${hash.digest('hex')}`;
    } finally {
      await handle.close();
    }
  }
  if (!resolver) throw new Error('bare module requires a trusted package integrity resolver');
  const digest = await resolver(module, {
    maxBytes: MAX_EXTERNAL_DRIVER_PACKAGE_BYTES,
    ...(signal === undefined ? {} : { signal }),
  });
  signal?.throwIfAborted();
  assertDigest(digest, 'resolved package digest');
  return digest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function validateManifestFile(value: unknown, file: string): ExternalDriverManifestFile {
  if (!isRecord(value)) throw new Error(`${file}: manifest is not an object`);
  if (value.apiVersion !== 'drivers.memeloop.io/v1alpha1') throw new Error(`${file}: unsupported apiVersion '${String(value.apiVersion)}'`);
  if (value.kind !== 'DriverManifest') throw new Error(`${file}: kind must be 'DriverManifest'`);
  if (!isRecord(value.metadata) || typeof value.metadata.name !== 'string' || value.metadata.name.length === 0) {
    throw new Error(`${file}: metadata.name is required`);
  }
  if (value.metadata.namespace !== undefined) {
    throw new Error(`${file}: external driver namespaces are not supported by placement identity`);
  }
  if (!isRecord(value.spec)) throw new Error(`${file}: spec is required`);
  if (value.spec.driverType !== 'external-orchestrator') {
    throw new Error(`${file}: spec.driverType must be 'external-orchestrator'`);
  }
  if (typeof value.spec.module !== 'string' || value.spec.module.length === 0) {
    throw new Error(`${file}: spec.module is required`);
  }
  assertDigest(value.spec.packageDigest, `${file}: spec.packageDigest`);
  if (value.spec.export !== undefined && typeof value.spec.export !== 'string') {
    throw new Error(`${file}: spec.export must be a string`);
  }
  if (value.spec.config !== undefined && !isRecord(value.spec.config)) {
    throw new Error(`${file}: spec.config must be an object`);
  }
  return value as unknown as ExternalDriverManifestFile;
}

function assertDriverShape(value: unknown, name: string): asserts value is ExternalOrchestrationDriver {
  if (!isRecord(value)) {
    throw new Error(`driver '${name}': factory did not return an object`);
  }
  for (const method of REQUIRED_DRIVER_METHODS) {
    if (typeof value[method] !== 'function') {
      throw new Error(`driver '${name}': missing ExternalOrchestrationDriver method '${method}'`);
    }
  }
}

function assertCapabilities(value: unknown, name: string): asserts value is ExternalDriverCapabilities {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new Error(`driver '${name}': getCapabilities() must return { name, version, ... }`);
  }
  if (!Array.isArray(value.manages) || value.manages.length === 0) {
    throw new Error(`driver '${name}': capabilities.manages must be a non-empty array`);
  }
  if (typeof value.supportsAdoption !== 'boolean') {
    throw new Error(`driver '${name}': capabilities.supportsAdoption must be boolean`);
  }
  if (value.manages.includes('ToolOperation')) {
    if (!Array.isArray(value.toolContracts) || value.toolContracts.length === 0) {
      throw new Error(
        `driver '${name}': ToolOperation support requires non-empty capabilities.toolContracts`,
      );
    }
    assertExternalToolContracts(value.toolContracts as ExternalToolContract[]);
  }
  if (value.manages.includes('AgentWorkload')) {
    if (!Array.isArray(value.workloadRuntimes) || value.workloadRuntimes.length === 0) {
      throw new Error(
        `driver '${name}': AgentWorkload support requires non-empty capabilities.workloadRuntimes`,
      );
    }
    assertExternalWorkloadRuntimeContracts(
      value.workloadRuntimes as NonNullable<ExternalDriverCapabilities['workloadRuntimes']>,
    );
  }
}

export function externalDriverAdmissionPayload(
  candidate: Omit<ExternalDriverConformanceCandidate, 'driver' | 'capabilities'>,
  run: ExternalDriverConformanceRun,
): ExternalDriverAdmissionPayload {
  return {
    name: candidate.name,
    module: candidate.module,
    packageDigest: candidate.packageDigest,
    configurationDigest: candidate.configurationDigest,
    fixtureDigest: run.fixtureDigest,
    suiteVersion: run.suiteVersion,
    passedAt: run.passedAt,
    testsPassed: run.testsPassed,
    verifiedBy: run.verifiedBy,
  };
}

function failedConformance(): DriverManifestConformance {
  return {
    suiteVersion: 'memeloop-driver-conformance/v1',
    status: 'failed',
    failedAt: new Date().toISOString(),
    failure: 'external_driver_conformance_failed',
  };
}

async function verifyConformance(
  verifier: ExternalDriverConformanceVerifier | undefined,
  candidate: ExternalDriverConformanceCandidate,
  onDiagnostic?: (error: unknown) => void,
): Promise<DriverManifestConformance> {
  if (!verifier) {
    return { suiteVersion: 'memeloop-driver-conformance/v1', status: 'not-run' };
  }
  try {
    const run = await verifier.run(candidate);
    assertDigest(run.fixtureDigest, 'conformance fixtureDigest');
    if (
      typeof run.suiteVersion !== 'string' || run.suiteVersion.length === 0 ||
      typeof run.passedAt !== 'string' || Number.isNaN(Date.parse(run.passedAt)) ||
      typeof run.verifiedBy !== 'string' || !run.verifiedBy.startsWith('verifier/') ||
      typeof run.attestation !== 'string' || run.attestation.length === 0 || run.attestation.length > 16_384 ||
      !Number.isSafeInteger(run.testsPassed) || run.testsPassed < 0 ||
      !Number.isSafeInteger(run.testsFailed) || run.testsFailed < 0
    ) throw new Error('external driver conformance harness returned invalid evidence');
    if (run.testsFailed > 0 || run.testsPassed < 1) {
      throw new Error(run.failure ?? 'external driver conformance suite did not pass');
    }
    const payload = externalDriverAdmissionPayload(candidate, run);
    if (!await verifier.verifyAttestation(payload, run.attestation)) {
      throw new Error('external driver conformance attestation was not trusted');
    }
    return {
      suiteVersion: run.suiteVersion,
      status: 'passed',
      passedAt: run.passedAt,
      packageDigest: candidate.packageDigest,
      configurationDigest: candidate.configurationDigest,
      fixtureDigest: run.fixtureDigest,
      verifiedBy: run.verifiedBy,
      attestation: run.attestation,
      testsPassed: run.testsPassed,
    };
  } catch (error) {
    onDiagnostic?.(error);
    return failedConformance();
  }
}

/**
 * Discover external orchestrator drivers from a manifest directory. A missing
 * directory is not an error — it simply means no drivers are installed.
 */
export async function discoverExternalDrivers(options: DiscoverExternalDriversOptions): Promise<ExternalDriverDiscoveryResult> {
  const importModule = options.importModule ?? ((specifier: string) => import(specifier) as Promise<Record<string, unknown>>);
  const result: ExternalDriverDiscoveryResult = { drivers: [], errors: [] };

  let files: string[];
  try {
    files = fs.readdirSync(options.directory)
      .filter((entry) => entry.endsWith('.json'))
      .sort();
  } catch {
    return result; // No discovery directory — no drivers installed.
  }

  for (const file of files) {
    const filePath = path.join(options.directory, file);
    try {
      const manifestText = await readBoundedRegularUtf8File(
        filePath,
        MAX_EXTERNAL_DRIVER_MANIFEST_BYTES,
        options.signal,
      );
      const manifest = validateManifestFile(JSON.parse(manifestText), file);
      const actualPackageDigest = await resolveActualPackageDigest(
        manifest.spec.module,
        options.resolvePackageDigest,
        options.signal,
      );
      if (actualPackageDigest !== manifest.spec.packageDigest) {
        throw new Error('module packageDigest does not match independently resolved bytes');
      }
      const config = normalizeExternalDriverConfiguration(manifest.spec.config);
      const configurationDigest = sha256(canonicalDriverValue(config));
      const module = await importModule(manifest.spec.module);
      options.signal?.throwIfAborted();
      const packageDigestAfterImport = await resolveActualPackageDigest(
        manifest.spec.module,
        options.resolvePackageDigest,
        options.signal,
      );
      if (packageDigestAfterImport !== actualPackageDigest) {
        throw new Error('module bytes changed while the driver was being loaded');
      }
      const exported = manifest.spec.export !== undefined ? module[manifest.spec.export] : (module.default ?? module);
      if (typeof exported !== 'function') {
        throw new Error(`${file}: export '${manifest.spec.export ?? 'default'}' is not a factory/constructor`);
      }
      const driver: unknown = manifest.spec.construct === true
        ? new (exported as new(config?: Record<string, unknown>) => unknown)(config)
        : (exported as (config?: Record<string, unknown>) => unknown)(config);
      assertDriverShape(driver, manifest.metadata.name);
      const capabilities = await (driver).getCapabilities();
      assertCapabilities(capabilities, manifest.metadata.name);
      const candidate: ExternalDriverConformanceCandidate = {
        name: manifest.metadata.name,
        module: manifest.spec.module,
        driver,
        capabilities,
        packageDigest: manifest.spec.packageDigest,
        configurationDigest,
      };
      const conformance = await verifyConformance(
        options.conformance,
        candidate,
        error => options.onDiagnostic?.(file, error),
      );
      result.drivers.push({
        name: manifest.metadata.name,
        ...(manifest.metadata.namespace !== undefined ? { namespace: manifest.metadata.namespace } : {}),
        driver: driver,
        capabilities,
        module: manifest.spec.module,
        packageDigest: manifest.spec.packageDigest,
        configurationDigest,
        conformance,
      });
    } catch (error) {
      options.onDiagnostic?.(file, error);
      result.errors.push({ file, error: 'external_driver_discovery_failed' });
    }
  }
  return result;
}

/** Map discovered capabilities to the ControlStore DriverManifest spec. */
export function externalDriverManifestSpecFor(
  capabilities: ExternalDriverCapabilities,
  conformance: DriverManifestConformance = {
    suiteVersion: 'memeloop-driver-conformance/v1',
    status: 'not-run',
  },
): DriverManifestSpec {
  return {
    driverType: 'external-orchestrator',
    version: capabilities.version,
    execution: {
      location: 'external',
      transport: 'container-api',
    },
    supportedTrustClasses: ['trusted'],
    resourceKinds: capabilities.manages,
    capabilities: {
      ...(capabilities.maxConcurrency !== undefined ? { maxConcurrency: capabilities.maxConcurrency } : {}),
    },
    downgradeBehavior: 'reject',
    requiredHostPrivileges: ['external-orchestrator-api'],
    isolation: {
      boundary: 'external',
      threatAssumptions: [
        'backend credentials remain in the trusted driver host',
        'backend admission and workload hardening are independently enforced',
      ],
    },
    configuration: {
      schemaRef: 'memeloop://schemas/external-driver-package-manifest/v1',
      secretRefs: ['config.secretRefs'],
    },
    health: { mode: 'method' },
    lifecycle: {
      discoverable: true,
      hotReload: false,
      gracefulShutdown: true,
    },
    conformance,
    manages: capabilities.manages,
    supportsColocation: capabilities.supportsColocation,
    // The contract has cancel/stop verbs; adoption/backpressure/fencing are
    // not claimed by the current external driver interface (honest defaults).
    supportsCancellation: true,
    supportsBackpressure: false,
    supportsAdoption: capabilities.supportsAdoption,
    supportsFencing: false,
  };
}

export interface RegisterExternalDriversResult {
  registered: string[];
  errors: Array<{ name: string; error: string }>;
}

/**
 * Register discovered drivers as DriverManifest resources (idempotent apply;
 * spec drift conflicts are reported, matching content-addressed semantics).
 */
export async function registerExternalDriverManifests(
  store: ControlStore,
  actor: ControlStoreActor,
  drivers: DiscoveredExternalDriver[],
  onDiagnostic?: (name: string, error: unknown) => void,
): Promise<RegisterExternalDriversResult> {
  const client = createControlStoreOrchestrationClient(store, actor);
  const result: RegisterExternalDriversResult = { registered: [], errors: [] };
  for (const discovered of drivers) {
    try {
      const manifest = createDriverManifestManifest(discovered.name, externalDriverManifestSpecFor(discovered.capabilities));
      if (discovered.namespace !== undefined) manifest.metadata.namespace = discovered.namespace;
      if (discovered.conformance.status === 'passed' && actor.kind !== 'verifier') {
        throw new Error(`driver '${discovered.name}': passed conformance requires a verifier actor`);
      }
      manifest.spec.conformance = discovered.conformance;
      const applied = await client.apply(manifest) as DriverManifestResource;
      if (discovered.conformance.status === 'passed' && applied.status?.phase !== 'Ready') {
        await store.updateStatus(
          actor,
          {
            apiVersion: applied.apiVersion,
            kind: applied.kind,
            name: applied.metadata.name,
            namespace: applied.metadata.namespace,
          },
          { phase: 'Ready' },
          { resourceVersion: applied.metadata.resourceVersion },
        );
      }
      result.registered.push(discovered.name);
    } catch (error) {
      onDiagnostic?.(discovered.name, error);
      result.errors.push({ name: discovered.name, error: 'external_driver_registration_failed' });
    }
  }
  return result;
}

/**
 * Build the sole production execution registry from durable admitted
 * manifests. Discovery output remains useful for Pending/Rejected UI, but it
 * cannot reach a driver method through this registry without re-verifying the
 * attestation over the exact live package/configuration/fixture binding.
 */
export async function createAdmittedExternalDriverRegistry(
  store: ControlStore,
  drivers: DiscoveredExternalDriver[],
  verifier: ExternalDriverConformanceVerifier | undefined,
): Promise<InfrastructureDriverRegistry<DiscoveredExternalDriver>> {
  const registry = new InfrastructureDriverRegistry<DiscoveredExternalDriver>({
    async verifyAdmission({ driver, manifest }) {
      const conformance = manifest.spec.conformance;
      if (!verifier || conformance.status !== 'passed') return false;
      return verifier.verifyAttestation(
        {
          name: driver.name,
          module: driver.module,
          packageDigest: driver.packageDigest,
          configurationDigest: driver.configurationDigest,
          fixtureDigest: conformance.fixtureDigest,
          suiteVersion: conformance.suiteVersion,
          passedAt: conformance.passedAt,
          testsPassed: conformance.testsPassed,
          verifiedBy: conformance.verifiedBy,
        },
        conformance.attestation,
      );
    },
  });
  for (const driver of drivers) {
    if (driver.conformance.status !== 'passed') continue;
    const resource = await store.get<DriverManifestSpec, DriverManifestResource['status']>({
      apiVersion: 'drivers.memeloop.io/v1alpha1',
      kind: 'DriverManifest',
      name: driver.name,
      namespace: driver.namespace,
    });
    if (!resource) continue;
    await registry.register({
      name: driver.name,
      driver,
      manifest: resource as DriverManifestResource,
      admission: {
        packageDigest: driver.packageDigest,
        configurationDigest: driver.configurationDigest,
        fixtureDigest: driver.conformance.fixtureDigest,
      },
    });
  }
  return registry;
}
