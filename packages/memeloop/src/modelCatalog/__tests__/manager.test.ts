import { describe, expect, it, vi } from 'vitest';

import { MemoryModelCatalogCache, type ModelCatalogCache, ModelCatalogManager } from '../manager.js';
import { MODEL_CATALOG_SCHEMA_VERSION, MODEL_CATALOG_SOURCE_URL, type ModelCatalog } from '../types.js';

function catalog(version: string, fetchedAt: number): ModelCatalog {
  return {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    source: MODEL_CATALOG_SOURCE_URL,
    catalogVersion: version,
    fetchedAt: new Date(fetchedAt).toISOString(),
    providers: [{
      id: 'demo',
      name: 'Demo',
      env: [],
      models: [{
        id: 'known',
        name: 'Known model',
        attachment: true,
        reasoning: true,
        toolCall: true,
      }],
    }],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ModelCatalogManager', () => {
  it('uses a fresh host cache without fetching', async () => {
    const now = Date.parse('2026-08-24T00:00:00.000Z');
    const cache = new MemoryModelCatalogCache();
    const cacheWrite = cache.prepareSave(
      catalog('cache-v1', now - 1_000),
      new AbortController().signal,
    );
    await cacheWrite.commit(new AbortController().signal);
    const fetchCatalog = vi.fn();
    const manager = new ModelCatalogManager({ cache, fetchCatalog, now: () => now });

    await expect(manager.resolve()).resolves.toMatchObject({
      source: 'cache',
      stale: false,
      catalog: { catalogVersion: 'cache-v1' },
    });
    expect(fetchCatalog).not.toHaveBeenCalled();
  });

  it('returns stale data immediately and single-flights background refresh', async () => {
    const now = Date.parse('2026-08-24T00:00:00.000Z');
    const cache = new MemoryModelCatalogCache();
    const cacheWrite = cache.prepareSave(
      catalog('stale-v1', now - 25 * 60 * 60 * 1_000),
      new AbortController().signal,
    );
    await cacheWrite.commit(new AbortController().signal);
    const remote = deferred<ModelCatalog>();
    const fetchCatalog = vi.fn(() => remote.promise);
    const manager = new ModelCatalogManager({ cache, fetchCatalog, now: () => now });

    const first = await manager.resolve();
    const second = await manager.resolve();
    expect(first).toMatchObject({ source: 'cache', stale: true, refreshing: true });
    expect(second).toMatchObject({ source: 'cache', stale: true, refreshing: true });
    expect(fetchCatalog).toHaveBeenCalledOnce();

    const awaitedRefresh = manager.refresh();
    remote.resolve(catalog('remote-v2', now));
    await expect(awaitedRefresh).resolves.toMatchObject({
      source: 'remote',
      stale: false,
      catalog: { catalogVersion: 'remote-v2' },
    });
    await expect(manager.resolve()).resolves.toMatchObject({
      source: 'cache',
      stale: false,
      catalog: { catalogVersion: 'remote-v2' },
    });
  });

  it('awaits an explicit refresh and falls back to embedded data on failure', async () => {
    const embedded = catalog('embedded-v1', 1);
    const manager = new ModelCatalogManager({
      embeddedCatalog: embedded,
      fetchCatalog: async () => {
        throw new Error('offline');
      },
    });

    await expect(manager.refresh()).resolves.toMatchObject({
      source: 'embedded',
      stale: true,
      refreshError: 'model_catalog_refresh_failed',
      catalog: { catalogVersion: 'embedded-v1' },
    });
  });

  it('aborts an invalidated generation before it can save', async () => {
    const firstRemote = deferred<ModelCatalog>();
    const prepareSave = vi.fn(() => ({ commit: vi.fn(), discard: vi.fn() }));
    const cache: ModelCatalogCache = {
      load: vi.fn(),
      prepareSave,
    };
    const fetchCatalog = vi.fn()
      .mockImplementationOnce(() => firstRemote.promise)
      .mockResolvedValueOnce(catalog('new-generation', 2));
    const manager = new ModelCatalogManager({
      cache,
      embeddedCatalog: catalog('embedded', 1),
      fetchCatalog,
    });
    const oldGeneration = manager.refresh();
    await vi.waitFor(() => {
      expect(fetchCatalog).toHaveBeenCalledOnce();
    });
    manager.invalidate(new Error('configuration changed'));
    firstRemote.resolve(catalog('must-not-save', 2));

    await expect(oldGeneration).rejects.toThrow('configuration changed');
    expect(prepareSave).not.toHaveBeenCalled();
    await expect(manager.refresh()).resolves.toMatchObject({
      catalog: { catalogVersion: 'new-generation' },
    });
    await vi.waitFor(() => {
      expect(prepareSave).toHaveBeenCalledOnce();
    });
  });

  it('lets one caller cancel its wait without cancelling the shared refresh', async () => {
    const remote = deferred<ModelCatalog>();
    const manager = new ModelCatalogManager({
      embeddedCatalog: catalog('embedded', 1),
      fetchCatalog: () => remote.promise,
    });
    const caller = new AbortController();
    const cancelledWait = manager.refresh(caller.signal);
    const survivingWait = manager.refresh();
    caller.abort(new Error('caller left'));

    await expect(cancelledWait).rejects.toThrow('caller left');
    remote.resolve(catalog('remote', Date.now()));
    await expect(survivingWait).resolves.toMatchObject({
      catalog: { catalogVersion: 'remote' },
    });
  });

  it('enriches explicit account discovery through a credential-free host hook', async () => {
    const discoverProviderModels = vi.fn(async () => [{
      providerId: 'demo',
      modelIds: ['known', 'manual'],
    }]);
    const manager = new ModelCatalogManager({
      embeddedCatalog: catalog('embedded', Date.now()),
      fetchCatalog: async () => catalog('remote', Date.now()),
      discoverProviderModels,
    });

    await expect(manager.discoverAccountModels({ providerIds: ['demo'] })).resolves.toEqual([{
      providerId: 'demo',
      models: [
        expect.objectContaining({ id: 'known', reasoning: true }),
        expect.objectContaining({ id: 'manual', reasoning: false }),
      ],
    }]);
    expect(discoverProviderModels).toHaveBeenCalledWith(expect.objectContaining({
      providerIds: ['demo'],
      signal: expect.any(AbortSignal),
    }));
  });

  it('bounds hung load/fetch/save/discovery hooks with safe error codes', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => undefined);
      const errors: Array<{ operation: string; message: string }> = [];
      const manager = new ModelCatalogManager({
        cache: { load: () => never, prepareSave: () => never },
        embeddedCatalog: catalog('embedded', Date.now()),
        fetchCatalog: () => never,
        discoverProviderModels: () => never,
        stageTimeoutMs: { load: 10, refresh: 10, save: 10, discover: 10 },
        onError: (operation, error) =>
          errors.push({
            operation,
            message: error instanceof Error ? error.message : String(error),
          }),
      });
      const refresh = manager.refresh();
      const refreshAssertion = expect(refresh).resolves.toMatchObject({
        source: 'embedded',
        refreshError: 'model_catalog_cache_load_and_refresh_failed',
      });
      await vi.advanceTimersByTimeAsync(21);
      await refreshAssertion;

      const discovery = manager.discoverAccountModels();
      const discoveryAssertion = expect(discovery).rejects.toThrow('model_catalog_discover_timeout');
      await vi.advanceTimersByTimeAsync(11);
      await discoveryAssertion;
      expect(errors.every(entry => !entry.message.includes('secret'))).toBe(true);
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns remote data without awaiting a hung best-effort save', async () => {
    const never = new Promise<never>(() => undefined);
    const manager = new ModelCatalogManager({
      cache: { load: () => undefined, prepareSave: () => never },
      embeddedCatalog: catalog('embedded', Date.now()),
      fetchCatalog: async () => catalog('remote', Date.now()),
      stageTimeoutMs: { save: 10 },
    });
    await expect(manager.refresh()).resolves.toMatchObject({
      source: 'remote',
      catalog: { catalogVersion: 'remote' },
    });
    manager.dispose();
  });

  it('isolates throwing observers and exposes only stable redacted errors', async () => {
    const observed: Array<{ operation: string; name: string; message: string }> = [];
    const manager = new ModelCatalogManager({
      cache: {
        load: () => {
          throw new Error('load secret=alpha');
        },
        prepareSave: () => ({ commit: () => undefined, discard: () => undefined }),
      },
      embeddedCatalog: catalog('embedded', Date.now()),
      fetchCatalog: () => {
        throw new Error('refresh secret=beta');
      },
      onError: (operation, error) => {
        observed.push({ operation, name: error.name, message: error.message });
        throw new Error('observer must be isolated');
      },
    });

    await expect(manager.refresh()).resolves.toMatchObject({
      source: 'embedded',
      refreshError: 'model_catalog_cache_load_and_refresh_failed',
    });
    expect(observed).toEqual([
      {
        operation: 'load',
        name: 'ModelCatalogOperationError',
        message: 'model_catalog_cache_load_failed',
      },
      {
        operation: 'refresh',
        name: 'ModelCatalogOperationError',
        message: 'model_catalog_refresh_failed',
      },
    ]);
    expect(JSON.stringify(observed)).not.toMatch(/secret|alpha|beta/u);
  });

  it('discards a late old-generation stage after the new generation commits', async () => {
    const oldStage = deferred<{
      commit(signal: AbortSignal): void;
      discard(): void;
    }>();
    let published = 'none';
    const discarded: string[] = [];
    const prepareSave = vi.fn((value: ModelCatalog) => {
      if (value.catalogVersion === 'old') return oldStage.promise;
      return {
        commit: () => {
          published = value.catalogVersion;
        },
        discard: () => {
          discarded.push(value.catalogVersion);
        },
      };
    });
    const fetchCatalog = vi.fn()
      .mockResolvedValueOnce(catalog('old', Date.now()))
      .mockResolvedValueOnce(catalog('new', Date.now()));
    const manager = new ModelCatalogManager({
      cache: { load: () => undefined, prepareSave },
      embeddedCatalog: catalog('embedded', 1),
      fetchCatalog,
    });

    await manager.refresh();
    await vi.waitFor(() => {
      expect(prepareSave).toHaveBeenCalledOnce();
    });
    manager.invalidate();
    await manager.refresh();
    await vi.waitFor(() => {
      expect(published).toBe('new');
    });

    oldStage.resolve({
      commit: () => {
        published = 'old';
      },
      discard: () => {
        discarded.push('old');
      },
    });
    await vi.waitFor(() => {
      expect(discarded).toContain('old');
    });
    expect(published).toBe('new');
  });

  it('serializes a signal-ignoring old commit before the new generation commit', async () => {
    const releaseOldCommit = deferred<undefined>();
    let published = 'none';
    const commits: string[] = [];
    const manager = new ModelCatalogManager({
      cache: {
        load: () => undefined,
        prepareSave: (value) => ({
          commit: async () => {
            commits.push(value.catalogVersion);
            if (value.catalogVersion === 'old') await releaseOldCommit.promise;
            published = value.catalogVersion;
          },
          discard: () => undefined,
        }),
      },
      embeddedCatalog: catalog('embedded', 1),
      fetchCatalog: vi.fn()
        .mockResolvedValueOnce(catalog('old', Date.now()))
        .mockResolvedValueOnce(catalog('new', Date.now())),
    });

    await manager.refresh();
    await vi.waitFor(() => {
      expect(commits).toEqual(['old']);
    });
    manager.invalidate();
    await manager.refresh();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(commits).toEqual(['old']);

    releaseOldCommit.resolve(undefined);
    await manager.flushCacheWrites();
    expect(commits).toEqual(['old', 'new']);
    expect(published).toBe('new');
  });

  it('rejects duplicate/unsafe provider filters before account discovery', async () => {
    const discoverProviderModels = vi.fn();
    const manager = new ModelCatalogManager({
      embeddedCatalog: catalog('embedded', Date.now()),
      discoverProviderModels,
    });
    await expect(manager.discoverAccountModels({ providerIds: ['demo', 'demo'] }))
      .rejects.toThrow('duplicate');
    await expect(manager.discoverAccountModels({ providerIds: ['bad\nid'] }))
      .rejects.toThrow('invalid');
    expect(discoverProviderModels).not.toHaveBeenCalled();
  });
});
