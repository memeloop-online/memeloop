import { satisfies, valid, validRange } from 'semver';
import type { HookType } from '../loopAPI/hooks/types.js';
import { safeErrorMessageFromUnknown } from '../safeError.js';
import { PluginRegistryManager } from './registry.js';
import type { PluginAPIOptions } from './registry.js';
import type { LoadedPlugin, PluginCleanup, PluginManifest, PluginModule } from './types.js';

interface LoadedPluginHandle {
  info: LoadedPlugin;
  module: PluginModule;
  cleanup?: PluginCleanup;
  unloading: boolean;
}

/** Runtime version used for plugin manifest requirement checks. Keep aligned with the package version. */
export const MEMELOOP_PLUGIN_API_VERSION = '0.3.1';

const dangerousManifestKeys = new Set(['__proto__', 'prototype', 'constructor']);
const manifestKeys = new Set(['name', 'version', 'description', 'exports', 'author', 'minMemeloopVersion']);
const exportKeys = new Set([
  'tools',
  'hooks',
  'agentProfiles',
  'loopDefinitions',
  'loopProfiles',
  'loopPlugins',
  'modelProviders',
]);
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlySafeKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every(key => !dangerousManifestKeys.has(key) && allowed.has(key));
}

const hookTypes = new Set<string>([
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'AgentStart',
  'AgentStop',
]);

function isHookType(value: unknown): value is HookType {
  return typeof value === 'string' && hookTypes.has(value);
}

export function validatePluginManifest(object: unknown): PluginManifest | null {
  if (!isPlainRecord(object) || !hasOnlySafeKeys(object, manifestKeys)) return null;
  const manifest = object;
  if (
    typeof manifest.name !== 'string' ||
    manifest.name.trim().length === 0 || manifest.name.trim().length > 256 ||
    hasControlCharacters(manifest.name) ||
    typeof manifest.version !== 'string' ||
    manifest.version.trim().length === 0 || manifest.version.trim().length > 64 ||
    (manifest.description !== undefined && (
      typeof manifest.description !== 'string' || manifest.description.length > 16_384
    )) ||
    (manifest.author !== undefined && (
      typeof manifest.author !== 'string' || manifest.author.length > 512
    )) ||
    valid(manifest.version.trim()) === null
  ) {
    return null;
  }
  const exports_ = validateExports(manifest.exports);
  if (exports_ === null) return null;
  const minimumVersion = typeof manifest.minMemeloopVersion === 'string'
    ? manifest.minMemeloopVersion.trim()
    : undefined;
  if (
    minimumVersion !== undefined &&
    (minimumVersion.length === 0 || minimumVersion.length > 256 || validRange(minimumVersion) === null)
  ) return null;
  return {
    name: manifest.name.trim(),
    version: manifest.version.trim(),
    description: typeof manifest.description === 'string' ? manifest.description : '',
    exports: exports_,
    author: typeof manifest.author === 'string' ? manifest.author : undefined,
    minMemeloopVersion: minimumVersion,
  };
}

function validateExports(object: unknown): PluginManifest['exports'] | null {
  if (object === undefined) return undefined;
  if (!isPlainRecord(object) || !hasOnlySafeKeys(object, exportKeys)) return null;
  const exportsRecord = object;
  const tools = normalizeExportIdentifiers(exportsRecord.tools, 256);
  const agentProfiles = normalizeExportIdentifiers(exportsRecord.agentProfiles, 256);
  const loopDefinitions = normalizeExportIdentifiers(exportsRecord.loopDefinitions, 256);
  const loopProfiles = normalizeExportIdentifiers(exportsRecord.loopProfiles, 256);
  const loopPlugins = normalizeExportIdentifiers(exportsRecord.loopPlugins, 256);
  const modelProviders = normalizeExportIdentifiers(exportsRecord.modelProviders, 256);
  if (
    tools === null || agentProfiles === null || loopDefinitions === null ||
    loopProfiles === null || loopPlugins === null || modelProviders === null
  ) return null;
  if (exportsRecord.hooks !== undefined && !Array.isArray(exportsRecord.hooks)) return null;
  const hooks = exportsRecord.hooks as unknown[] | undefined;
  if ((hooks?.length ?? 0) > 64) return null;
  if (hooks?.some(hook => !isHookType(hook))) return null;
  const normalizedHooks = hooks as HookType[] | undefined;
  if (normalizedHooks && new Set(normalizedHooks).size !== normalizedHooks.length) return null;
  return {
    tools,
    hooks: normalizedHooks,
    ...(agentProfiles === undefined ? {} : { agentProfiles }),
    ...(loopDefinitions === undefined ? {} : { loopDefinitions }),
    ...(loopProfiles === undefined ? {} : { loopProfiles }),
    ...(loopPlugins === undefined ? {} : { loopPlugins }),
    ...(modelProviders === undefined ? {} : { modelProviders }),
  };
}

