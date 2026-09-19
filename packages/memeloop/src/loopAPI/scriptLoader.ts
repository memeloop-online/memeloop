/**
 * Agent loop script loader (plan 24.15: source is never imported directly
 * from an LLM string without passing the admission chain).
 *
 * Loading rules:
 * - Builtin loop sources are allowlisted by content digest at startup
 *   ({@link registerBuiltinScriptSources}); they load with zero gate overhead.
 * - Any other source-bearing reference (`source` refs and `data:` URLs) must
 *   pass the host-injected {@link ScriptLoadGate}: validate (AST) → admit
 *   (trust-class policy) → only then `import()`.
 * - When no gate is configured, all non-builtin sources are DENIED
 *   (fail-closed) with a structured {@link ScriptLoadDeniedError}.
 *
 * Admission results (trust class, RuntimeClass, checkpoint identity)
 * are attached to the loaded script via {@link LOADED_SCRIPT_METADATA} so
 * hosts can enforce sandboxing.
 */

import { digestNormalizedScript, normalizeScript } from '../orchestration/scripts/scriptValidation.js';
import { defaultAgentLoopModuleImporter } from './nodeAgentLoopModuleImporter.js';
import { LOOP_CHECKPOINT_API_VERSION, LOOP_CHECKPOINT_SCHEMA_VERSION } from './types.js';
import type { AgentLoopScriptPolicy, LoopProfile, LoopProfileScriptReference, LoopScriptCheckpointBinding, LoopScriptCheckpointDeclaration, ScriptLoadGate } from './types.js';

export type AgentLoopScriptReference = string | LoopProfileScriptReference;

export interface LoadAgentLoopScriptOptions extends AgentLoopScriptPolicy {
  getBuiltinScriptModule?: (id: string) => unknown;
  getBuiltinScriptSource?: (id: string) => string | undefined;
  scriptType?: string;
}

export interface BuiltinAgentLoopScriptLoaderOptions {
  sources: Record<string, string>;
  getBuiltinScriptModule: (id: string) => unknown;
  getBuiltinScriptSource: (id: string) => string | undefined;
  scriptType: string;
}

/**
 * Build a typed loader for a loop family and register its first-party sources
 * in the digest allowlist once. Non-builtin sources still pass through the
 * common fail-closed admission chain in {@link loadAgentLoopScript}.
 */
export function createBuiltinAgentLoopScriptLoader<TScript>(
  loaderOptions: BuiltinAgentLoopScriptLoaderOptions,
): (scriptReference: AgentLoopScriptReference, policy?: AgentLoopScriptPolicy) => Promise<TScript> {
  let builtinDigestsRegistered: Promise<unknown> | undefined;
  return async (scriptReference, policy = {}) => {
    builtinDigestsRegistered ??= registerBuiltinScriptSources(loaderOptions.sources);
    await builtinDigestsRegistered;
    return loadAgentLoopScript<TScript>(scriptReference, {
      ...policy,
      getBuiltinScriptModule: loaderOptions.getBuiltinScriptModule,
      getBuiltinScriptSource: loaderOptions.getBuiltinScriptSource,
      scriptType: loaderOptions.scriptType,
    });
  };
}

const DEFAULT_POLICY = {
  allowBuiltin: true,
  allowFile: false,
  allowNetwork: false,
  allowSource: false,
  allowSpecifier: true,
} as const;

// ─── Loaded-script admission metadata ──────────────────────────────────

/** Symbol under which the admission result is attached to a loaded script. */
export const LOADED_SCRIPT_METADATA: unique symbol = Symbol('memeloop.loadedScriptMetadata');

/** Admission metadata attached to every source-loaded script. */
export interface LoadedScriptMetadata {
  /** Canonical SHA-256 hex digest of the normalized source. */
  digest: string;
  /** True when the digest matched the builtin allowlist (first-party code). */
  builtin: boolean;
  /** Trust class assigned by admission (plan 24.17). */
  trustClass?: string;
  /** RuntimeClass name the host must enforce for this script (plan 24.18). */
  runtimeClass?: string;
  /** Whether the script may resume its expected checkpoint (plan 24.19). */
  checkpointAccepted?: boolean;
  /** Optional stable checkpoint boundary exported by the `.mjs` module. */
  checkpoint?: LoopScriptCheckpointDeclaration;
}

type LoadedScriptFunction = (...arguments_: never[]) => unknown;

function isLoadedScriptFunction(value: unknown): value is LoadedScriptFunction {
  return typeof value === 'function';
}

type DataPropertyRead =
  | { present: true; value: unknown }
  | { present: false };

