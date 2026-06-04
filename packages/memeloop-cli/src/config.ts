/**
 * YAML config: nodeSecret, providers, tools, wiki path.
 */

import yaml from "js-yaml";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentDefinition, IMPlatformType } from "../../memeloop/src/protocol/index.js";
import { resolveInputSecretPlaceholder } from "./auth/authStore.js";

/** YAML 中的 Agent 定义片段（缺省字段在 normalize 时补齐）。 */
export type AgentDefinitionYaml = Partial<Omit<AgentDefinition, "id">> & { id: string };

export function normalizeAgentDefinition(raw: AgentDefinitionYaml): AgentDefinition {
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    description: raw.description ?? "",
    systemPrompt: raw.systemPrompt ?? "",
    tools: Array.isArray(raw.tools) ? raw.tools : [],
    modelConfig: raw.modelConfig,
    promptSchema: raw.promptSchema,
    agentFrameworkConfig: raw.agentFrameworkConfig,
    version: raw.version ?? "1",
  };
}

export interface ProviderModelEntry {
  name: string;
  limit?: { context?: number; output?: number };
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
  models?: Record<string, ProviderModelEntry>;
}

function resolveInterpolatedString(value: string): string {
  // VS Code-style env interpolation: ${env:VAR_NAME}
  const envMatch = value.match(/^\$\{env:([^}]+)\}$/);
  if (envMatch) {
    return process.env[envMatch[1]] ?? "";
  }

  // VS Code-style input secret interpolation: ${input:chat.lm.secret.xxx}
  const secret = resolveInputSecretPlaceholder(value);
  if (typeof secret === "string") {
    return secret;
  }

  return value;
}

function resolveProviderInterpolation(provider: ProviderEntry): ProviderEntry {
  const next: ProviderEntry = { ...provider };

  if (typeof next.apiKey === "string") {
    next.apiKey = resolveInterpolatedString(next.apiKey);
  }

  if (next.options && typeof next.options === "object") {
    const opts = { ...next.options } as Record<string, unknown>;
    if (typeof opts.apiKey === "string") {
      opts.apiKey = resolveInterpolatedString(opts.apiKey);
    }
    next.options = opts;
  }

  return next;
}

export interface ToolPermissionConfig {
  allowlist?: string[];
  blocklist?: string[];
}

export interface LanPinStateConfig {
  failCount?: number;
  nextAllowedAt?: number;
}

export interface WsAuthConfig {
  /** Enable/disable WebSocket auth handshake. Defaults to true. */
  enabled?: boolean;
  /** Auth mode. Currently only 'lan-pin' is supported. */
  mode?: "lan-pin";
  /** One-time LAN PIN for pairing. */
  pin?: string;
}

export interface AuthConfig {
  ws?: WsAuthConfig;
  /** Mutable LAN PIN rate limit state. Safe for Agent to edit/reset. */
  lanPinState?: LanPinStateConfig;
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
  /** Cloud node secret (after OTP register). */
  nodeSecret?: string;
  /** Cloud API base URL (e.g. https://api.memeloop.com). */
  cloudUrl?: string;
  /** Node ID (set after OTP register). */
  nodeId?: string;
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
  /** Auth configuration including WS handshake and LAN PIN state. */
  auth?: AuthConfig;
  /** IM 平台 Webhook（/im/webhook/<channelId>） */
  im?: { channels?: ImChannelYaml[] };
  /** `remoteAgent` 等待远端流式输出的超时（毫秒），默认 30000 */
  remoteAgentStreamTimeoutMs?: number;
  /** 暴露给 `memeloop.agent.getDefinitions` 的本地 Agent 定义 */
  agents?: AgentDefinitionYaml[];
}

const DEFAULT_CONFIG_PATH = "memeloop-cli.yaml";

export function getDefaultConfigPath(cwd = process.cwd()): string {
  return path.join(cwd, DEFAULT_CONFIG_PATH);
}

export function loadConfig(configPath?: string): NodeConfig {
  const candidates = configPath
    ? [configPath]
    : [getDefaultConfigPath(), getHomeConfigPath()];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      const data = yaml.load(raw);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const cfg = data as NodeConfig;
        if (Array.isArray(cfg.providers)) {
          cfg.providers = cfg.providers.map(resolveProviderInterpolation);
        }
        return cfg;
      }
    }
  }
  return {};
}

/** Get home directory config path: ~/memeloop-cli.yaml */
export function getHomeConfigPath(): string {
  return path.join(os.homedir(), "memeloop-cli.yaml");
}

export function saveConfig(config: NodeConfig, configPath?: string): void {
  const p = configPath ?? getDefaultConfigPath();
  const raw = yaml.dump(config, { indent: 2 });
  fs.writeFileSync(p, raw, "utf-8");
}
