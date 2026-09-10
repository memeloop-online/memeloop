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
        reasoning_efforts: ['high', 'medium'],
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
          reasoningEfforts: ['medium', 'high'],
          toolCall: true,
          limit: { context: 128_000, output: 16_000 },
        },
      ],
    });
  });

  it('trims upstream provider and model strings before strict validation', () => {
    const catalog = normalizeModelsDevelopmentCatalog({
      openai: {
        ...fixture.openai,
        id: ' openai ',
        name: ' OpenAI ',
        models: {
          'gpt-test': {
            ...fixture.openai.models['gpt-test'],
            id: ' gpt-test ',
            name: ' GPT Test ',
          },
        },
      },
    }, {
      catalogVersion: 'trimmed-v1',
      fetchedAt: '2026-07-30T00:00:00.000Z',
    });

    expect(catalog.providers[0]).toMatchObject({
      id: 'openai',
      name: 'OpenAI',
      models: [{ id: 'gpt-test', name: 'GPT Test' }],
    });
  });

  it('enriches discovered ids only by exact id and preserves unknown models', () => {
    const provider = normalizeModelsDevelopmentCatalog(fixture, {
      catalogVersion: 'fixture-v1',
      fetchedAt: '2026-07-30T00:00:00.000Z',
    }).providers[0];
    expect(mergeDiscoveredModelIds(provider, ['gpt-test', 'gpt-test-preview'])).toEqual(
      [
        expect.objectContaining({ id: 'gpt-test', reasoning: true }),
        expect.objectContaining({ id: 'gpt-test-preview', reasoning: false }),
      ],
    );
    expect(() => mergeDiscoveredModelIds(provider, ['gpt-test', 'gpt-test']))
      .toThrow('duplicates');
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

  it('does not await a defective stream cancellation after maxBytes + 1', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetchImplementation = vi.fn(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(101));
          },
          cancel,
        }),
        { status: 200 },
      )
    );

    await expect(fetchModelCatalog({
      fetch: fetchImplementation as typeof fetch,
      maxBytes: 100,
    })).rejects.toThrow('size limit');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds a custom fetch and pending body read even when they ignore abort', async () => {
    vi.useFakeTimers();
    try {
      const hungFetch = fetchModelCatalog({
        fetch: (() => new Promise<Response>(() => undefined)) as typeof fetch,
        timeoutMs: 10,
      });
      const hungFetchAssertion = expect(hungFetch).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(11);
      await hungFetchAssertion;

      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const hungBody = fetchModelCatalog({
        fetch: (async () => new Response(new ReadableStream({ cancel }))) as typeof fetch,
        timeoutMs: 10,
      });
      const hungBodyAssertion = expect(hungBody).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(11);
      await hungBodyAssertion;
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles one-byte fragmentation with a bounded growing byte buffer', async () => {
    const whitespace = ' '.repeat(16_384);
    const encoded = new TextEncoder().encode(`${whitespace}${JSON.stringify(fixture)}`);
    let offset = 0;
    let pulls = 0;
    const fetchImplementation = vi.fn(async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            if (offset === encoded.byteLength) {
              controller.close();
              return;
            }
            controller.enqueue(encoded.slice(offset, ++offset));
          },
        }),
        { status: 200, headers: { etag: 'fragmented-v1' } },
      )
    );

    await expect(fetchModelCatalog({
      fetch: fetchImplementation as typeof fetch,
      maxBytes: encoded.byteLength,
    })).resolves.toMatchObject({ catalogVersion: 'fragmented-v1' });
    expect(pulls).toBe(encoded.byteLength + 1);
  });

  it('uses a content digest for untagged same-length catalogs', async () => {
    const firstPayload = JSON.stringify(fixture);
    const secondPayload = JSON.stringify({
      ...fixture,
      openai: {
        ...fixture.openai,
        models: {
          'gpt-best': {
            ...fixture.openai.models['gpt-test'],
            id: 'gpt-best',
            name: 'GPT Best',
          },
        },
      },
    });
    expect(firstPayload).toHaveLength(secondPayload.length);
    const fetchPayload = (payload: string) => (async () => new Response(payload, { status: 200 })) as typeof fetch;

    const [first, second] = await Promise.all([
      fetchModelCatalog({ fetch: fetchPayload(firstPayload) }),
      fetchModelCatalog({ fetch: fetchPayload(secondPayload) }),
    ]);
    expect(first.catalogVersion).toMatch(/^[\da-f]{64}$/u);
    expect(second.catalogVersion).toMatch(/^[\da-f]{64}$/u);
    expect(first.catalogVersion).not.toBe(second.catalogVersion);
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

  it('strictly clones/freezes cache data and rejects schema confusion', () => {
    const input = normalizeModelsDevelopmentCatalog(fixture, {
      catalogVersion: 'strict-v1',
      fetchedAt: new Date().toISOString(),
    });
    const mutable = structuredClone(input);
    const parsed = parseModelCatalog(mutable);
    mutable.providers[0].models[0].name = 'mutated';
    expect(parsed.providers[0].models[0].name).toBe('GPT Test');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.providers[0].models)).toBe(true);

    expect(() => parseModelCatalog({ ...structuredClone(input), unknown: true })).toThrow('unknown');
    const duplicateProvider = structuredClone(input);
    duplicateProvider.providers.push(structuredClone(duplicateProvider.providers[0]));
    expect(() => parseModelCatalog(duplicateProvider)).toThrow('Duplicate');
    const unsafeLimit = structuredClone(input);
    unsafeLimit.providers[0].models[0].limit = { context: Number.MAX_VALUE };
    expect(() => parseModelCatalog(unsafeLimit)).toThrow('safe integer');
    const controlId = structuredClone(input);
    controlId.providers[0].id = 'bad\nid';
    expect(() => parseModelCatalog(controlId)).toThrow('provider.id');
  });

  it('exports the embedded catalog as a deeply frozen strict snapshot', () => {
    expect(Object.isFrozen(EMBEDDED_MODEL_CATALOG)).toBe(true);
    expect(Object.isFrozen(EMBEDDED_MODEL_CATALOG.providers)).toBe(true);
    expect(Object.isFrozen(EMBEDDED_MODEL_CATALOG.providers[0]?.models)).toBe(true);
    const firstProvider = EMBEDDED_MODEL_CATALOG.providers[0];
    if (firstProvider === undefined) throw new Error('embedded catalog must contain a provider');
    expect(() => {
      EMBEDDED_MODEL_CATALOG.providers.push(structuredClone(firstProvider));
    }).toThrow();
  });

  it('orders non-ASCII provider and model ids by code units', () => {
    const makeModel = (id: string) => ({
      id,
      name: id,
      attachment: false,
      reasoning: false,
      tool_call: false,
    });
    const input = Object.fromEntries(['中', 'é', 'z', 'a'].map(id => [id, {
      id,
      name: id,
      env: [],
      models: Object.fromEntries(['中', 'é', 'z', 'a'].map(modelId => [
        modelId,
        makeModel(modelId),
      ])),
    }]));
    const catalog = normalizeModelsDevelopmentCatalog(input, {
      catalogVersion: 'ordering-v1',
      fetchedAt: new Date().toISOString(),
    });
    expect(catalog.providers.map(provider => provider.id)).toEqual(['a', 'z', 'é', '中']);
    expect(catalog.providers[0]?.models.map(model => model.id)).toEqual(['a', 'z', 'é', '中']);
  });

  it('rejects a cache timestamp beyond the allowed future skew', () => {
    expect(() =>
      normalizeModelsDevelopmentCatalog(fixture, {
        catalogVersion: 'future-v1',
        fetchedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      })
    ).toThrow('future');
  });
});
