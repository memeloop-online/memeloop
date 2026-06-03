/**
 * presets.ts — Known provider presets for quick configuration.
 * presets.ts — 知名 Provider 预设，用于快速配置。
 *
 * Presets are embedded as a constant for bundling compatibility.
 * 预设数据作为常量内嵌以保证打包兼容性。
 * See presets.yaml for the human-readable version.
 */

/** A model preset entry. / 模型预设条目。 */
export interface PresetModel {
  id: string;
  name: string;
  context: number;
  output: number;
}

/** A provider preset entry. / Provider 预设条目。 */
export interface PresetProvider {
  name: string;
  baseUrl: string;
  description: string;
  descriptionZh: string;
  apiKeyLink: string;
  models: PresetModel[];
}

const PRESET_DATA: PresetProvider[] = [
  {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    description: "OpenAI official API (GPT-4o, GPT-4.1, o3, o4-mini)",
    descriptionZh: "OpenAI 官方 API",
    apiKeyLink: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-4.1", name: "GPT-4.1", context: 1048576, output: 32768 },
      { id: "gpt-4o", name: "GPT-4o", context: 128000, output: 16384 },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", context: 128000, output: 16384 },
      { id: "o4-mini", name: "o4-mini", context: 200000, output: 100000 },
    ],
  },
  {
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    description: "Anthropic Claude (Opus, Sonnet, Haiku)",
    descriptionZh: "Anthropic Claude API",
    apiKeyLink: "https://console.anthropic.com/settings/keys",
    models: [
      { id: "claude-opus-4-1", name: "Claude Opus 4.1", context: 200000, output: 32000 },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", context: 200000, output: 64000 },
    ],
  },
  {
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    description: "Google Gemini (2.5 Pro, 2.5 Flash)",
    descriptionZh: "Google Gemini API",
    apiKeyLink: "https://aistudio.google.com/apikey",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", context: 1048576, output: 65536 },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", context: 1048576, output: 32768 },
    ],
  },
  {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    description: "DeepSeek (V3, R1)",
    descriptionZh: "DeepSeek API",
    apiKeyLink: "https://platform.deepseek.com/api_keys",
    models: [
      { id: "deepseek-chat", name: "DeepSeek V3", context: 131072, output: 32768 },
      { id: "deepseek-reasoner", name: "DeepSeek R1", context: 131072, output: 32768 },
    ],
  },
  {
    name: "Qwen / Tongyi",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    description: "Alibaba Qwen / Tongyi Qianwen (Qwen3-Max, Qwen-Plus)",
    descriptionZh: "阿里通义千问 API",
    apiKeyLink: "https://bailian.console.aliyun.com/?apiKey=1",
    models: [
      { id: "qwen-max", name: "Qwen3 Max", context: 262144, output: 32768 },
      { id: "qwen-plus", name: "Qwen Plus", context: 131072, output: 12288 },
    ],
  },
  {
    name: "Zhipu / GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    description: "ZhipuAI GLM (GLM-4-Plus, GLM-4-Flash)",
    descriptionZh: "智谱 AI GLM API",
    apiKeyLink: "https://open.bigmodel.cn/usercenter/apikeys",
    models: [
      { id: "glm-4-plus", name: "GLM-4 Plus", context: 128000, output: 4096 },
      { id: "glm-4-flash", name: "GLM-4 Flash", context: 128000, output: 4096 },
    ],
  },
  {
    name: "Moonshot / Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    description: "Moonshot Kimi (kimi-k2)",
    descriptionZh: "月之暗面 Kimi API",
    apiKeyLink: "https://platform.moonshot.cn/console/api-keys",
    models: [
      { id: "kimi-k2", name: "Kimi K2", context: 262144, output: 32768 },
    ],
  },
  {
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    description: "SiliconFlow (DeepSeek, Qwen, GLM, Llama)",
    descriptionZh: "硅基流动 API（多模型聚合）",
    apiKeyLink: "https://cloud.siliconflow.cn/account/ak",
    models: [
      { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3", context: 65536, output: 32768 },
      { id: "Qwen/Qwen3-235B-A22B", name: "Qwen3 235B", context: 32768, output: 8192 },
    ],
  },
  {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    description: "OpenRouter (multi-provider gateway)",
    descriptionZh: "OpenRouter 多模型网关",
    apiKeyLink: "https://openrouter.ai/keys",
    models: [
      { id: "openai/gpt-4o", name: "GPT-4o (OpenRouter)", context: 128000, output: 16384 },
      { id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5 (OpenRouter)", context: 200000, output: 64000 },
    ],
  },
  {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    description: "Groq (Llama 4, fast inference)",
    descriptionZh: "Groq API（高速推理）",
    apiKeyLink: "https://console.groq.com/keys",
    models: [
      { id: "meta-llama/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout", context: 131072, output: 32768 },
    ],
  },
];

/** Load presets (always returns the embedded data). / 加载预设（始终返回内嵌数据）。 */
export function loadPresets(): PresetProvider[] {
  return PRESET_DATA;
}

/** Find a preset by name (case-insensitive). / 按名称查找预设（忽略大小写）。 */
export function findPreset(name: string): PresetProvider | undefined {
  const lower = name.toLowerCase();
  return PRESET_DATA.find((p) => p.name.toLowerCase() === lower);
}
