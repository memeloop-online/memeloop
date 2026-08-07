/**
 * YAML config: providers, tools, wiki path, and device network settings.
 */

import yaml from 'js-yaml';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentDefinition, IMPlatformType } from 'memeloop';
import { resolveInputSecretPlaceholder } from './auth/authStore.js';

/** YAML 中的 Agent 定义片段（缺省字段在 normalize 时补齐）。 */
export type AgentDefinitionYaml = Partial<Omit<AgentDefinition, 'id'>> & { id: string };

export function normalizeAgentDefinition(raw: AgentDefinitionYaml): AgentDefinition {
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    description: raw.description ?? '',
    systemPrompt: raw.systemPrompt ?? '',
    tools: Array.isArray(raw.tools) ? raw.tools : [],
    modelConfig: raw.modelConfig,
    promptSchema: raw.promptSchema,
    agentFrameworkConfig: raw.agentFrameworkConfig,
    version: raw.version ?? '1',
  };
}

export interface ProviderModelEntry {
  /** Required when models are written as a YAML array; omitted for map entries. */
  id?: string;
  name: string;
  limit?: { context?: number; output?: number };
  /** OpenAI-compatible wire API used by this model. Chat Completions is the default. */
  apiMode?: 'chat-completions' | 'responses';
  /** Explicit spelling retained for programmatic hosts. */
  openAIApiMode?: 'chat-completions' | 'responses';
  /** Default generation bounds/settings. A request may explicitly override these. */
  maxInputTokens?: number;
  maxOutputTokens?: number;
  topP?: number;
  modelOptions?: Record<string, unknown>;
  providerOptions?: Record<string, Record<string, unknown>>;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Capability metadata used by configuration UIs and schedulers. */
  toolCalling?: boolean;
  vision?: boolean;
  thinking?: boolean;
  supportsReasoningEffort?: Array<'minimal' | 'low' | 'medium' | 'high'>;
  reasoningEffortFormat?: 'chat-completions' | 'responses';
}

export type ProviderModelsConfig =
  | Record<string, ProviderModelEntry>
  | Array<ProviderModelEntry & { id: string }>;

/** Normalize both the historic model map and the richer YAML array form. */
export function normalizeProviderModels(
  models: ProviderModelsConfig | undefined,
): Record<string, ProviderModelEntry> {
  if (!models) return {};
  if (!Array.isArray(models)) return { ...models };
  const normalized: Record<string, ProviderModelEntry> = {};
  for (const model of models) {
    const id = model.id?.trim();
    if (!id) throw new Error('provider model array entries require a non-empty id');
    if (normalized[id]) throw new Error(`duplicate provider model id: ${id}`);
    normalized[id] = { ...model, id };
  }
  return normalized;
}

export interface ProviderEntry {
  /** npm package name (e.g. @ai-sdk/openai-compatible) */
  npm?: string;
  /** Provider display name */
  name: string;
  /** API base URL */
  baseUrl?: string;
  /** API key */
  apiKey?: string;
  /** Provider-specific options (e.g. baseURL override) */
  options?: Record<string, unknown>;
  /** Available models */
  models?: ProviderModelsConfig;
}

function resolveInterpolatedString(value: string): string {
  // VS Code-style env interpolation: ${env:VAR_NAME}
  const environmentMatch = value.match(/^\$\{env:([^}]+)\}$/);
  if (environmentMatch) {
    return process.env[environmentMatch[1]] ?? '';
  }

  // VS Code-style input secret interpolation: ${input:chat.lm.secret.xxx}
  const secret = resolveInputSecretPlaceholder(value);
  if (typeof secret === 'string') {
    return secret;
  }

  return value;
}

function resolveProviderInterpolation(provider: ProviderEntry): ProviderEntry {
  const next: ProviderEntry = { ...provider };

  if (typeof next.apiKey === 'string') {
    next.apiKey = resolveInterpolatedString(next.apiKey);
  }

  if (next.options && typeof next.options === 'object') {
    const options = { ...next.options } as Record<string, unknown>;
    if (typeof options.apiKey === 'string') {
      options.apiKey = resolveInterpolatedString(options.apiKey);
    }
    next.options = options;
  }

  return next;
}

export interface ToolPermissionConfig {
  allowlist?: string[];
  blocklist?: string[];
}

export interface McpServerEntry {
  name: string;
  command: string;
  args?: string[];
}

