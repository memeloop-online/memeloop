import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveModelCatalog } from '../catalogStore.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('model catalog store', () => {
  it('atomically caches a valid remote catalog and reuses it without a request', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-catalog-'));
    temporaryDirectories.push(directory);
    const cachePath = path.join(directory, 'catalog.json');
    const payload = {
      demo: {
        id: 'demo',
        name: 'Demo',
        env: [],
        models: {
          model: {
            id: 'model',
            name: 'Model',
            attachment: false,
            reasoning: false,
            tool_call: true,
          },
        },
      },
    };
    const first = await resolveModelCatalog({
      cachePath,
      fetch: async () => new Response(JSON.stringify(payload), { status: 200, headers: { etag: '"v1"' } }),
    });
    expect(first.source).toBe('remote');
    expect(fs.statSync(cachePath).mode & 0o777).toBe(0o600);

    const second = await resolveModelCatalog({
      cachePath,
      fetch: async () => {
        throw new Error('must not fetch');
      },
    });
    expect(second.source).toBe('cache');
    expect(second.catalog.catalogVersion).toBe('v1');
  });

  it('falls back to the embedded snapshot when refresh fails', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-catalog-'));
    temporaryDirectories.push(directory);
    const result = await resolveModelCatalog({
      cachePath: path.join(directory, 'missing.json'),
      fetch: async () => {
        throw new Error('offline');
      },
    });
    expect(result.source).toBe('embedded');
    expect(result.refreshError).toBe('model_catalog_refresh_failed');
    expect(result.catalog.providers.length).toBeGreaterThan(100);
  });
});