function readDataProperty(value: object, key: PropertyKey): DataPropertyRead | undefined {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return { present: false };
    if (descriptor.get !== undefined || descriptor.set !== undefined || !('value' in descriptor)) {
      return undefined;
    }
    return { present: true, value: descriptor.value };
  } catch {
    return undefined;
  }
}

function isMetadataObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return false;
    const allowed = new Set<PropertyKey>([
      'digest',
      'builtin',
      'trustClass',
      'runtimeClass',
      'checkpointAccepted',
      'checkpoint',
    ]);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => !allowed.has(key))) return false;
    return true;
  } catch {
    return false;
  }
}

function isLoadedScriptMetadata(value: unknown): value is LoadedScriptMetadata {
  if (!isMetadataObject(value)) return false;
  const digest = readDataProperty(value, 'digest');
  const builtin = readDataProperty(value, 'builtin');
  if (
    digest?.present !== true ||
    builtin?.present !== true ||
    typeof digest.value !== 'string' ||
    digest.value.length === 0 ||
    typeof builtin.value !== 'boolean'
  ) return false;
  for (const key of ['trustClass', 'runtimeClass'] as const) {
    const field = readDataProperty(value, key);
    if (field === undefined) return false;
    if (field.present && field.value !== undefined && typeof field.value !== 'string') return false;
  }
  const checkpointAccepted = readDataProperty(value, 'checkpointAccepted');
  if (checkpointAccepted === undefined) return false;
  if (
    checkpointAccepted.present &&
    checkpointAccepted.value !== undefined &&
    typeof checkpointAccepted.value !== 'boolean'
  ) return false;
  const checkpoint = readDataProperty(value, 'checkpoint');
  if (checkpoint === undefined) return false;
  return (!checkpointAccepted.present ||
    checkpointAccepted.value === undefined ||
    typeof checkpointAccepted.value === 'boolean') &&
    (!checkpoint.present || checkpoint.value === undefined || isLoopScriptCheckpointDeclaration(checkpoint.value));
}

function isLoopScriptCheckpointDeclaration(value: unknown): value is LoopScriptCheckpointDeclaration {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => key !== 'id' && key !== 'version' && key !== 'migrate')) return false;
    const id = readDataProperty(value, 'id');
    const version = readDataProperty(value, 'version');
    const migrate = readDataProperty(value, 'migrate');
    return id?.present === true &&
      version?.present === true &&
      typeof id.value === 'string' && id.value.trim().length > 0 && id.value === id.value.trim() &&
      typeof version.value === 'string' && version.value.trim().length > 0 && version.value === version.value.trim() &&
      (migrate?.present !== true || migrate.value === undefined || typeof migrate.value === 'function');
  } catch {
    return false;
  }
}

function readExportedCheckpointDeclaration(moduleExports: unknown): LoopScriptCheckpointDeclaration | undefined {
  if (!isModuleExports(moduleExports)) return undefined;
  let candidate: unknown;
  try {
    candidate = Reflect.get(moduleExports, 'checkpoint');
  } catch {
    return undefined;
  }
  if (candidate === undefined) return undefined;
  if (!isLoopScriptCheckpointDeclaration(candidate)) {
    throw new TypeError('Agent loop script checkpoint export must be a plain { id, version, migrate? } declaration.');
  }
  return {
    id: candidate.id,
    version: candidate.version,
    ...(candidate.migrate ? { migrate: candidate.migrate } : {}),
  };
}

/**
 * Read the admission metadata attached to a loaded script, or `undefined`
 * when the script was provided directly (not loaded through this module).
 */
export function getLoadedScriptMetadata(script: unknown): LoadedScriptMetadata | undefined {
  if (!isLoadedScriptFunction(script)) return undefined;
  const metadata = readDataProperty(script, LOADED_SCRIPT_METADATA);
  return metadata?.present === true && isLoadedScriptMetadata(metadata.value)
    ? metadata.value
    : undefined;
}

/**
 * Build the durable checkpoint binding for an admitted script.  Directly
 * supplied functions intentionally have no binding: Core cannot invent a
 * stable source digest for them and must not restore arbitrary state.
 */
export function getLoadedScriptCheckpointBinding(
  script: unknown,
  profile: Pick<LoopProfile, 'version'> | undefined,
  runId?: string,
): LoopScriptCheckpointBinding | undefined {
  const metadata = getLoadedScriptMetadata(script);
  const declaration = metadata?.checkpoint;
  if (!metadata || !declaration) return undefined;
  return {
    accepted: metadata.builtin || metadata.checkpointAccepted === true,
    identity: {
      id: declaration.id,
      scriptVersion: declaration.version,
      profileVersion: profile?.version ?? '0',
      scriptDigest: metadata.digest,
      apiVersion: LOOP_CHECKPOINT_API_VERSION,
      schemaVersion: LOOP_CHECKPOINT_SCHEMA_VERSION,
      ...(runId ? { runId } : {}),
    },
    ...(declaration.migrate ? { migrate: declaration.migrate } : {}),
  };
}

