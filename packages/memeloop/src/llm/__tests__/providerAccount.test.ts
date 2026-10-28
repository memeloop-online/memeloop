import { describe, expect, it } from 'vitest';

import { normalizeProviderAccountConfig, normalizeProviderAccountSettings } from '../providerAccount.js';
import { MAX_PROVIDER_MODEL_ROUTES } from '../providerRegistry.js';

function route(modelId = 'friendly-model', wireModelId = 'vendor/model:v2') {
  return { modelId, wireModelId, apiMode: 'responses' as const };
}

function catalogProvider(id = '提供方2') {
  return {
    id,
    name: 'Provider metadata',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.example.test/v1',
    doc: 'https://docs.example.test',
    env: ['PROVIDER_API_KEY'],
    models: [{
      id: 'vendor/model:v2',
      name: 'Vendor Model V2',
      attachment: true,
      reasoning: true,
      toolCall: true,
      structuredOutput: true,
      temperature: false,
      releaseDate: '2026-08',
      lastUpdated: '2026-08-31',
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 1_000_000, output: 128_000 },
    }],
  };
}

describe('normalizeProviderAccountConfig', () => {
  it.each(['0provider', '提供方2'])('accepts canonical provider id %s', providerId => {
    expect(normalizeProviderAccountConfig({
      providerId,
      providerType: 'openai-compatible',
      baseUrl: 'https://cpa.example.test/v1',
      secretRef: 'keyring:provider-account',
      enabled: true,
      models: [route()],
    })).toMatchObject({ providerId, providerType: 'openai-compatible' });
  });

  it('keeps logical and wire model identities distinct and orders routes', () => {
    const normalized = normalizeProviderAccountConfig({
      providerId: '提供方2',
      providerType: 'openai-compatible',
      models: [route('z-logical', 'wire/z'), route('a-logical', 'wire/a')],
      catalogProvider: catalogProvider(),
    });

    expect(normalized.models).toEqual([
      route('a-logical', 'wire/a'),
      route('z-logical', 'wire/z'),
    ]);
    expect(normalized.catalogProvider?.id).toBe(normalized.providerId);
    expect(normalized.catalogProvider?.name).toBe('Provider metadata');
    expect(normalized.catalogProvider?.models[0]?.id).toBe('vendor/model:v2');
  });

  it('allows an empty account before model discovery or manual route creation', () => {
    expect(
      normalizeProviderAccountConfig({
        providerId: 'new-provider',
        providerType: 'openai-compatible',
        models: [],
      }).models,
    ).toEqual([]);
  });

  it('uses the same model-route cap as the executable registry', () => {
    const routes = Array.from(
      { length: MAX_PROVIDER_MODEL_ROUTES + 1 },
      (_, index) => route(`logical-${index}`, `wire/${index}`),
    );
    expect(() =>
      normalizeProviderAccountConfig({
        providerId: 'provider',
        providerType: 'custom',
        models: routes,
      })
    ).toThrow(/bounded array/);

    expect(
      normalizeProviderAccountConfig({
        providerId: 'provider',
        providerType: 'custom',
        models: routes.slice(0, MAX_PROVIDER_MODEL_ROUTES),
      }).models,
    ).toHaveLength(MAX_PROVIDER_MODEL_ROUTES);
  });

  it('deeply detaches and freezes routes and exact catalog metadata', () => {
    const source = {
      providerId: '提供方2',
      providerType: 'openai-compatible',
      models: [route()],
      catalogProvider: catalogProvider(),
    };
    const normalized = normalizeProviderAccountConfig(source);

    source.models[0].wireModelId = 'mutated';
    source.catalogProvider.models[0].name = 'mutated';
    source.catalogProvider.models[0].modalities.input.push('audio');

    expect(normalized.models[0]?.wireModelId).toBe('vendor/model:v2');
    expect(normalized.catalogProvider?.models[0]?.name).toBe('Vendor Model V2');
    expect(normalized.catalogProvider?.models[0]?.modalities?.input).toEqual(['text', 'image']);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.models)).toBe(true);
    expect(Object.isFrozen(normalized.models[0])).toBe(true);
    expect(Object.isFrozen(normalized.catalogProvider)).toBe(true);
    expect(Object.isFrozen(normalized.catalogProvider?.models)).toBe(true);
    expect(Object.isFrozen(normalized.catalogProvider?.models[0]?.modalities?.input)).toBe(true);
  });

  it.each([
    'http://provider.example.test/v1',
    'ftp://localhost/v1',
    'https://user:password@provider.example.test/v1',
    '/relative/v1',
  ])('rejects unsafe or invalid baseUrl %s', baseUrl => {
    expect(() =>
      normalizeProviderAccountConfig({
        providerId: 'provider',
        providerType: 'custom',
        baseUrl,
        models: [route()],
      })
    ).toThrow(TypeError);
  });

  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://[::1]:11434/v1',
  ])('allows loopback HTTP development endpoint %s', baseUrl => {
    expect(
      normalizeProviderAccountConfig({
        providerId: 'provider',
        providerType: 'custom',
        baseUrl,
        models: [route()],
      }).baseUrl,
    ).toBe(baseUrl);
  });

  it('rejects unknown account/route/catalog fields and plaintext credentials', () => {
    expect(() =>
      normalizeProviderAccountConfig({
        providerId: 'provider',
        providerType: 'custom',
        apiKey: 'plaintext',
        models: [route()],
      })
    ).toThrow(/unknown fields/);
    expect(() =>
      normalizeProviderAccountConfig({
        providerId: 'provider',
        providerType: 'custom',
        models: [{ ...route(), displayName: 'local DTO metadata' }],
      })
    ).toThrow(/unknown fields/);
    expect(() =>
      normalizeProviderAccountConfig({
        providerId: 'provider',
        providerType: 'custom',
        models: [route()],
        catalogProvider: { ...catalogProvider('provider'), uiColor: 'red' },
      })
    ).toThrow(/unknown fields/);
  });

  it('rejects accessors, exotic records, symbols, and sparse arrays without invoking them', () => {
    let getterCalls = 0;
    const accessorAccount = {
      providerType: 'custom',
      models: [route()],
      get providerId() {
        getterCalls += 1;
        return 'provider';
      },
    };
    expect(() => normalizeProviderAccountConfig(accessorAccount)).toThrow(/accessor/);
    expect(getterCalls).toBe(0);

    const exotic = Object.assign(Object.create({ inherited: true }), {
      providerId: 'provider',
      providerType: 'custom',
      models: [route()],
    });
    expect(() => normalizeProviderAccountConfig(exotic)).toThrow(/exotic/);

    const symbolAccount = {
      providerId: 'provider',
      providerType: 'custom',
      models: [route()],
      [Symbol('hidden')]: true,
    };
    expect(() => normalizeProviderAccountConfig(symbolAccount)).toThrow(/symbol/);

    const sparseRoutes = new Array(2);
    sparseRoutes[1] = route();
    expect(() =>
      normalizeProviderAccountConfig({
        providerId: 'provider',
        providerType: 'custom',
        models: sparseRoutes,
      })
    ).toThrow(/sparse/);
  });

  it('rejects invalid or ambiguous routes and mismatched catalog identity', () => {
    expect(() =>
      normalizeProviderAccountConfig({
        providerId: 'provider',
        providerType: 'custom',
        models: [route(), route('friendly-model', 'different-wire')],
      })
    ).toThrow(/unique/);
    expect(() =>
      normalizeProviderAccountConfig({
        providerId: 'provider',
        providerType: 'custom',
        models: [{ ...route(), apiMode: 'legacy-chat' }],
      })
    ).toThrow(/apiMode/);
    expect(() =>
      normalizeProviderAccountConfig({
        providerId: 'provider',
        providerType: 'custom',
        models: [route()],
        catalogProvider: catalogProvider('different-provider'),
      })
    ).toThrow(/must equal providerId/);
  });

  it.each([
    {
      field: 'provider URL credentials',
      mutate: (provider: ReturnType<typeof catalogProvider>) => {
        provider.api = 'https://user:password@api.example.test/v1';
      },
    },
    {
      field: 'duplicate environment names',
      mutate: (provider: ReturnType<typeof catalogProvider>) => {
        provider.env = ['PROVIDER_API_KEY', 'PROVIDER_API_KEY'];
      },
    },
    {
      field: 'unsupported modality',
      mutate: (provider: ReturnType<typeof catalogProvider>) => {
        provider.models[0].modalities.input = ['binary'];
      },
    },
    {
      field: 'invalid release date',
      mutate: (provider: ReturnType<typeof catalogProvider>) => {
        provider.models[0].releaseDate = 'August 2026';
      },
    },
    {
      field: 'non-boolean capability',
      mutate: (provider: ReturnType<typeof catalogProvider>) => {
        Object.assign(provider.models[0], { toolCall: 'yes' });
      },
    },
    {
      field: 'negative token limit',
      mutate: (provider: ReturnType<typeof catalogProvider>) => {
        provider.models[0].limit.output = -1;
      },
    },
  ])('rejects catalog metadata with $field', ({ mutate }) => {
    const provider = catalogProvider();
    mutate(provider);
    expect(() => {
      normalizeProviderAccountConfig({
        providerId: provider.id,
        providerType: 'openai-compatible',
        models: [route()],
        catalogProvider: provider,
      });
    }).toThrow(TypeError);
  });

  it('rejects invalid ids and bounded provider data', () => {
    expect(() =>
      normalizeProviderAccountConfig({
        providerId: 'provider/name',
        providerType: 'custom',
        models: [route()],
      })
    ).toThrow(/providerId/);
    expect(() =>
      normalizeProviderAccountConfig({
        providerId: 'provider',
        providerType: `x${'y'.repeat(512)}`,
        models: [route()],
      })
    ).toThrow(/providerType/);
    expect(() =>
      normalizeProviderAccountConfig({
        providerId: 'provider',
        providerType: 'custom',
        secretRef: 'contains space',
        models: [route()],
      })
    ).toThrow(/secretRef/);
  });
});

