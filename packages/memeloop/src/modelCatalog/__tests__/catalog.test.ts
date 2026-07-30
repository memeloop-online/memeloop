import { describe, expect, it, vi } from 'vitest';

import { fetchModelCatalog, mergeDiscoveredModelIds, normalizeModelsDevelopmentCatalog, parseModelCatalog } from '../catalog.js';
import { EMBEDDED_MODEL_CATALOG } from '../embeddedCatalog.generated.js';

const fixture = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    npm: '@ai-sdk/openai',
    env: ['OPENAI_API_KEY'],
    models: {
      'gpt-test': {
        id: 'gpt-test',
        name: 'GPT Test',
        attachment: true,
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 128_000, output: 16_000 },
      },
    },
  },
};

describe('model catalog', () => {
  it('ships a valid last-known-good catalog snapshot', () => {
    const catalog = parseModelCatalog(EMBEDDED_MODEL_CATALOG);
    expect(catalog.providers.length).toBeGreaterThan(100);
    expect(catalog.providers.reduce((total, provider) => total + provider.models.length, 0)).toBeGreaterThan(1000);
  });

  it('normalizes provider metadata and exact model capabilities', () => {
    const catalog = normalizeModelsDevelopmentCatalog(fixture, {
      catalogVersion: 'fixture-v1',
      fetchedAt: '2026-07-30T00:00:00.000Z',
    });
    expect(catalog.providers[0]).toMatchObject({
      id: 'openai',
      npm: '@ai-sdk/openai',
      models: [
        {
          id: 'gpt-test',
          attachment: true,
          reasoning: true,
          toolCall: true,
          limit: { context: 128_000, output: 16_000 },
        },
      ],
    });
  });

  it('enriches discovered ids only by exact id and preserves unknown models', () => {
    const provider = normalizeModelsDevelopmentCatalog(fixture, {
      catalogVersion: 'fixture-v1',
      fetchedAt: '2026-07-30T00:00:00.000Z',
    }).providers[0];
    expect(mergeDiscoveredModelIds(provider, ['gpt-test', 'gpt-test-preview', 'gpt-test'])).toEqual(
      [
        expect.objectContaining({ id: 'gpt-test', reasoning: true }),
        expect.objectContaining({ id: 'gpt-test-preview', reasoning: false }),
      ],
    );
  });

  it('rejects oversized responses before parsing', async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(JSON.stringify(fixture), {
          status: 200,
          headers: { 'content-length': '1000' },
        }),
    );
    await expect(
      fetchModelCatalog({ fetch: fetchImplementation as typeof fetch, maxBytes: 100 }),
    ).rejects.toThrow('size limit');
  });

  it('stops reading a chunked response after the size limit', async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(80));
              controller.enqueue(new Uint8Array(80));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    await expect(
      fetchModelCatalog({ fetch: fetchImplementation as typeof fetch, maxBytes: 100 }),
    ).rejects.toThrow('size limit');
  });

  it('rejects empty or malformed catalogs', () => {
    expect(() =>
      normalizeModelsDevelopmentCatalog(
        {},
        {
          catalogVersion: 'fixture-v1',
          fetchedAt: '2026-07-30T00:00:00.000Z',
        },
      )
    ).toThrow('no valid providers');
    expect(() =>
      parseModelCatalog({
        schemaVersion: 1,
        source: 'https://attacker.invalid/catalog.json',
        catalogVersion: 'v1',
        fetchedAt: '2026-07-30T00:00:00.000Z',
        providers: [],
      })
    ).toThrow('Untrusted');
  });
});