function normalizeExportIdentifiers(value: unknown, maximum: number): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximum) return null;
  const normalized: string[] = [];
  for (const item of value) {
    if (
      typeof item !== 'string' || item.trim().length === 0 || item.trim().length > 256 ||
      hasControlCharacters(item)
    ) return null;
    normalized.push(item.trim());
  }
  return new Set(normalized).size === normalized.length ? normalized : null;
}

export interface LoadPluginModuleOptions {
  manifest: PluginManifest;
  module: PluginModule;
  /** Host services used to construct a plugin-scoped, unloadable API. */
  apiOptions?: Omit<PluginAPIOptions, 'pluginName'>;
  source?: string;
}

export interface PluginLoaderOptions {
  registryManager?: PluginRegistryManager;
  apiOptions?: Omit<PluginAPIOptions, 'pluginName'>;
  /** Host memeloop version used to enforce manifest.minMemeloopVersion. */
  memeloopVersion?: string;
  /** Maximum time allowed for activate() to settle. */
  activationTimeoutMs?: number;
  /** Maximum time allowed for an unload cleanup callback to settle. */
  cleanupTimeoutMs?: number;
  /** Maximum time allowed for already-started plugin tool calls to drain. */
  drainTimeoutMs?: number;
}

export class PluginLifecycleTimeoutError extends Error {
  readonly code = 'PLUGIN_LIFECYCLE_TIMEOUT' as const;

  constructor(readonly phase: 'activate' | 'cleanup' | 'drain', readonly pluginName: string) {
    super(`Plugin ${phase} timed out: ${pluginName}`);
    this.name = 'PluginLifecycleTimeoutError';
  }
}

function validateTimeout(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 300_000) {
    throw new RangeError(`${field} must be an integer between 1 and 300000`);
  }
  return value;
}

async function withLifecycleTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  phase: PluginLifecycleTimeoutError['phase'],
  pluginName: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new PluginLifecycleTimeoutError(phase, pluginName));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Runtime-scoped plugin lifecycle owner. */
export class PluginLoader {
  private readonly loadedPlugins = new Map<string, LoadedPluginHandle>();
  private readonly loadingPlugins = new Set<string>();
  private readonly registryManager: PluginRegistryManager;
  private readonly apiOptions: Omit<PluginAPIOptions, 'pluginName'>;
  private readonly memeloopVersion: string;
  private readonly activationTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly drainTimeoutMs: number;

  constructor(options: PluginLoaderOptions = {}) {
    this.registryManager = options.registryManager ?? new PluginRegistryManager();
    this.apiOptions = options.apiOptions ?? {};
    this.memeloopVersion = options.memeloopVersion ?? MEMELOOP_PLUGIN_API_VERSION;
    this.activationTimeoutMs = validateTimeout(options.activationTimeoutMs ?? 10_000, 'activationTimeoutMs');
    this.cleanupTimeoutMs = validateTimeout(options.cleanupTimeoutMs ?? 10_000, 'cleanupTimeoutMs');
    this.drainTimeoutMs = validateTimeout(options.drainTimeoutMs ?? 10_000, 'drainTimeoutMs');
    if (valid(this.memeloopVersion) === null) {
      throw new Error(`Invalid memeloop plugin API version: ${this.memeloopVersion}`);
    }
  }

  private validateDeclaredExports(manifest: PluginManifest): void {
    const registration = this.registryManager.getPluginRegistrations(manifest.name);
    const sameSet = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean => left.size === right.size && [...left].every(value => right.has(value));
    const capabilitySets = [
      ['tools', registration?.tools ?? [], manifest.exports?.tools ?? []],
      ['hooks', registration?.hooks.map(hook => hook.type) ?? [], manifest.exports?.hooks ?? []],
      ['agentProfiles', registration?.agentProfiles ?? [], manifest.exports?.agentProfiles ?? []],
      ['loopDefinitions', registration?.loopDefinitions ?? [], manifest.exports?.loopDefinitions ?? []],
      ['loopProfiles', registration?.loopProfiles ?? [], manifest.exports?.loopProfiles ?? []],
      ['loopPlugins', registration?.loopPlugins ?? [], manifest.exports?.loopPlugins ?? []],
      ['modelProviders', registration?.modelProviders ?? [], manifest.exports?.modelProviders ?? []],
    ] as const;
    const mismatch = capabilitySets.find(([, actual, declared]) => !sameSet(new Set(actual), new Set(declared)));
    if (mismatch) {
      const [capability, actual, declared] = mismatch;
      throw new Error(
        `Plugin exports do not match registrations: ${manifest.name} ` +
          `(capability: ${capability}; declared: ${declared.join(', ') || 'none'}; ` +
          `registered: ${actual.join(', ') || 'none'})`,
      );
    }
  }

