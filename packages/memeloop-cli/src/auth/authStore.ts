/**
 * auth.ts — 密钥管理（对标 OpenCode ~/.local/share/opencode/auth.json）
 *
 * 设计原则：
 * - 密钥与配置分离，auth.json 不纳入版本控制
 * - 密钥文件权限 600（仅 owner 可读写）
 * - 按 provider name 索引，多 provider 共享同一密钥文件
 * - XDG 数据目录 ~/.local/share/memeloop/auth.json
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AuthEntry {
  /** "api" | "oauth" */
  type: string;
  /** API key */
  key: string;
}

export type AuthStore = Record<string, AuthEntry>;

/** Get the auth file path (~/.local/share/memeloop/auth.json) */
export function getAuthPath(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "memeloop", "auth.json");
}

/** Ensure auth directory exists with correct permissions */
function ensureAuthDir(authPath: string): void {
  const dir = path.dirname(authPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Load auth store from disk */
export function loadAuth(): AuthStore {
  const authPath = getAuthPath();
  if (!fs.existsSync(authPath)) return {};

  try {
    const raw = fs.readFileSync(authPath, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as AuthStore;
    }
    return {};
  } catch {
    return {};
  }
}

/** Save auth store to disk with 600 permissions */
export function saveAuth(auth: AuthStore): void {
  const authPath = getAuthPath();
  ensureAuthDir(authPath);
  const raw = JSON.stringify(auth, null, 2);
  fs.writeFileSync(authPath, raw, { mode: 0o600, flag: "w" });
}

/** Get API key for a provider by name */
export function getApiKey(providerName: string): string | undefined {
  const auth = loadAuth();
  const entry = auth[providerName];
  if (entry && entry.type === "api") {
    return entry.key;
  }
  return undefined;
}

/**
 * Resolve VS Code-style secret placeholders from auth store.
 * Example supported placeholders:
 * - ${input:chat.lm.secret.-5886adbd}
 * - ${input:some.secret.id}
 *
 * The secret key used in auth.json is the placeholder content after `input:`.
 */
export function resolveInputSecretPlaceholder(value: string): string | undefined {
  const m = value.match(/^\$\{input:([^}]+)\}$/);
  if (!m) return undefined;
  const secretId = m[1];
  return getApiKey(secretId);
}

/**
 * Store a secret value by VS Code-style input secret id.
 * Example: setInputSecret("chat.lm.secret.-5886adbd", "sk-...")
 */
export function setInputSecret(secretId: string, key: string): void {
  setApiKey(secretId, key);
}

/** Set API key for a provider */
export function setApiKey(providerName: string, key: string): void {
  const auth = loadAuth();
  auth[providerName] = { type: "api", key };
  saveAuth(auth);
}
