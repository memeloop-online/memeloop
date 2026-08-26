import { fetchModelCatalog, mergeDiscoveredModelIds, parseModelCatalog } from './catalog.js';
import { EMBEDDED_MODEL_CATALOG } from './embeddedCatalog.generated.js';
import type { ModelCatalog, ModelCatalogModel } from './types.js';

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_DISCOVERED_PROVIDERS = 256;
const MAX_DISCOVERED_MODELS_PER_PROVIDER = 10_000;
const MAX_DISCOVERED_ID_CHARACTERS = 1_024;
const MAX_DISCOVERY_PROVIDER_FILTERS = 256;
const textEncoder = new TextEncoder();
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
const DEFAULT_STAGE_TIMEOUTS = {
  load: 5_000,
  refresh: 15_000,
  save: 2_000,
  discover: 30_000,
} as const;

type Awaitable<T> = T | Promise<T>;

/** Host-owned persistence. Core never chooses a filesystem, keychain, or database. */
export interface PreparedModelCatalogCacheWrite {
  /** Publish the staged value. Implementations should make this step atomic. */
  commit(signal: AbortSignal): Awaitable<void>;
  /** Remove staged data without changing the published value. */
  discard(): Awaitable<void>;
}

export interface ModelCatalogCache {
  load(signal: AbortSignal): Awaitable<unknown>;
  /** Stage bytes only. ModelCatalogManager owns the generation-fenced commit. */
  prepareSave(catalog: ModelCatalog, signal: AbortSignal): Awaitable<PreparedModelCatalogCacheWrite>;
}

export class MemoryModelCatalogCache implements ModelCatalogCache {
  private catalog?: ModelCatalog;

  public load(signal: AbortSignal): ModelCatalog | undefined {
    signal.throwIfAborted();
    return this.catalog;
  }

  public prepareSave(catalog: ModelCatalog, signal: AbortSignal): PreparedModelCatalogCacheWrite {
    signal.throwIfAborted();
    const staged = parseModelCatalog(catalog);
    let active = true;
    return {
      commit: (commitSignal) => {
        commitSignal.throwIfAborted();
        if (!active) return;
        active = false;
        this.catalog = staged;
      },
      discard: () => {
        active = false;
      },
    };
  }
}

export class ModelCatalogOperationError extends Error {
  readonly name = 'ModelCatalogOperationError';

  constructor(
    readonly operation: 'load' | 'refresh' | 'save' | 'discover',
    readonly code: string,
  ) {
    super(code);
  }
}

export type ModelCatalogSource = 'remote' | 'cache' | 'embedded';

export interface ModelCatalogResolution {
  catalog: ModelCatalog;
  source: ModelCatalogSource;
  /** True when this call returned a stale cache or the bundled fallback. */
  stale: boolean;
  /** True only when a single-flight refresh continues in the background. */
  refreshing?: boolean;
  refreshError?: string;
}

export interface ResolveModelCatalogOptions {
  /** Ignore freshness and start a refresh. */
  forceRefresh?: boolean;
  /** Await the refresh instead of immediately returning stale/embedded data. */
  waitForRefresh?: boolean;
  signal?: AbortSignal;
}

export interface ProviderAccountModelIds {
  providerId: string;
  modelIds: readonly string[];
}

export interface DiscoveredProviderModels {
  providerId: string;
  models: ModelCatalogModel[];
}

export type ModelCatalogProviderAccountDiscovery = (input: {
  catalog: ModelCatalog;
  providerIds?: readonly string[];
  signal: AbortSignal;
}) => Awaitable<readonly ProviderAccountModelIds[]>;

export interface ModelCatalogManagerOptions {
  cache?: ModelCatalogCache;
  embeddedCatalog?: ModelCatalog;
  maxAgeMs?: number;
  fetch?: typeof globalThis.fetch;
  fetchCatalog?: (signal: AbortSignal) => Awaitable<ModelCatalog>;
  discoverProviderModels?: ModelCatalogProviderAccountDiscovery;
  now?: () => number;
  stageTimeoutMs?: Partial<Record<'load' | 'refresh' | 'save' | 'discover', number>>;
  onError?: (
    operation: 'load' | 'refresh' | 'save' | 'discover',
    error: ModelCatalogOperationError,
  ) => void;
}

