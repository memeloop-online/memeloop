import { EMBEDDED_MODEL_CATALOG, type ModelCatalog, type ModelCatalogProvider } from 'memeloop/model-catalog';

import { resolveModelCatalog } from './catalogStore.js';

export interface PresetModel {
  id: string;
  name: string;
  context: number;
  output: number;
}

export interface PresetProvider {
  name: string;
  baseUrl: string;
  description: string;
  descriptionZh: string;
  apiKeyLink: string;
  models: PresetModel[];
}

const PRESET_PROVIDER_IDS = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'alibaba',
  'zhipuai',
  'moonshotai',
  'siliconflow',
  'openrouter',
  'groq',
] as const;

const PROVIDER_OVERRIDES: Record<
  string,
  { baseUrl?: string; apiKeyLink?: string; descriptionZh?: string }
> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKeyLink: 'https://platform.openai.com/api-keys',
    descriptionZh: 'OpenAI 官方 API',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyLink: 'https://console.anthropic.com/settings/keys',
    descriptionZh: 'Anthropic Claude API',
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyLink: 'https://aistudio.google.com/apikey',
    descriptionZh: 'Google Gemini API',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyLink: 'https://platform.deepseek.com/api_keys',
    descriptionZh: 'DeepSeek API',
  },
  alibaba: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyLink: 'https://bailian.console.aliyun.com/?apiKey=1',
    descriptionZh: '阿里通义千问 API',
  },
  zhipuai: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyLink: 'https://open.bigmodel.cn/usercenter/apikeys',
    descriptionZh: '智谱 AI GLM API',
  },
  moonshotai: {
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyLink: 'https://platform.moonshot.cn/console/api-keys',
    descriptionZh: '月之暗面 Kimi API',
  },
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyLink: 'https://cloud.siliconflow.cn/account/ak',
    descriptionZh: '硅基流动多模型 API',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyLink: 'https://openrouter.ai/keys',
    descriptionZh: 'OpenRouter 多模型网关',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyLink: 'https://console.groq.com/keys',
    descriptionZh: 'Groq 高速推理 API',
  },
};

const PINNED_MODEL_IDS: Record<string, string[]> = {
  openai: ['gpt-4o'],
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function newestModels(provider: ModelCatalogProvider): PresetModel[] {
  const candidates = provider.models
    .filter((model) => model.status !== 'deprecated')
    .sort(
      (left, right) =>
        compareCodeUnits(
          right.lastUpdated ?? right.releaseDate ?? '',
          left.lastUpdated ?? left.releaseDate ?? '',
        ) || compareCodeUnits(left.id, right.id),
    );
  const modelsById = new Map(candidates.map((model) => [model.id, model]));
  const selected = [
    ...(PINNED_MODEL_IDS[provider.id] ?? []).flatMap((id) => {
      const model = modelsById.get(id);
      return model ? [model] : [];
    }),
    ...candidates,
  ];
  return [...new Map(selected.map((model) => [model.id, model])).values()]
    .slice(0, 16)
    .map((model) => ({
      id: model.id,
      name: model.name,
      context: model.limit?.context ?? 0,
      output: model.limit?.output ?? 0,
    }));
}

function catalogToPresets(catalog: ModelCatalog): PresetProvider[] {
  const providersById = new Map(catalog.providers.map((provider) => [provider.id, provider]));
  return PRESET_PROVIDER_IDS.flatMap((id) => {
    const provider = providersById.get(id);
    if (!provider) return [];
    const overrides = PROVIDER_OVERRIDES[id] ?? {};
    return [
      {
        name: provider.name,
        baseUrl: overrides.baseUrl ?? provider.api ?? '',
        description: `${provider.name} model catalog (${catalog.fetchedAt.slice(0, 10)})`,
        descriptionZh: overrides.descriptionZh ?? `${provider.name} 模型目录`,
        apiKeyLink: overrides.apiKeyLink ?? provider.doc ?? '',
        models: newestModels(provider),
      },
    ];
  });
}

export function loadPresets(): PresetProvider[] {
  return catalogToPresets(EMBEDDED_MODEL_CATALOG);
}

export async function loadResolvedPresets(): Promise<{
  presets: PresetProvider[];
  source: 'remote' | 'cache' | 'embedded';
  refreshError?: string;
}> {
  const resolved = await resolveModelCatalog();
  return {
    presets: catalogToPresets(resolved.catalog),
    source: resolved.source,
    ...(resolved.refreshError ? { refreshError: resolved.refreshError } : {}),
  };
}

export function findPreset(name: string): PresetProvider | undefined {
  const lower = name.trim().toLowerCase();
  if (lower === '') return undefined;
  return loadPresets().find((provider) => provider.name.toLowerCase() === lower);
}
