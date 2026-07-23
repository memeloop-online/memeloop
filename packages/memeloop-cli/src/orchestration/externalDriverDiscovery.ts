import fs from 'node:fs';
import path from 'node:path';

import {
  type ControlStore,
  type ControlStoreActor,
  createControlStoreOrchestrationClient,
  createDriverManifestManifest,
  type DriverManifestSpec,
  type ExternalDriverCapabilities,
  type ExternalOrchestrationDriver,
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
}

export interface ExternalDriverDiscoveryResult {
  drivers: DiscoveredExternalDriver[];
  errors: Array<{ file: string; error: string }>;
}

export interface DiscoverExternalDriversOptions {
  directory: string;
  /** Module resolver (injectable for tests; defaults to dynamic import). */
  importModule?: (specifier: string) => Promise<Record<string, unknown>>;
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
  if (!isRecord(value.spec)) throw new Error(`${file}: spec is required`);
  if (value.spec.driverType !== 'external-orchestrator') {
    throw new Error(`${file}: spec.driverType must be 'external-orchestrator'`);
  }
  if (typeof value.spec.module !== 'string' || value.spec.module.length === 0) {
    throw new Error(`${file}: spec.module is required`);
  }
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
      const manifest = validateManifestFile(JSON.parse(fs.readFileSync(filePath, 'utf8')), file);
      const module = await importModule(manifest.spec.module);
      const exported = manifest.spec.export !== undefined ? module[manifest.spec.export] : (module.default ?? module);
      if (typeof exported !== 'function') {
        throw new Error(`${file}: export '${manifest.spec.export ?? 'default'}' is not a factory/constructor`);
      }
      const driver: unknown = manifest.spec.construct === true
        ? new (exported as new(config?: Record<string, unknown>) => unknown)(manifest.spec.config)
        : (exported as (config?: Record<string, unknown>) => unknown)(manifest.spec.config);
      assertDriverShape(driver, manifest.metadata.name);
      const capabilities = await (driver).getCapabilities();
      assertCapabilities(capabilities, manifest.metadata.name);
      result.drivers.push({
        name: manifest.metadata.name,
        ...(manifest.metadata.namespace !== undefined ? { namespace: manifest.metadata.namespace } : {}),
        driver: driver,
        capabilities,
      });
    } catch (error) {
      result.errors.push({ file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** Map discovered capabilities to the ControlStore DriverManifest spec. */
export function externalDriverManifestSpecFor(capabilities: ExternalDriverCapabilities): DriverManifestSpec {
  return {
    driverType: 'external-orchestrator',
    version: capabilities.version,
    capabilities: {
      ...(capabilities.maxConcurrency !== undefined ? { maxConcurrency: capabilities.maxConcurrency } : {}),
    },
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
): Promise<RegisterExternalDriversResult> {
  const client = createControlStoreOrchestrationClient(store, actor);
  const result: RegisterExternalDriversResult = { registered: [], errors: [] };
  for (const discovered of drivers) {
    try {
      const manifest = createDriverManifestManifest(discovered.name, externalDriverManifestSpecFor(discovered.capabilities));
      if (discovered.namespace !== undefined) manifest.metadata.namespace = discovered.namespace;
      await client.apply(manifest);
      result.registered.push(discovered.name);
    } catch (error) {
      result.errors.push({ name: discovered.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