interface RefreshFlight {
  generation: number;
  promise: Promise<ModelCatalogResolution>;
}

/**
 * Portable 24-hour stale-while-revalidate catalog lifecycle.
 *
 * A manager owns one configuration generation. Concurrent refreshes share one
 * request; invalidate()/dispose() abort the old generation before it can save.
 */
export class ModelCatalogManager {
  private readonly embeddedCatalog: ModelCatalog;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly stageTimeoutMs: Record<'load' | 'refresh' | 'save' | 'discover', number>;
  private generation = 0;
  private controller = new AbortController();
  private disposed = false;
  private cacheLoaded = false;
  private cachedCatalog?: ModelCatalog;
  private cacheLoadError?: ModelCatalogOperationError;
  private cacheLoadFlight?: Promise<void>;
  private refreshFlight?: RefreshFlight;
  private readonly cachePreparationFlights = new Set<Promise<void>>();
  /** Raw commit completion, not its timeout race, fences later-generation commits. */
  private cacheCommitTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: ModelCatalogManagerOptions = {}) {
    this.embeddedCatalog = parseModelCatalog(options.embeddedCatalog ?? EMBEDDED_MODEL_CATALOG);
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
    this.stageTimeoutMs = { ...DEFAULT_STAGE_TIMEOUTS, ...options.stageTimeoutMs };
    if (!Number.isFinite(this.maxAgeMs) || this.maxAgeMs < 0) {
      throw new TypeError('model catalog maxAgeMs must be finite and non-negative');
    }
    for (const [stage, timeoutMs] of Object.entries(this.stageTimeoutMs)) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError(`model catalog ${stage} timeout must be positive and finite`);
      }
    }
  }

  public async resolve(
    options: ResolveModelCatalogOptions = {},
  ): Promise<ModelCatalogResolution> {
    this.assertActive();
    options.signal?.throwIfAborted();
    const generation = this.generation;
    const generationSignal = this.controller.signal;
    await awaitWithSignal(this.loadCache(), options.signal);
    this.assertActive();
    generationSignal.throwIfAborted();
    if (generation !== this.generation) throw new Error('model catalog generation changed');
    const cached = this.cachedCatalog;
    const cachedFresh = cached !== undefined && this.isFresh(cached);
    if (cachedFresh && options.forceRefresh !== true) {
      return { catalog: cached, source: 'cache', stale: false };
    }

    const fallback: ModelCatalogResolution = cached
      ? { catalog: cached, source: 'cache', stale: true }
      : { catalog: this.embeddedCatalog, source: 'embedded', stale: true };
    const refresh = this.startRefresh(fallback);
    if (options.waitForRefresh === true) {
      return await awaitWithSignal(refresh, options.signal);
    }
    void refresh.catch(() => undefined);
    return { ...fallback, refreshing: true };
  }

  public refresh(signal?: AbortSignal): Promise<ModelCatalogResolution> {
    return this.resolve({ forceRefresh: true, waitForRefresh: true, signal });
  }

  /** Explicit account discovery: credentials stay captured inside the host hook. */
  public async discoverAccountModels(options: {
    providerIds?: readonly string[];
    signal?: AbortSignal;
  } = {}): Promise<DiscoveredProviderModels[]> {
    this.assertActive();
    validateProviderFilter(options.providerIds);
    const discover = this.options.discoverProviderModels;
    if (!discover) return [];
    const generation = this.generation;
    const resolution = await this.resolve({ signal: options.signal });
    const request = createLinkedSignal(
      this.controller.signal,
      options.signal,
      this.stageTimeoutMs.discover,
      'model_catalog_discover_timeout',
    );
    try {
      const discovered = await raceWithSignal(
        Promise.resolve(discover({
          catalog: resolution.catalog,
          providerIds: options.providerIds ? Object.freeze([...options.providerIds]) : undefined,
          signal: request.signal,
        })),
        request.signal,
      );
      request.signal.throwIfAborted();
      if (generation !== this.generation || this.disposed) {
        throw new Error('model catalog generation changed');
      }
      return normalizeDiscoveredModels(resolution.catalog, discovered);
    } catch (error) {
      this.reportError('discover', 'model_catalog_discover_failed', error);
      throw error;
    } finally {
      request.dispose();
    }
  }

  /** Abort the current generation and force the next call to reload host cache. */
  public invalidate(reason: unknown = new Error('model catalog invalidated')): void {
    this.assertActive();
    this.generation += 1;
    this.controller.abort(reason);
    this.controller = new AbortController();
    this.cacheLoaded = false;
    this.cachedCatalog = undefined;
    this.cacheLoadError = undefined;
    this.cacheLoadFlight = undefined;
    this.refreshFlight = undefined;
  }

  public dispose(reason: unknown = new Error('model catalog manager disposed')): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.controller.abort(reason);
    this.refreshFlight = undefined;
    this.cacheLoadFlight = undefined;
  }

  /** Wait for already-started cache stages and commits without starting new work. */
  public async flushCacheWrites(signal?: AbortSignal): Promise<void> {
    this.assertActive();
    while (this.cachePreparationFlights.size > 0) {
      await awaitWithSignal(
        Promise.all([...this.cachePreparationFlights]).then(() => undefined),
        signal,
      );
    }
    await awaitWithSignal(this.cacheCommitTail, signal);
  }

  private async loadCache(): Promise<void> {
    if (this.cacheLoaded) return;
    if (this.cacheLoadFlight) return this.cacheLoadFlight;
    const generation = this.generation;
    const generationSignal = this.controller.signal;
    const request = createLinkedSignal(
      generationSignal,
      undefined,
      this.stageTimeoutMs.load,
      'model_catalog_load_timeout',
    );
    const signal = request.signal;
    const flight = (async () => {
      try {
        const value = await raceWithSignal(
          Promise.resolve(this.options.cache?.load(signal)),
          signal,
        );
        signal.throwIfAborted();
        if (generation !== this.generation || this.disposed) return;
        this.cachedCatalog = value === undefined ? undefined : parseModelCatalog(value);
      } catch (error) {
        if (generationSignal.aborted) throw abortReason(generationSignal);
        this.cacheLoadError = operationError(
          'load',
          'model_catalog_cache_load_failed',
          error,
        );
        this.report(this.cacheLoadError);
      } finally {
        request.dispose();
        if (generation === this.generation && !this.disposed) this.cacheLoaded = true;
      }
    })();
    const tracked = flight.finally(() => {
      if (this.cacheLoadFlight === tracked) this.cacheLoadFlight = undefined;
    });
    this.cacheLoadFlight = tracked;
    return tracked;
  }

  private startRefresh(fallback: ModelCatalogResolution): Promise<ModelCatalogResolution> {
    const existing = this.refreshFlight;
    if (existing?.generation === this.generation) return existing.promise;
    const generation = this.generation;
    const generationSignal = this.controller.signal;
    const request = createLinkedSignal(
      generationSignal,
      undefined,
      this.stageTimeoutMs.refresh,
      'model_catalog_refresh_timeout',
    );
    const signal = request.signal;
    const promise = (async (): Promise<ModelCatalogResolution> => {
      let catalog: ModelCatalog;
      try {
        catalog = parseModelCatalog(
          await raceWithSignal(
            Promise.resolve(this.fetchCatalog(signal)),
            signal,
          ),
        );
        signal.throwIfAborted();
        if (generation !== this.generation || this.disposed) {
          throw new Error('model catalog generation changed');
        }
      } catch (error) {
        if (generationSignal.aborted) throw abortReason(generationSignal);
        this.reportError('refresh', 'model_catalog_refresh_failed', error);
        return {
          ...fallback,
          refreshError: this.cacheLoadError
            ? 'model_catalog_cache_load_and_refresh_failed'
            : errorCode(error, 'model_catalog_refresh_failed'),
        };
      } finally {
        request.dispose();
      }

      if (generation !== this.generation || this.disposed) {
        throw new Error('model catalog generation changed');
      }
      this.cachedCatalog = catalog;
      this.cacheLoaded = true;
      this.cacheLoadError = undefined;
      this.saveBestEffort(catalog, generation);
      return {
        catalog,
        source: 'remote',
        stale: false,
      };
    })();
    const tracked = promise.finally(() => {
      if (this.refreshFlight?.promise === tracked) this.refreshFlight = undefined;
    });
    this.refreshFlight = { generation, promise: tracked };
    return tracked;
  }

  private fetchCatalog(signal: AbortSignal): Awaitable<ModelCatalog> {
    if (this.options.fetchCatalog) return this.options.fetchCatalog(signal);
    return fetchModelCatalog({ fetch: this.options.fetch, signal });
  }

  private isFresh(catalog: ModelCatalog): boolean {
    const fetchedAt = Date.parse(catalog.fetchedAt);
    const now = this.now();
    return Number.isFinite(fetchedAt) && fetchedAt <= now + 5 * 60_000 && now - fetchedAt < this.maxAgeMs;
  }

  private saveBestEffort(catalog: ModelCatalog, generation: number): void {
    if (!this.options.cache) return;
    const generationSignal = this.controller.signal;
    const prepareRequest = createLinkedSignal(
      generationSignal,
      undefined,
      this.stageTimeoutMs.save,
      'model_catalog_save_timeout',
    );
    const rawPreparation = Promise.resolve(
      this.options.cache.prepareSave(catalog, prepareRequest.signal),
    );
    const preparation = (async () => {
      let prepared: PreparedModelCatalogCacheWrite;
      try {
        prepared = await raceWithSignal(rawPreparation, prepareRequest.signal);
      } catch (error) {
        // A signal-ignoring adapter may finish staging after its deadline. It
        // must never receive commit authority for this abandoned generation.
        void rawPreparation.then(late => this.discardPrepared(late), () => undefined);
        if (generation === this.generation && !this.disposed) {
          this.reportError('save', 'model_catalog_cache_save_failed', error);
        }
        return;
      } finally {
        prepareRequest.dispose();
      }

      if (generation !== this.generation || this.disposed || generationSignal.aborted) {
        await this.discardPrepared(prepared);
        return;
      }
      this.enqueuePreparedCommit(prepared, generation);
    })();
    const tracked = preparation.finally(() => this.cachePreparationFlights.delete(tracked));
    this.cachePreparationFlights.add(tracked);
  }

  private enqueuePreparedCommit(
    prepared: PreparedModelCatalogCacheWrite,
    generation: number,
  ): void {
    const previous = this.cacheCommitTail;
    const operation = previous.catch(() => undefined).then(async () => {
      if (generation !== this.generation || this.disposed) {
        await this.discardPrepared(prepared);
        return;
      }
      const request = createLinkedSignal(
        this.controller.signal,
        undefined,
        this.stageTimeoutMs.save,
        'model_catalog_save_timeout',
      );
      let rawCommit: Promise<void>;
      try {
        rawCommit = Promise.resolve(prepared.commit(request.signal));
      } catch (error) {
        rawCommit = Promise.reject(
          error instanceof Error ? error : new Error('model_catalog_cache_save_failed'),
        );
      }
      // The observable save is bounded, while cacheCommitTail retains the raw
      // completion so an old signal-ignoring commit cannot finish after a new one.
      void raceWithSignal(rawCommit, request.signal).catch((error: unknown) => {
        if (generation === this.generation && !this.disposed) {
          this.reportError('save', 'model_catalog_cache_save_failed', error);
        }
      }).finally(() => {
        request.dispose();
      });
      await rawCommit.catch(() => undefined);
    });
    this.cacheCommitTail = operation.catch(() => undefined);
  }

  private async discardPrepared(prepared: PreparedModelCatalogCacheWrite): Promise<void> {
    try {
      await prepared.discard();
    } catch {
      // Discard is cleanup-only and must not surface or call an error observer.
    }
  }

  private reportError(
    operation: 'load' | 'refresh' | 'save' | 'discover',
    fallbackCode: string,
    error: unknown,
  ): void {
    this.report(operationError(operation, fallbackCode, error));
  }

  private report(error: ModelCatalogOperationError): void {
    try {
      this.options.onError?.(error.operation, error);
    } catch {
      // Observability is non-authoritative and cannot alter catalog behavior.
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('model catalog manager disposed');
  }
}