  async loadPluginModule(options: LoadPluginModuleOptions): Promise<LoadedPlugin | null> {
    const { manifest, module, apiOptions, source = '' } = options;
    const validManifest = validatePluginManifest(manifest);
    if (!validManifest) return null;
    if (!module || typeof module.activate !== 'function') return null;
    if (module.name !== validManifest.name) return null;
    if (
      validManifest.minMemeloopVersion &&
      !satisfies(
        this.memeloopVersion,
        valid(validManifest.minMemeloopVersion)
          ? `>=${validManifest.minMemeloopVersion}`
          : validManifest.minMemeloopVersion,
        { includePrerelease: true },
      )
    ) {
      throw new Error(
        `Plugin ${validManifest.name} requires memeloop ${validManifest.minMemeloopVersion}; ` +
          `runtime is ${this.memeloopVersion}`,
      );
    }

    if (this.loadedPlugins.has(validManifest.name) || this.loadingPlugins.has(validManifest.name)) {
      throw new Error(`Plugin is already loaded: ${validManifest.name}`);
    }

    this.loadingPlugins.add(validManifest.name);
    const api = this.registryManager.createPluginAPI({
      ...this.apiOptions,
      ...apiOptions,
      pluginName: validManifest.name,
    });
    try {
      let cleanup: PluginCleanup | undefined;
      const activation = Promise.resolve().then(() => module.activate(api));
      try {
        const activatedCleanup = await withLifecycleTimeout(
          activation,
          this.activationTimeoutMs,
          'activate',
          validManifest.name,
        );
        cleanup = typeof activatedCleanup === 'function' ? activatedCleanup : undefined;
        this.validateDeclaredExports(validManifest);
        if (!this.registryManager.activatePluginRegistrations(validManifest.name)) {
          throw new Error(`Plugin activation could not be committed: ${validManifest.name}`);
        }
      } catch (activationError) {
        this.registryManager.suspendPluginRegistrations(validManifest.name);
        if (activationError instanceof PluginLifecycleTimeoutError) {
          // activate() cannot be forcibly cancelled. Close its API immediately,
          // and dispose a cleanup callback if the late activation eventually
          // returns one.
          void activation.then(
            lateCleanup => {
              if (typeof lateCleanup !== 'function') return;
              void withLifecycleTimeout(
                Promise.resolve().then(() => lateCleanup()),
                this.cleanupTimeoutMs,
                'cleanup',
                validManifest.name,
              ).catch(() => undefined);
            },
            () => undefined,
          );
        }
        const rollbackErrors: unknown[] = [activationError];
        try {
          this.registryManager.detachPluginRegistrations(validManifest.name);
        } catch (detachError) {
          rollbackErrors.push(detachError);
        }
        try {
          await withLifecycleTimeout(
            this.registryManager.drainPluginRegistrations(validManifest.name),
            this.drainTimeoutMs,
            'drain',
            validManifest.name,
          );
        } catch (drainError) {
          rollbackErrors.push(drainError);
        }
        if (cleanup) {
          try {
            await withLifecycleTimeout(
              Promise.resolve().then(() => cleanup?.()),
              this.cleanupTimeoutMs,
              'cleanup',
              validManifest.name,
            );
          } catch (cleanupError) {
            rollbackErrors.push(cleanupError);
          }
        }
        try {
          if (!this.registryManager.finalizePluginRegistrations(validManifest.name)) {
            throw new Error(`Plugin activation rollback could not be finalized: ${validManifest.name}`);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length > 1) {
          throw new AggregateError(
            rollbackErrors,
            `Plugin activation failed and rollback was incomplete: ${validManifest.name}`,
            { cause: activationError },
          );
        }
        throw activationError;
      }
      const info = loadedPluginInfo(validManifest, source);
      const loaded: LoadedPluginHandle = {
        info,
        module,
        cleanup,
        unloading: false,
      };
      this.loadedPlugins.set(validManifest.name, loaded);
      return info;
    } finally {
      this.loadingPlugins.delete(validManifest.name);
    }
  }

  async loadPluginModules(plugins: LoadPluginModuleOptions[]): Promise<LoadedPlugin[]> {
    const loaded: LoadedPlugin[] = [];
    try {
      for (const plugin of plugins) {
        const result = await this.loadPluginModule(plugin);
        if (result) loaded.push(result);
      }
      return loaded;
    } catch (error) {
      const rollbackErrors: unknown[] = [error];
      for (const plugin of [...loaded].reverse()) {
        try {
          await this.unloadPlugin(plugin.manifest.name);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 1) {
        throw new AggregateError(rollbackErrors, 'Plugin batch failed and rollback was incomplete', {
          cause: error,
        });
      }
      throw error;
    }
  }

  async unloadPlugin(name: string): Promise<boolean> {
    const loaded = this.loadedPlugins.get(name);
    if (!loaded) return false;
    if (loaded.unloading) {
      throw new PluginLifecycleTimeoutError('drain', name);
    }
    loaded.unloading = true;

    const errors: unknown[] = [];
    this.registryManager.suspendPluginRegistrations(name);
    try {
      this.registryManager.detachPluginRegistrations(name);
    } catch (error) {
      errors.push(error);
    }
    try {
      await withLifecycleTimeout(
        this.registryManager.drainPluginRegistrations(name),
        this.drainTimeoutMs,
        'drain',
        name,
      );
    } catch (error) {
      if (error instanceof PluginLifecycleTimeoutError) {
        this.scheduleQuarantinedCleanup(name, loaded);
        throw error;
      }
      errors.push(error);
    }
    try {
      try {
        if (loaded.cleanup) {
          await withLifecycleTimeout(
            Promise.resolve().then(() => loaded.cleanup?.()),
            this.cleanupTimeoutMs,
            'cleanup',
            name,
          );
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        this.registryManager.finalizePluginRegistrations(name);
      } catch (error) {
        errors.push(error);
      }
    } finally {
      this.loadedPlugins.delete(name);
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `Plugin cleanup failed: ${name}`);
    }
    return true;
  }

  listPlugins(): LoadedPlugin[] {
    return Array.from(this.loadedPlugins.values(), loaded => loaded.info);
  }

  getLoadedPlugin(name: string): LoadedPlugin | undefined {
    const loaded = this.loadedPlugins.get(name);
    return loaded?.info;
  }

  isPluginLoaded(name: string): boolean {
    return this.loadedPlugins.has(name);
  }

  async unloadAllPlugins(): Promise<void> {
    const errors: unknown[] = [];
    for (const name of [...this.loadedPlugins.keys()]) {
      try {
        await this.unloadPlugin(name);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more plugins failed to unload');
    }
  }

  private scheduleQuarantinedCleanup(name: string, loaded: LoadedPluginHandle): void {
    void this.registryManager.drainPluginRegistrations(name).then(async () => {
      try {
        if (loaded.cleanup) {
          await withLifecycleTimeout(
            Promise.resolve().then(() => loaded.cleanup?.()),
            this.cleanupTimeoutMs,
            'cleanup',
            name,
          );
        }
      } catch (cleanupError) {
        this.apiOptions.logger?.error?.(
          '[plugin] quarantined cleanup failed',
          {
            pluginName: name,
            error: safeErrorMessageFromUnknown(cleanupError, { fallback: 'plugin cleanup failed' }),
          },
        );
      } finally {
        this.registryManager.finalizePluginRegistrations(name);
        if (this.loadedPlugins.get(name) === loaded) this.loadedPlugins.delete(name);
      }
    }, () => undefined);
  }
}

function loadedPluginInfo(manifest: PluginManifest, source: string): LoadedPlugin {
  const exports_ = manifest.exports
    ? Object.freeze({
      tools: manifest.exports.tools ? Object.freeze([...manifest.exports.tools]) : undefined,
      hooks: manifest.exports.hooks ? Object.freeze([...manifest.exports.hooks]) : undefined,
      agentProfiles: manifest.exports.agentProfiles
        ? Object.freeze([...manifest.exports.agentProfiles])
        : undefined,
      loopDefinitions: manifest.exports.loopDefinitions
        ? Object.freeze([...manifest.exports.loopDefinitions])
        : undefined,
      loopProfiles: manifest.exports.loopProfiles
        ? Object.freeze([...manifest.exports.loopProfiles])
        : undefined,
      loopPlugins: manifest.exports.loopPlugins
        ? Object.freeze([...manifest.exports.loopPlugins])
        : undefined,
      modelProviders: manifest.exports.modelProviders
        ? Object.freeze([...manifest.exports.modelProviders])
        : undefined,
    })
    : undefined;
  return Object.freeze({
    manifest: Object.freeze({ ...manifest, exports: exports_ }),
    source,
    loadedAt: new Date().toISOString(),
  });
}