function attachLoadedScriptMetadata(script: LoadedScriptFunction, metadata: LoadedScriptMetadata): void {
  // Module-level caching means the same function object can be returned for
  // repeated loads of an identical specifier; the metadata is derived from
  // the source digest, so re-attaching is unnecessary.
  if (getLoadedScriptMetadata(script) !== undefined) return;
  Object.defineProperty(script, LOADED_SCRIPT_METADATA, {
    value: metadata,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

// ─── Builtin digest allowlist ──────────────────────────────────────────

const builtinScriptDigests = new Set<string>();

/**
 * Register pre-computed digests of first-party builtin loop sources.
 * Idempotent; hosts typically use {@link registerBuiltinScriptSources}.
 */
export function registerBuiltinScriptDigests(digests: Iterable<string>): void {
  for (const digest of digests) {
    builtinScriptDigests.add(digest);
  }
}

/**
 * Compute canonical digests for builtin loop sources and register them in
 * the startup allowlist. Returns the registered digests.
 */
export async function registerBuiltinScriptSources(sources: Record<string, string>): Promise<string[]> {
  const digests: string[] = [];
  for (const source of Object.values(sources)) {
    digests.push(await digestNormalizedScript(normalizeScript(source)));
  }
  registerBuiltinScriptDigests(digests);
  return digests;
}

/** Check whether a canonical digest belongs to a registered builtin source. */
export function isRegisteredBuiltinScriptDigest(digest: string): boolean {
  return builtinScriptDigests.has(digest);
}

// ─── Denial error ──────────────────────────────────────────────────────

/** Structured error thrown when the script load gate denies a source. */
export class ScriptLoadDeniedError extends Error {
  readonly code = 'SCRIPT_LOAD_DENIED' as const;

  constructor(
    /** Canonical digest of the denied script. */
    readonly digest: string,
    /** Reason reported by the gate. */
    readonly gateReason: string,
  ) {
    super(`Agent loop script load denied (sha256:${digest}): ${gateReason}`);
    this.name = 'ScriptLoadDeniedError';
  }
}

/**
 * Default gate used when the host provides none: denies every non-builtin
 * script source (fail-closed, plan 24.15).
 */
export const FAIL_CLOSED_SCRIPT_LOAD_GATE: ScriptLoadGate = {
  admitScriptLoad: () => ({
    allowed: false,
    reason: 'No script load gate configured; non-builtin script sources are denied by default (fail-closed)',
  }),
};

// ─── Helpers ───────────────────────────────────────────────────────────

interface ModuleExports {
  default?: unknown;
  run?: unknown;
}

function isModuleExports(value: unknown): value is ModuleExports {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getExportedScript(moduleExports: unknown): unknown {
  if (typeof moduleExports === 'function') return moduleExports;
  if (!isModuleExports(moduleExports)) return undefined;
  try {
    const defaultExport = Reflect.get(moduleExports, 'default');
    if (defaultExport !== undefined) return defaultExport;
    return Reflect.get(moduleExports, 'run');
  } catch {
    return undefined;
  }
}

function sourceToDataSpecifier(source: string, name = 'agent-loop-script.mjs'): string {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(`${source}\n//# sourceURL=${name}`)}`;
}

function normalizeScriptReference(scriptReference: AgentLoopScriptReference): LoopProfileScriptReference {
  if (typeof scriptReference !== 'string') return scriptReference;
  if (scriptReference.startsWith('builtin:')) return { kind: 'builtin', id: scriptReference };
  return { kind: 'specifier', specifier: scriptReference };
}

function isFileSpecifier(specifier: string): boolean {
  return specifier.startsWith('file:') || specifier.startsWith('/') || specifier.startsWith('./') || specifier.startsWith('../');
}

function isNetworkSpecifier(specifier: string): boolean {
  return specifier.startsWith('http:') || specifier.startsWith('https:');
}

function isSourceSpecifier(specifier: string): boolean {
  return specifier.startsWith('data:text/javascript') || specifier.startsWith('data:application/javascript');
}

/**
 * Decode the source carried by a `data:` script specifier. Returns
 * `undefined` when the payload cannot be decoded; callers must treat an
 * undecodable data URL as a denial (fail-closed).
 */
function decodeDataScriptSpecifier(specifier: string): string | undefined {
  const commaIndex = specifier.indexOf(',');
  if (commaIndex < 0) return undefined;
  const metadata = specifier.slice('data:'.length, commaIndex);
  const payload = specifier.slice(commaIndex + 1);
  try {
    if (metadata.split(';').includes('base64')) {
      // atob is available in browsers and Node ≥ 16; no Buffer needed.
      return atob(payload);
    }
    return decodeURIComponent(payload);
  } catch {
    return undefined;
  }
}

function assertSpecifierAllowed(specifier: string, policy: Required<Pick<LoadAgentLoopScriptOptions, 'allowFile' | 'allowNetwork' | 'allowSource' | 'allowSpecifier'>>): void {
  if (!policy.allowSpecifier) {
    throw new Error('Agent loop script import specifiers are disabled by policy.');
  }
  if (isSourceSpecifier(specifier) && !policy.allowSource) {
    throw new Error('Agent loop script source/data URLs are disabled by policy.');
  }
  if (isFileSpecifier(specifier) && !policy.allowFile) {
    throw new Error('Agent loop script file imports are disabled by policy.');
  }
  if (isNetworkSpecifier(specifier) && !policy.allowNetwork) {
    throw new Error('Agent loop script network imports are disabled by policy.');
  }
}

/**
 * Load an agent loop script. Source-bearing references (builtin sources,
 * `source` refs, `data:` URLs) are admitted by content digest before
 * `import()`: builtin digests load directly, everything else must pass the
 * host's {@link ScriptLoadGate} and is denied when no gate is configured.
 */
export async function loadAgentLoopScript<TScript>(
  scriptReference: AgentLoopScriptReference,
  options: LoadAgentLoopScriptOptions = {},
): Promise<TScript> {
  const policy = { ...DEFAULT_POLICY, ...options };
  const importModule = options.importModule ?? defaultAgentLoopModuleImporter;
  const normalized = normalizeScriptReference(scriptReference);
  const scriptType = options.scriptType ?? 'Agent loop script';
  let scriptSpecifier: string;
  let staticBuiltinModule: unknown;
  let sourceForAdmission: string | undefined;

  if (normalized.kind === 'builtin') {
    if (!policy.allowBuiltin) {
      throw new Error('Built-in agent loop scripts are disabled by policy.');
    }
    const source = options.getBuiltinScriptSource?.(normalized.id);
    if (!source) throw new Error(`Unknown built-in agent loop script: ${normalized.id}`);
    staticBuiltinModule = options.getBuiltinScriptModule?.(normalized.id);
    sourceForAdmission = source;
    scriptSpecifier = sourceToDataSpecifier(source, normalized.id);
  } else if (normalized.kind === 'source') {
    if (!policy.allowSource) {
      throw new Error('Agent loop script source strings are disabled by policy.');
    }
    sourceForAdmission = normalized.source;
    scriptSpecifier = sourceToDataSpecifier(normalized.source, normalized.name);
  } else {
    scriptSpecifier = normalized.specifier;
    assertSpecifierAllowed(scriptSpecifier, policy);
    if (isSourceSpecifier(scriptSpecifier)) {
      sourceForAdmission = decodeDataScriptSpecifier(scriptSpecifier);
      if (sourceForAdmission === undefined) {
        throw new ScriptLoadDeniedError('undecodable', 'data: script specifier payload could not be decoded');
      }
    }
  }

  // Admit source-bearing scripts by content digest before import().
  let metadata: LoadedScriptMetadata | undefined;
  if (sourceForAdmission !== undefined) {
    const normalizedSource = normalizeScript(sourceForAdmission);
    const digest = await digestNormalizedScript(normalizedSource);
    if (isRegisteredBuiltinScriptDigest(digest)) {
      // First-party builtin source: allowlisted by digest at startup.
      metadata = { digest, builtin: true, trustClass: 'trusted', checkpointAccepted: true };
    } else {
      const gate = options.scriptLoadGate ?? FAIL_CLOSED_SCRIPT_LOAD_GATE;
      const decision = await gate.admitScriptLoad({ normalizedSource, digest, reference: normalized, scriptType });
      if (!decision.allowed) {
        throw new ScriptLoadDeniedError(digest, decision.reason ?? 'denied by script load gate');
      }
      metadata = {
        digest,
        builtin: false,
        trustClass: decision.trustClass,
        runtimeClass: decision.runtimeClass,
        checkpointAccepted: decision.checkpointAccepted,
      };
    }
  }

  const moduleExports: unknown = staticBuiltinModule ?? await importModule(scriptSpecifier);
  const exportedScript = getExportedScript(moduleExports);

  if (!isLoadedScriptFunction(exportedScript)) {
    throw new TypeError(
      `${scriptType} "${scriptSpecifier}" must export a default function or named run function.`,
    );
  }

  const checkpoint = readExportedCheckpointDeclaration(moduleExports);
  if (metadata) {
    attachLoadedScriptMetadata(exportedScript, {
      ...metadata,
      ...(checkpoint ? { checkpoint } : {}),
    });
  }

  return exportedScript as TScript;
}