function normalizeDiscoveredModels(
  catalog: ModelCatalog,
  discovered: unknown,
): DiscoveredProviderModels[] {
  if (!Array.isArray(discovered) || discovered.length > MAX_DISCOVERED_PROVIDERS) {
    throw new Error('provider account discovery exceeds the provider limit');
  }
  const providerById = new Map(catalog.providers.map(provider => [provider.id, provider]));
  const seenProviders = new Set<string>();
  const normalized = discovered.map((entry: unknown) => {
    if (
      !entry || typeof entry !== 'object' || Array.isArray(entry)
    ) throw new Error('provider account discovery returned invalid model ids');
    const record = entry as Record<string, unknown>;
    const providerId = record.providerId;
    const modelIds = record.modelIds;
    if (
      typeof providerId !== 'string' || providerId.length === 0 ||
      providerId.length > MAX_DISCOVERED_ID_CHARACTERS ||
      providerId !== providerId.trim() || hasControlCharacters(providerId) ||
      textEncoder.encode(providerId).byteLength > MAX_DISCOVERED_ID_CHARACTERS ||
      seenProviders.has(providerId) || !Array.isArray(modelIds) ||
      modelIds.length > MAX_DISCOVERED_MODELS_PER_PROVIDER ||
      modelIds.some((id: unknown) =>
        typeof id !== 'string' || id.length === 0 || id.length > MAX_DISCOVERED_ID_CHARACTERS ||
        id !== id.trim() || hasControlCharacters(id) ||
        textEncoder.encode(id).byteLength > MAX_DISCOVERED_ID_CHARACTERS
      )
    ) {
      throw new Error('provider account discovery returned invalid model ids');
    }
    seenProviders.add(providerId);
    return {
      providerId,
      models: mergeDiscoveredModelIds(providerById.get(providerId), modelIds as string[]),
    };
  });
  return Object.freeze(normalized.map(entry => Object.freeze(entry))) as unknown as DiscoveredProviderModels[];
}

