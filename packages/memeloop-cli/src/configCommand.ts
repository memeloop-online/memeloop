/**
 * config.ts — Config management command
 *
 * 对标 Claude Code /config + OpenCode auth.json 管理
 *
 * Usage:
 *   memeloop config show        — print current config
 *   memeloop config path        — show config file paths
 *   memeloop config auth set <provider> <key>  — store API key in auth.json
 *   memeloop config auth list   — list providers with stored keys (masked)
 *   memeloop config init        — create default config from template
 */

// This module provides only the action implementations; CLI wiring is in cli.ts
export { showConfig, showConfigPath, setAuthKey, listAuthKeys, initConfig };

import { loadConfig, getDefaultConfigPath, getHomeConfigPath } from "../config.js";
import { loadAuth, setApiKey, getAuthPath } from "../auth/authStore.js";

export async function showConfig(): Promise<void> {
  const config = loadConfig();
  // Print config without secrets
  const safe = { ...config };
  if (safe.providers) {
    safe.providers = safe.providers.map((p) => {
      const { apiKey, ...rest } = p as Record<string, unknown>;
      return rest;
    });
  }
  console.log(JSON.stringify(safe, null, 2));
}

export async function showConfigPath(): Promise<void> {
  console.log("Config search paths (first found wins):");
  console.log(`  1. CWD:           ${getDefaultConfigPath()}`);
  console.log(`  2. Home:          ${getHomeConfigPath()}`);
  console.log(`  Auth file:        ${getAuthPath()}`);
}

export async function setAuthKey(provider: string, key: string): Promise<void> {
  setApiKey(provider, key);
  console.log(`API key for "${provider}" saved to ${getAuthPath()}`);
}

export async function listAuthKeys(): Promise<void> {
  const auth = loadAuth();
  const entries = Object.entries(auth);
  if (entries.length === 0) {
    console.log("No API keys stored.");
    console.log(`Use "memeloop config auth set <provider> <key>" to add one.`);
    return;
  }
  console.log("Stored API keys:");
  for (const [provider, entry] of entries) {
    const masked = entry.key.slice(0, 8) + "..." + entry.key.slice(-4);
    console.log(`  ${provider}: ${masked}`);
  }
}

export async function initConfig(): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const homePath = getHomeConfigPath();

  if (fs.existsSync(homePath)) {
    console.log(`Config already exists at ${homePath}`);
    console.log("Use --force to overwrite.");
    return;
  }

  const template = `# MemeLoop CLI Configuration
# See https://github.com/linonetwo/memeloop for docs

# LLM Providers (API keys stored separately in ~/.local/share/memeloop/auth.json)
providers:
  # Example: OpenAI-compatible provider
  # - name: "Westlake HPC"
  #   options:
  #     baseURL: "https://hpc-api.westlake.edu.cn/v1"
  #   models:
  #     deepseek:
  #       name: "DeepSeek V4 Pro"
  #       limit:
  #         context: 128000
  #         output: 65536

# Node identity
# nodeId: ""
# name: "my-node"

# Tool file access
# fileBaseDir: "/home/user/projects"

auth:
  ws:
    enabled: true
    mode: lan-pin
`;

  const dir = path.dirname(homePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(homePath, template, "utf-8");
  console.log(`Created config template at ${homePath}`);
  console.log(`Set API keys with: memeloop config auth set <provider> <key>`);
}
