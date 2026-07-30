import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EMBEDDED_MODEL_CATALOG, fetchModelCatalog, type ModelCatalog, parseModelCatalog } from 'memeloop/model-catalog';

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ResolveModelCatalogOptions {
  cachePath?: string;
  maxAgeMs?: number;
  refresh?: boolean;
  fetch?: typeof globalThis.fetch;
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

function saveCachedModelCatalog(catalog: ModelCatalog, cachePath: string): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(catalog)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, cachePath);
}

export async function resolveModelCatalog(
  options: ResolveModelCatalogOptions = {},
): Promise<ResolvedModelCatalog> {
  const cachePath = options.cachePath ?? getDefaultModelCatalogCachePath();
  const cached = loadCachedModelCatalog(cachePath);
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const shouldRefresh = options.refresh === true || !cached || Date.now() - Date.parse(cached.fetchedAt) >= maxAgeMs;
  if (!shouldRefresh) return { catalog: cached, source: 'cache' };
  try {
    const catalog = await fetchModelCatalog({ fetch: options.fetch });
    saveCachedModelCatalog(catalog, cachePath);
    return { catalog, source: 'remote' };
  } catch (error) {
    return {
      catalog: cached ?? EMBEDDED_MODEL_CATALOG,
      source: cached ? 'cache' : 'embedded',
      refreshError: error instanceof Error ? error.message : String(error),
    };
  }
}
