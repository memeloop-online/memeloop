/**
 * authStore.ts — API key management (YAML-backed, stored in dataDir)
 * authStore.ts — API key 管理（YAML 格式，存储在统一数据目录）
 *
 * Design principles / 设计原则：
 * - Keys are separated from config; auth.yaml is not version-controlled
 *   密钥与配置分离，auth.yaml 不纳入版本控制
 * - File permissions 600 (owner-only read/write)
 *   密钥文件权限 600（仅 owner 可读写）
 * - Indexed by provider name; multiple providers share one auth file
 *   按 provider name 索引，多 provider 共享同一密钥文件
 * - Stored in getDataDirectory()/auth.yaml (unified data directory)
 *   存储在 getDataDirectory()/auth.yaml（统一数据目录）
 */
import yaml from 'js-yaml';
import fs from 'node:fs';
import path from 'node:path';

import { getDataDirectory } from '../runtime/dataDirectory.js';

export interface AuthEntry {
  /** "api" | "oauth" */
  type: string;
  /** API key */
  key: string;
}

export type AuthStore = Record<string, AuthEntry>;

/** Get the auth file path (dataDir/auth.yaml). / 获取 auth 文件路径（dataDir/auth.yaml）。 */
export function getAuthPath(): string {
  return path.join(getDataDirectory(), 'auth.yaml');
}

/** Ensure auth directory exists with correct permissions */
function ensureAuthDirectory(authPath: string): void {
  const directory = path.dirname(authPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

/** Load auth store from disk. / 从磁盘加载 auth 存储。 */
export function loadAuth(): AuthStore {
  const authPath = getAuthPath();
  if (!fs.existsSync(authPath)) return {};

  try {
    const raw = fs.readFileSync(authPath, 'utf-8');
    const data = yaml.load(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as AuthStore;
    }
    return {};
  } catch {
    return {};
  }
}

/** Save auth store to disk with 600 permissions. / 保存 auth 存储到磁盘，权限 600。 */
export function saveAuth(auth: AuthStore): void {
  const authPath = getAuthPath();
  ensureAuthDirectory(authPath);
  const raw = yaml.dump(auth, { indent: 2 });
  fs.writeFileSync(authPath, raw, { mode: 0o600, flag: 'w' });
  fs.chmodSync(authPath, 0o600);
}

/** Get API key for a provider by name. / 按 provider 名称获取 API key。 */
export function getApiKey(providerName: string): string | undefined {
  const auth = loadAuth();
  const entry = auth[providerName];
  if (entry && entry.type === 'api') {
    return entry.key;
  }
  return undefined;
}

/**
 * Resolve VS Code-style secret placeholders from auth store.
 * 从 auth 存储解析 VS Code 风格的 secret 占位符。
 *
 * Example supported placeholders / 支持的占位符示例：
 * - ${input:chat.lm.secret.-5886adbd}
 * - ${input:some.secret.id}
 *
 * The secret key used in auth.yaml is the placeholder content after `input:`.
 * auth.yaml 中使用的 secret key 是 `input:` 之后的占位符内容。
 */
export function resolveInputSecretPlaceholder(value: string): string | undefined {
  const m = value.match(/^\$\{input:([^}]+)\}$/);
  if (!m) return undefined;
  const secretId = m[1];
  return getApiKey(secretId);
}

/**
 * Store a secret value by VS Code-style input secret id.
 * 通过 VS Code 风格的 input secret id 存储 secret 值。
 *
 * Example / 示例: setInputSecret("chat.lm.secret.-5886adbd", "sk-...")
 */
export function setInputSecret(secretId: string, key: string): void {
  setApiKey(secretId, key);
}

/** Set API key for a provider. / 设置 provider 的 API key。 */
export function setApiKey(providerName: string, key: string): void {
  const auth = loadAuth();
  auth[providerName] = { type: 'api', key };
  saveAuth(auth);
}