/** IM Webhook channel（写入 memeloop-cli.yaml） */
export interface ImChannelYaml {
  channelId: string;
  platform: IMPlatformType;
  botToken: string;
  /** Telegram: setWebhook 时配置的 secret_token */
  webhookSecret?: string;
  /** Discord: Application Public Key (hex)，用于后续 Ed25519 验签 */
  discordPublicKey?: string;
  /** 飞书：事件订阅 Verification Token（请求体或头校验） */
  larkVerificationToken?: string;
  /** 飞书：事件加密密钥（启用「加密」时解密 `encrypt` 字段；与开放平台配置一致） */
  larkEncryptKey?: string;
  /** 企业微信：回调 URL 校验 token */
  wecomToken?: string;
  /** 企业微信：EncodingAESKey（43 字符，启用密文模式时解密） */
  wecomEncodingAesKey?: string;
  /** 企业微信：企业 ID（解密后校验消息尾部的 receiveid，可选但建议配置） */
  wecomCorpId?: string;
  defaultDefinitionId?: string;
}

export interface NodeConfig {
  /** Cloud API base URL (e.g. https://api.memeloop.com). */
  cloudUrl?: string;
  /** User access token for device directory registration. */
  cloudAccessToken?: string;
  /** LLM providers (name, baseUrl, apiKey). */
  providers?: ProviderEntry[];
  /** Tool permission: allowlist / blocklist. */
  tools?: ToolPermissionConfig;
  /** Wiki storage path (local knowledge base). */
  wikiPath?: string;
  /** Base directory exposed to file.* tools. */
  fileBaseDir?: string;
  /** 从哪些 wiki 子目录加载带 MemeLoop AgentDefinition 标签的 tiddler（默认 ["default"]，与 wiki.* 工具 wikiId 一致） */
  wikiAgentDefinitionWikiIds?: string[];
  /** Node display name. */
  name?: string;
  /** Local MCP servers (name + command to start). */
  mcpServers?: McpServerEntry[];
  /** IM 平台 Webhook（/im/webhook/<channelId>） */
  im?: { channels?: ImChannelYaml[] };
  /** `remoteAgent` 等待远端流式输出的超时（毫秒），默认 30000 */
  remoteAgentStreamTimeoutMs?: number;
  /** 暴露给 `memeloop.agent.getDefinitions` 的本地 Agent 定义 */
  agents?: AgentDefinitionYaml[];
}

const DEFAULT_CONFIG_PATH = 'memeloop-cli.yaml';

export function getCloudAccessTokenSecretId(baseUrl: string): string {
  const origin = new URL(baseUrl).origin;
  const originHash = createHash('sha256').update(origin).digest('hex').slice(0, 24);
  return `memeloop.cloud.access-token.${originHash}`;
}

export function getDefaultConfigPath(cwd = process.cwd()): string {
  return path.join(cwd, DEFAULT_CONFIG_PATH);
}

export function loadRawConfig(configPath?: string): NodeConfig {
  const candidates = configPath ? [configPath] : [getDefaultConfigPath(), getHomeConfigPath()];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      const data = yaml.load(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return data as NodeConfig;
      }
    }
  }
  return {};
}

/** Load runtime configuration with environment and secret placeholders resolved. */
export function loadConfig(configPath?: string): NodeConfig {
  const cfg = loadRawConfig(configPath);
  if (Array.isArray(cfg.providers)) {
    cfg.providers = cfg.providers.map(resolveProviderInterpolation);
  }
  if (typeof cfg.cloudAccessToken === 'string') {
    const expectedPlaceholder = cfg.cloudUrl
      ? `\${input:${getCloudAccessTokenSecretId(cfg.cloudUrl)}}`
      : undefined;
    cfg.cloudAccessToken = expectedPlaceholder && cfg.cloudAccessToken === expectedPlaceholder
      ? (resolveInputSecretPlaceholder(cfg.cloudAccessToken) ?? '')
      : (cfg.cloudAccessToken.startsWith('${') ? '' : cfg.cloudAccessToken);
  }
  return cfg;
}

/** Get home directory config path: ~/memeloop-cli.yaml */
export function getHomeConfigPath(): string {
  return path.join(os.homedir(), 'memeloop-cli.yaml');
}

export function saveConfig(config: NodeConfig, configPath?: string): void {
  const p = configPath ?? getDefaultConfigPath();
  const raw = yaml.dump(config, { indent: 2 });
  fs.writeFileSync(p, raw, { encoding: 'utf-8', mode: 0o600 });
  fs.chmodSync(p, 0o600);
}