function createLinkedSignal(
  generationSignal: AbortSignal,
  callerSignal?: AbortSignal,
  timeoutMs?: number,
  timeoutCode = 'model_catalog_timeout',
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const signals = callerSignal ? [generationSignal, callerSignal] : [generationSignal];
  const listeners = signals.map((signal) => {
    const listener = (): void => {
      controller.abort(signal.reason);
    };
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
    return { signal, listener };
  });
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      controller.abort(new Error(timeoutCode));
    }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
    },
  };
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (completion: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      completion();
    };
    const abort = (): void => {
      finish(() => {
        reject(abortReason(signal));
      });
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      value => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(error instanceof Error ? error : new Error('model catalog operation failed'));
        });
      },
    );
  });
}

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('model catalog operation aborted');
}

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof Error && /^model_catalog_[a-z_]+$/u.test(error.message)) return error.message;
  return fallback;
}

function operationError(
  operation: 'load' | 'refresh' | 'save' | 'discover',
  fallbackCode: string,
  error: unknown,
): ModelCatalogOperationError {
  return new ModelCatalogOperationError(operation, errorCode(error, fallbackCode));
}

function validateProviderFilter(providerIds?: readonly string[]): void {
  if (providerIds === undefined) return;
  if (!Array.isArray(providerIds) || providerIds.length > MAX_DISCOVERY_PROVIDER_FILTERS) {
    throw new TypeError('providerIds exceeds the provider limit');
  }
  const seen = new Set<string>();
  for (const providerId of providerIds) {
    if (
      typeof providerId !== 'string' || providerId.length === 0 ||
      providerId !== providerId.trim() || hasControlCharacters(providerId) ||
      textEncoder.encode(providerId).byteLength > MAX_DISCOVERED_ID_CHARACTERS ||
      seen.has(providerId)
    ) throw new TypeError('providerIds contains an invalid or duplicate provider id');
    seen.add(providerId);
  }
}
