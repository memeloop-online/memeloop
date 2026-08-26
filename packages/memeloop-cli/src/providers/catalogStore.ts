import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  type ModelCatalog,
  type ModelCatalogCache,
  ModelCatalogManager,
  type ModelCatalogManagerOptions,
  parseModelCatalog,
  type PreparedModelCatalogCacheWrite,
} from 'memeloop/model-catalog';

export interface ResolveModelCatalogOptions {
  cachePath?: string;
  maxAgeMs?: number;
  refresh?: boolean;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export interface ResolvedModelCatalog {
  catalog: ModelCatalog;
  source: 'remote' | 'cache' | 'embedded';
  refreshError?: string;
}

export function getDefaultModelCatalogCachePath(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'memeloop', 'model-catalog.v1.json');
}

export function loadCachedModelCatalog(
  cachePath = getDefaultModelCatalogCachePath(),
): ModelCatalog | undefined {
  try {
    return parseModelCatalog(JSON.parse(fs.readFileSync(cachePath, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

function stageCachedModelCatalog(catalog: ModelCatalog, cachePath: string): string {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(catalog)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return temporaryPath;
}

export class FileModelCatalogCache implements ModelCatalogCache {
  constructor(private readonly cachePath = getDefaultModelCatalogCachePath()) {}

  public load(signal: AbortSignal): ModelCatalog | undefined {
    signal.throwIfAborted();
    return loadCachedModelCatalog(this.cachePath);
  }

  public prepareSave(
    catalog: ModelCatalog,
    signal: AbortSignal,
  ): PreparedModelCatalogCacheWrite {
    signal.throwIfAborted();
    const temporaryPath = stageCachedModelCatalog(catalog, this.cachePath);
    let active = true;
    return {
      commit: (commitSignal) => {
        commitSignal.throwIfAborted();
        if (!active) return;
        active = false;
        fs.renameSync(temporaryPath, this.cachePath);
      },
      discard: () => {
        if (!active) return;
        active = false;
        try {
          fs.unlinkSync(temporaryPath);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      },
    };
  }
}

export function createFileModelCatalogManager(
  options: Omit<ModelCatalogManagerOptions, 'cache'> & { cachePath?: string } = {},
): ModelCatalogManager {
  const { cachePath, ...managerOptions } = options;
  return new ModelCatalogManager({
    ...managerOptions,
    cache: new FileModelCatalogCache(cachePath),
  });
}

export async function resolveModelCatalog(
  options: ResolveModelCatalogOptions = {},
): Promise<ResolvedModelCatalog> {
  const cachePath = options.cachePath ?? getDefaultModelCatalogCachePath();
  const manager = createFileModelCatalogManager({
    cachePath,
    fetch: options.fetch,
    maxAgeMs: options.maxAgeMs,
  });
  try {
    const resolution = await manager.resolve({
      forceRefresh: options.refresh,
      signal: options.signal,
      // Preserve this legacy helper's await-refresh behavior. Long-lived hosts
      // should reuse createFileModelCatalogManager() for true SWR/single-flight.
      waitForRefresh: true,
    });
    await manager.flushCacheWrites(options.signal);
    return {
      catalog: resolution.catalog,
      source: resolution.source,
      ...(resolution.refreshError ? { refreshError: resolution.refreshError } : {}),
    };
  } finally {
    manager.dispose();
  }
}