describe('normalizeProviderAccountSettings', () => {
  it('accepts empty accounts and empty model assignments', () => {
    const normalized = normalizeProviderAccountSettings({
      accounts: [],
      modelAssignments: {},
    });
    expect(normalized).toEqual({ accounts: [], modelAssignments: {} });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.accounts)).toBe(true);
    expect(Object.isFrozen(normalized.modelAssignments)).toBe(true);
  });

  it('deeply detaches and freezes accounts and canonical model assignments', () => {
    const source = {
      accounts: [{
        providerId: '提供方2',
        providerType: 'openai-compatible',
        models: [route()],
        catalogProvider: catalogProvider(),
      }],
      modelAssignments: {
        default: {
          providerId: '提供方2',
          modelId: 'friendly-model',
          parameters: { temperature: 0.2, reasoningEffort: 'high' as const },
        },
      },
    };
    const normalized = normalizeProviderAccountSettings(source);

    source.accounts[0].models[0].wireModelId = 'mutated';
    source.modelAssignments.default.parameters.temperature = 1;
    expect(normalized.accounts[0]?.models[0]?.wireModelId).toBe('vendor/model:v2');
    expect(normalized.modelAssignments.default?.parameters?.temperature).toBe(0.2);
    expect(Object.isFrozen(normalized.accounts[0])).toBe(true);
    expect(Object.isFrozen(normalized.modelAssignments.default)).toBe(true);
    expect(Object.isFrozen(normalized.modelAssignments.default?.parameters)).toBe(true);
  });

  it('rejects duplicate provider account ids', () => {
    expect(() =>
      normalizeProviderAccountSettings({
        accounts: [
          { providerId: '0provider', providerType: 'custom', models: [route()] },
          { providerId: '0provider', providerType: 'other', models: [route()] },
        ],
        modelAssignments: {},
      })
    ).toThrow(/providerId values must be unique/);
  });

  it('rejects model assignments whose canonical account or logical route does not exist', () => {
    expect(() => {
      normalizeProviderAccountSettings({
        accounts: [],
        modelAssignments: { default: { providerId: 'missing', modelId: 'model' } },
      });
    }).toThrow(/unknown providerId/);
    expect(() => {
      normalizeProviderAccountSettings({
        accounts: [{ providerId: 'provider', providerType: 'custom', models: [route()] }],
        modelAssignments: { default: { providerId: 'provider', modelId: 'missing' } },
      });
    }).toThrow(/unknown modelId/);
  });

  it('rejects unknown fields, accessors, and exotic nested values before reading them', () => {
    expect(() =>
      normalizeProviderAccountSettings({
        accounts: [],
        modelAssignments: {},
        legacyProviders: [],
      })
    ).toThrow(/unknown fields/);

    let getterCalls = 0;
    const settings = {
      accounts: [],
      get modelAssignments() {
        getterCalls += 1;
        return {};
      },
    };
    expect(() => normalizeProviderAccountSettings(settings)).toThrow(/accessor/);
    expect(getterCalls).toBe(0);

    expect(() =>
      normalizeProviderAccountSettings({
        accounts: [],
        modelAssignments: Object.create({ default: undefined }),
      })
    ).toThrow(/exotic/);
  });

  it('rejects missing fields and invalid canonical model assignments', () => {
    expect(() =>
      normalizeProviderAccountSettings({
        modelAssignments: {},
      })
    ).toThrow(/accounts/);
    expect(() =>
      normalizeProviderAccountSettings({
        accounts: [],
        modelAssignments: { default: { provider: 'old', model: 'old' } },
      })
    ).toThrow(/modelConfig/);
  });
});
