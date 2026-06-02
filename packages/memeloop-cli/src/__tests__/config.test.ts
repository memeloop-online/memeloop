import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getDefaultConfigPath,
  loadConfig,
  normalizeAgentDefinition,
  saveConfig,
} from "../config";
import { getAuthPath, loadAuth, saveAuth } from "../auth/authStore";

describe("config", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("returns default config path under cwd", () => {
    const p = getDefaultConfigPath("/tmp/abc");
    expect(p).toBe(path.join("/tmp/abc", "memeloop-cli.yaml"));
  });

  it("loads empty config when file does not exist", () => {
    const p = path.join(os.tmpdir(), `missing-${Date.now()}.yaml`);
    expect(loadConfig(p)).toEqual({});
  });

  it("saves and loads yaml config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memeloop-cli-config-"));
    tmpDirs.push(dir);
    const p = path.join(dir, "memeloop-cli.yaml");
    const data = {
      name: "node-a",
      cloudUrl: "https://cloud.example.com",
      providers: [{ name: "x", baseUrl: "https://api.example.com" }],
      auth: { ws: { enabled: true, mode: "lan-pin" as const, pin: "123456" } },
    };
    saveConfig(data, p);
    const loaded = loadConfig(p);
    expect(loaded.name).toBe("node-a");
    expect(loaded.cloudUrl).toBe("https://cloud.example.com");
    expect(loaded.auth?.ws?.pin).toBe("123456");
  });

  it("returns empty config when yaml root is not object", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memeloop-cli-config-"));
    tmpDirs.push(dir);
    const p = path.join(dir, "memeloop-cli.yaml");
    fs.writeFileSync(p, "- a\n- b\n", "utf8");
    expect(loadConfig(p)).toEqual({});
  });

  it("normalizes agent definition defaults", () => {
    const normalized = normalizeAgentDefinition({ id: "agent-x" });
    expect(normalized).toEqual({
      id: "agent-x",
      name: "agent-x",
      description: "",
      systemPrompt: "",
      tools: [],
      modelConfig: undefined,
      promptSchema: undefined,
      agentFrameworkConfig: undefined,
      version: "1",
    });
  });

  it("resolves ${env:...} interpolation for provider apiKey", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memeloop-cli-config-"));
    tmpDirs.push(dir);
    const p = path.join(dir, "memeloop-cli.yaml");
    process.env.MEMELOOP_TEST_API_KEY = "env-secret-key";
    fs.writeFileSync(
      p,
      [
        "providers:",
        "  - name: env-provider",
        "    baseUrl: https://api.example.com",
        "    apiKey: ${env:MEMELOOP_TEST_API_KEY}",
      ].join("\n"),
      "utf8",
    );

    const loaded = loadConfig(p);
    expect(loaded.providers?.[0]?.apiKey).toBe("env-secret-key");
  });

  it("resolves ${input:chat.lm.secret.*} interpolation via auth store", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memeloop-cli-config-"));
    tmpDirs.push(dir);
    const p = path.join(dir, "memeloop-cli.yaml");
    const secretId = "chat.lm.secret.test-config";
    const secretValue = "sk-test-secret";

    // Backup existing auth store and restore after test.
    const authPath = getAuthPath();
    const hadAuth = fs.existsSync(authPath);
    const prevRaw = hadAuth ? fs.readFileSync(authPath, "utf8") : "";
    try {
      const auth = loadAuth();
      auth[secretId] = { type: "api", key: secretValue };
      saveAuth(auth);

      fs.writeFileSync(
        p,
        [
          "providers:",
          "  - name: input-provider",
          "    baseUrl: https://api.example.com",
          `    apiKey: \${input:${secretId}}`,
        ].join("\n"),
        "utf8",
      );

      const loaded = loadConfig(p);
      expect(loaded.providers?.[0]?.apiKey).toBe(secretValue);
    } finally {
      if (hadAuth) {
        fs.mkdirSync(path.dirname(authPath), { recursive: true });
        fs.writeFileSync(authPath, prevRaw, "utf8");
      } else if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { force: true });
      }
    }
  });
});
