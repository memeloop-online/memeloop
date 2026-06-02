#!/usr/bin/env node
/**
 * memeloop-cli CLI: register, start, status.
 */

import { Command } from "commander";

import type { ImWebhookHandler } from "memeloop";
import { IMChannelManager } from "memeloop";

import { getDefaultKeypairPath, loadOrCreateNodeKeypair } from "./auth/keypair.js";
import { nodeKeypairToNoiseStaticKeyPair } from "./auth/noiseKeypair.js";
import { createLanPinWsAuth } from "./auth/wsAuth.js";
import { getDefaultConfigPath, loadConfig, saveConfig } from "./config";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "";
}

const program = new Command();

program.name("memeloop").description("MemeLoop CLI compute node").version("0.0.0");

program
  .command("register")
  .description("Register this node with Cloud using OTP")
  .option("-o, --otp <code>", "6-digit OTP from Cloud")
  .option("-c, --config <path>", "Config file path", getDefaultConfigPath())
  .option("-u, --cloud-url <url>", "Cloud API base URL")
  .option("-k, --keypair <path>", "Node keypair path", getDefaultKeypairPath())
  .action(async (options: { otp?: string; config: string; cloudUrl?: string; keypair: string }) => {
    if (!options.otp) {
      console.error("Usage: memeloop register --otp <6-digit-code> [--cloud-url <url>]");
      process.exit(1);
    }
    const config = loadConfig(options.config);
    const cloudUrl = options.cloudUrl ?? config.cloudUrl;
    if (!cloudUrl) {
      console.error("Set cloud URL: --cloud-url <url> or cloudUrl in config.");
      process.exit(1);
    }
    const { CloudClient } = await import("./auth/index.js");
    const client = new CloudClient(cloudUrl);
    const keypair = loadOrCreateNodeKeypair(options.keypair);
    try {
      const result = await client.registerWithOtp(options.otp, {
        x25519PublicKey: keypair.x25519PublicKey,
        ed25519PublicKey: keypair.ed25519PublicKey,
      });
      config.nodeId = result.nodeId || keypair.nodeId;
      if (result.nodeSecret) config.nodeSecret = result.nodeSecret;
      config.cloudUrl = cloudUrl;
      saveConfig(config, options.config);
      console.log("Registered. nodeId:", config.nodeId);
    } catch (error: unknown) {
      console.error("Register failed:", error);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Print node status summary")
  .option("-c, --config <path>", "Config file path", getDefaultConfigPath())
  .action(async (options: { config: string }) => {
    const config = loadConfig(options.config);
    console.log("name:", config.name ?? "(not set)");
    console.log("nodeId:", config.nodeId ?? "(not registered)");
    console.log("cloudUrl:", config.cloudUrl ?? "(not set)");
    console.log("providers:", config.providers?.map((p) => p.name).join(", ") ?? "(none)");
    console.log("fileBaseDir:", config.fileBaseDir ?? "(not set)");
    console.log("dataDir:", options.config);
  });

program
  .command("doctor")
  .description("Diagnose environment and configuration issues")
  .option("-c, --config <path>", "Config file path", getDefaultConfigPath())
  .option("-v, --verbose", "Show detailed diagnostic information", false)
  .action(async (options: { config: string; verbose: boolean }) => {
    const checks: Array<{ name: string; status: "ok" | "warn" | "error"; message: string }> = [];

    // 1. Config file
    let config: ReturnType<typeof loadConfig> | undefined;
    try {
      config = loadConfig(options.config);
      checks.push({ name: "Config file", status: "ok", message: `Loaded from ${options.config}` });
    } catch (e) {
      checks.push({ name: "Config file", status: "error", message: getErrorMessage(e) });
    }

    // 2. Auth file
    try {
      const { getAuthPath } = await import("./auth/authStore.js");
      const authPath = getAuthPath();
      const fs = await import("node:fs");
      if (fs.existsSync(authPath)) {
        const stats = fs.statSync(authPath);
        const mode = stats.mode.toString(8).slice(-3);
        if (mode === "600") {
          checks.push({ name: "Auth file", status: "ok", message: `Secure permissions (${mode})` });
        } else {
          checks.push({ name: "Auth file", status: "warn", message: `Permissions ${mode}, expected 600` });
        }
      } else {
        checks.push({ name: "Auth file", status: "warn", message: "Not found — run 'memeloop config auth set'" });
      }
    } catch (e) {
      checks.push({ name: "Auth file", status: "error", message: getErrorMessage(e) });
    }

    // 3. Node version
    const nodeVersion = process.version;
    const major = parseInt(nodeVersion.slice(1).split(".")[0], 10);
    if (major >= 22) {
      checks.push({ name: "Node.js", status: "ok", message: nodeVersion });
    } else {
      checks.push({ name: "Node.js", status: "warn", message: `${nodeVersion} — recommend >= 22` });
    }

    // 4. Git availability
    try {
      const { execSync } = await import("node:child_process");
      const gitVer = execSync("git --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
      checks.push({ name: "Git", status: "ok", message: gitVer });
    } catch {
      checks.push({ name: "Git", status: "warn", message: "Not found — git tool unavailable" });
    }

    // 5. Data directory writable
    if (config) {
      try {
        const os = await import("node:os");
        const path = await import("node:path");
        const fs = await import("node:fs");
        const dataDir = path.resolve(os.homedir(), ".memeloop");
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }
        const testFile = path.join(dataDir, `.doctor-test-${Date.now()}`);
        fs.writeFileSync(testFile, "");
        fs.unlinkSync(testFile);
        checks.push({ name: "Data directory", status: "ok", message: dataDir });
      } catch (e) {
        checks.push({ name: "Data directory", status: "error", message: getErrorMessage(e) });
      }
    }

    // 6. LLM provider connectivity (optional)
    if (config?.providers && config.providers.length > 0) {
      for (const provider of config.providers) {
        try {
          const url = provider.baseUrl ?? (provider.options?.baseURL as string | undefined);
          if (!url) {
            checks.push({ name: `Provider ${provider.name}`, status: "warn", message: "No baseUrl configured" });
            continue;
          }
          const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
          if (res.ok || res.status === 404 || res.status === 405) {
            checks.push({ name: `Provider ${provider.name}`, status: "ok", message: url });
          } else {
            checks.push({ name: `Provider ${provider.name}`, status: "warn", message: `${url} — HTTP ${res.status}` });
          }
        } catch (e) {
          checks.push({ name: `Provider ${provider.name}`, status: "warn", message: getErrorMessage(e) });
        }
      }
    }

    // Print results
    const okCount = checks.filter((c) => c.status === "ok").length;
    const warnCount = checks.filter((c) => c.status === "warn").length;
    const errCount = checks.filter((c) => c.status === "error").length;

    console.log("\n=== MemeLoop Doctor ===\n");
    for (const check of checks) {
      const icon = check.status === "ok" ? "✅" : check.status === "warn" ? "⚠️" : "❌";
      console.log(`${icon} ${check.name}: ${check.message}`);
    }
    console.log(`\n${okCount} OK, ${warnCount} warnings, ${errCount} errors`);

    if (errCount > 0) process.exit(1);
    if (warnCount > 0 && !options.verbose) process.exit(0);
  });

program
  .command("start")
  .description("Start the node (WS server, runtime, mDNS)")
  .option("-c, --config <path>", "Config file path", getDefaultConfigPath())
  .option("-k, --keypair <path>", "Node keypair path", getDefaultKeypairPath())
  .option("-p, --port <number>", "WS/HTTP port", "38472")
  .option("-d, --data-dir <path>", "Data directory for SQLite", process.cwd())
  .option("--file-base-dir <path>", "Root directory exposed to file.* tools")
  .action(
    async (options: {
      config: string;
      keypair: string;
      port: string;
      dataDir: string;
      fileBaseDir?: string;
    }) => {
      const config = loadConfig(options.config);
      const pathMod = await import("node:path");
      const dataDirectory = pathMod.resolve(options.dataDir);
      const fileBaseDirectory = options.fileBaseDir
        ? pathMod.resolve(options.fileBaseDir)
        : config.fileBaseDir
          ? pathMod.resolve(config.fileBaseDir)
          : undefined;
      const { createNodeRuntime } = await import("./runtime/index.js");
      const { TerminalSessionManager } = await import("./terminal/index.js");
      const { startNodeServerWithMdns, PeerConnectionManager } = await import("./network/index.js");
      const terminalManager = new TerminalSessionManager();
      const wikiBasePath = config.wikiPath ? pathMod.resolve(config.wikiPath) : undefined;
      const keypair = loadOrCreateNodeKeypair(options.keypair);
      const nodeId = config.nodeId ?? keypair.nodeId;
      const peerConnectionManager = new PeerConnectionManager({
        localNodeId: nodeId,
        handshakeCredential:
          config.auth?.ws?.mode === "lan-pin" ? (config.auth?.ws?.pin ?? "") : "",
        noiseStaticKeyPair: nodeKeypairToNoiseStaticKeyPair(keypair),
      });
      // `askQuestion` needs an out-of-band notify channel (IM / UI). We wire this up after runtime is created.
      let notifyAskQuestionImpl:
        | ((payload: {
            questionId: string;
            question: string;
            conversationId?: string;
            inputType?: "single-select" | "multi-select" | "text";
            options?: Array<{ label: string; description?: string }>;
            allowFreeform?: boolean;
          }) => void)
        | undefined;
      const {
        runtime,
        storage,
        toolRegistry,
        wikiManager,
        agentDefinitions,
        fileBaseDirResolved,
        refreshWikiAgentDefinitions,
      } = createNodeRuntime({
        config,
        dataDir: dataDirectory,
        terminalManager,
        fileBaseDir: fileBaseDirectory,
        wikiBasePath,
        peerConnectionManager,
        localNodeId: nodeId,
        wikiAgentDefinitionWikiIds: config.wikiAgentDefinitionWikiIds,
        builtinToolContext: {
          notifyAskQuestion: (p) => notifyAskQuestionImpl?.(p),
        },
      });
      if (wikiBasePath && refreshWikiAgentDefinitions) {
        const fs = await import("node:fs");
        const refreshDefinitions = refreshWikiAgentDefinitions;
        let debounce: ReturnType<typeof setTimeout> | undefined;
        const schedule = (): void => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            void refreshDefinitions().catch((error: unknown) => {
              console.warn("[memeloop-cli] wiki defs refresh:", error);
            });
          }, 900);
        };
        try {
          fs.watch(wikiBasePath, { recursive: true }, schedule);
        } catch (error: unknown) {
          console.warn("[memeloop-cli] fs.watch wikiPath failed:", error);
        }
      }
      const port = parseInt(options.port, 10) || 38472;
      const mcpServers =
        config.mcpServers?.map((s) => ({ name: s.name, command: s.command, args: s.args })) ?? [];
      const wsAuth = createLanPinWsAuth(config, options.config);
      const imChannels = config.im?.channels ?? [];
      const imManager = new IMChannelManager(storage);
      let imWebhookHandler: ImWebhookHandler | undefined;
      if (imChannels.length > 0) {
        const { createImWebhookHandler } = await import("./im/createImWebhookHandler.js");
        imWebhookHandler = createImWebhookHandler({
          channels: imChannels,
          manager: imManager,
          runtime,
          storage,
        });
        // Best-effort IM askQuestion passthrough: send question to the same IM user that owns the conversation.
        const { sendTelegramTextMessage } = await import("./im/telegramAdapter.js");
        notifyAskQuestionImpl = (payload) => {
          void (async () => {
            if (!payload.conversationId) return;
            const meta = await storage.getConversationMeta(payload.conversationId);
            const source = meta?.sourceChannel;
            if (!source) return;
            const ch = imChannels.find((c) => c.channelId === source.channelId);
            if (!ch) return;
            const binding = await imManager.getBinding(source.channelId, source.imUserId);
            if (binding) {
              await imManager.setBinding({ ...binding, pendingQuestionId: payload.questionId });
            }
            if (ch.platform === "telegram") {
              await sendTelegramTextMessage(ch.botToken, source.imUserId, `❓ ${payload.question}`);
            }
          })().catch(() => {});
        };
      }
      await startNodeServerWithMdns({
        port,
        nodeId,
        rpcContext: {
          runtime,
          storage,
          toolRegistry,
          terminalManager,
          wikiManager,
          nodeId,
          mcpServers,
          imChannels,
          agentDefinitions,
          fileBaseDir: fileBaseDirResolved,
        },
        serviceName: config.name ?? "memeloop-cli",
        wsAuth,
        imWebhookHandler,
        noise: { staticKeyPair: nodeKeypairToNoiseStaticKeyPair(keypair) },
      });
      // LAN zero-config discovery: browse _memeloop._tcp and auto-connect discovered peers.
      // Keep best-effort only; failures should not block node startup.
      if (process.env.NODE_ENV !== "test" && process.env.MEMELOOP_DISABLE_MDNS !== "1") {
        const { browse } = await import("memeloop");
        const { autoConnectDiscoveredPeer } = await import("./network/lanAutoConnect.js");
        browse({
          onServiceUp: (svc) => {
            void autoConnectDiscoveredPeer(svc, nodeId, peerConnectionManager);
          },
        });
      }
      if (config.cloudUrl) {
        const { CloudClient, buildRegistrationPayload } = await import("./auth/index.js");
        const { ConnectivityManager } = await import("memeloop");
        const client = new CloudClient(config.cloudUrl);
        const refreshNodeJwt = async (): Promise<string> => {
          const jwtResult = config.nodeSecret
            ? await client.getJwt(nodeId, config.nodeSecret)
            : await client.getJwtByChallenge(nodeId, keypair.ed25519PrivateKey);
          return jwtResult.accessToken;
        };
        let nodeJwt = await refreshNodeJwt();
        const connectivity = new ConnectivityManager(port);
        await connectivity.detectPublicIP();
        const payload = buildRegistrationPayload(nodeId, port, config.name, connectivity);
        await client.registerNode(payload, nodeJwt);
        setInterval(() => {
          void (async () => {
            try {
              await client.heartbeat(nodeId, nodeJwt);
            } catch (error) {
              const message = getErrorMessage(error);
              if (!message.includes("401")) {
                return;
              }
              try {
                nodeJwt = await refreshNodeJwt();
                await client.heartbeat(nodeId, nodeJwt);
              } catch {
                // Best-effort refresh; next interval will retry.
              }
            }
          })();
        }, 60_000);
      }
      console.log("Node listening on port", port, "| Data dir:", dataDirectory);
      console.log(
        "Providers:",
        config.providers?.length ?? 0,
        "| Wiki:",
        config.wikiPath ?? "(none)",
      );
    },
  );

program
  .command("chat")
  .description("Start interactive AI chat (TUI)")
  .option("-m, --model <modelId>", "Model ID (e.g. memeloop/claude-opus-4.6)")
  .option("--mode <mode>", "Mode: chat, plan, autopilot", "chat")
  .option("-d, --data-dir <path>", "Data directory")
  .option("-c, --config <path>", "Config file path")
  .option("-p, --prompt <text>", "Initial prompt to send")
  .option("--print", "Non-interactive mode (pipe-friendly, use with --prompt)")
  .option("--continue", "Resume the most recent session")
  .option("-r, --resume <sessionId>", "Resume a specific session")
  .action(async (options: {
    model?: string;
    mode?: string;
    dataDir?: string;
    config?: string;
    prompt?: string;
    print?: boolean;
    continue?: boolean;
    resume?: string;
  }) => {
    const { launchChat } = await import("./chat.js");
    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig(options.config);
    await launchChat({
      model: options.model,
      mode: (options.mode as "chat" | "plan" | "autopilot") ?? "chat",
      dataDir: options.dataDir,
      config: cfg as unknown as Record<string, unknown>,
      print: options.print,
      prompt: options.prompt,
      continueLast: options.continue,
      resumeSessionId: options.resume,
    });
  });

const sessionsCmd = new Command("sessions").description("Manage chat sessions");

sessionsCmd
  .command("list")
  .description("List recent sessions")
  .option("-d, --data-dir <path>", "Data directory")
  .action(async (options: { dataDir?: string }) => {
    const { mkdirSync } = await import("node:fs");
    const dataDir = options.dataDir ?? "./memeloop-data";
    mkdirSync(dataDir, { recursive: true });
    const { createNodeRuntime } = await import("./runtime/nodeRuntime.js");
    const { listSessions } = await import("./sessions.js");
    const runtime = createNodeRuntime({ dataDir });
    const sessions = await listSessions(runtime);
    if (sessions.length === 0) {
      console.log("No sessions found.");
      return;
    }
    console.log("ID".padEnd(36), "Title".padEnd(20), "Msgs", "Updated");
    console.log("-".repeat(80));
    for (const s of sessions) {
      console.log(
        s.id.slice(0, 36).padEnd(36),
        s.title.slice(0, 20).padEnd(20),
        String(s.messageCount).padEnd(5),
        new Date(s.lastMessageTimestamp).toISOString().slice(0, 19),
      );
    }
  });

sessionsCmd
  .command("resume")
  .description("Resume a session")
  .argument("<sessionId>", "Session ID to resume")
  .option("-d, --data-dir <path>", "Data directory")
  .action(async (sessionId: string, options: { dataDir?: string }) => {
    const { launchChat } = await import("./chat.js");
    const { createNodeRuntime } = await import("./runtime/nodeRuntime.js");
    const { resumeSession } = await import("./sessions.js");
    const runtime = createNodeRuntime({ dataDir: options.dataDir });
    const resumed = await resumeSession(runtime, sessionId);
    if (!resumed) {
      console.error("Session not found or has no messages:", sessionId);
      process.exit(1);
    }
    console.log(`Resuming session ${sessionId} (${resumed.messages.length} messages)`);
    // Launch chat with resume data
    await launchChat({
      dataDir: options.dataDir,
      localNodeId: sessionId,
    });
  });

sessionsCmd
  .command("delete")
  .description("Delete a session")
  .argument("<sessionId>", "Session ID to delete")
  .option("-d, --data-dir <path>", "Data directory")
  .action(async (sessionId: string, options: { dataDir?: string }) => {
    const { mkdirSync } = await import("node:fs");
    const dataDir = options.dataDir ?? "./memeloop-data";
    mkdirSync(dataDir, { recursive: true });
    const { createNodeRuntime } = await import("./runtime/nodeRuntime.js");
    const { deleteSession } = await import("./sessions.js");
    const runtime = createNodeRuntime({ dataDir });
    const ok = await deleteSession(runtime, sessionId);
    console.log(ok ? `Deleted session ${sessionId}` : `Failed to delete session ${sessionId}`);
  });

// ── export sub-command ──
sessionsCmd
  .command("export")
  .description("Export a conversation to JSON")
  .argument("<conversationId>", "Conversation ID")
  .option("-o, --output <path>", "Output file (default: stdout)")
  .action(async (conversationId: string, opts: { output?: string }) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const dataDir = path.join(os.homedir(), ".memeloop");
    fs.mkdirSync(dataDir, { recursive: true });
    const { SQLiteAgentStorage } = await import("memeloop");
    const storage = new (SQLiteAgentStorage as any)(path.join(dataDir, "memeloop.db"));
    const msgs = (storage as unknown as { getMessages: (id: string) => unknown[] }).getMessages(conversationId);
    const json = JSON.stringify({ conversationId, exportedAt: new Date().toISOString(), messages: msgs }, null, 2);
    if (opts.output) {
      fs.writeFileSync(opts.output, json);
      console.log(`Exported ${msgs.length} messages to ${opts.output}`);
    } else {
      console.log(json);
    }
  });

// ── import sub-command ──
sessionsCmd
  .command("import")
  .description("Show conversation import info")
  .argument("<file>", "JSON file")
  .action(async (file: string) => {
    const fs = await import("node:fs");
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    console.log(`Conversation: ${data.conversationId}`);
    console.log(`  Messages: ${data.messages?.length ?? 0}`);
    console.log(`  Exported: ${data.exportedAt ?? "unknown"}`);
  });

program.addCommand(sessionsCmd);

const configCmd = new Command("config").description("Manage configuration and auth keys");

configCmd
  .command("show")
  .description("Print current configuration (no secrets)")
  .option("-c, --config <path>", "Config file path")
  .action(async (options: { config?: string }) => {
    const { loadConfig: loadCfg } = await import("./config.js");
    const cfg = loadCfg(options.config);
    const safe = { ...cfg };
    if (safe.providers) {
      safe.providers = (safe.providers as unknown as Record<string, unknown>[]).map((p) => {
        const { apiKey, ...rest } = p;
        return rest;
      }) as unknown as typeof safe.providers;
    }
    console.log(JSON.stringify(safe, null, 2));
  });

configCmd
  .command("path")
  .description("Show config file paths and search order")
  .option("-c, --config <path>", "Show chosen config path as highest priority")
  .action(async (options: { config?: string }) => {
    const { getDefaultConfigPath: gdcp, getHomeConfigPath: ghcp } = await import("./config.js");
    const { getAuthPath: gap } = await import("./auth/authStore.js");
    console.log("Config search paths (first found wins):");
    if (options.config) {
      console.log("  0. Explicit:      " + options.config);
    }
    console.log("  1. CWD:           " + gdcp());
    console.log("  2. Home:          " + ghcp());
    console.log("  Auth file:        " + gap());
  });

configCmd
  .command("init")
  .description("Create default config from template")
  .action(async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { getHomeConfigPath: ghcp } = await import("./config.js");
    const hp = ghcp();
    if (fs.existsSync(hp)) {
      console.log("Config already exists at " + hp);
      return;
    }
    const template = "# MemeLoop CLI Configuration\n# LLM Providers (API keys stored in ~/.local/share/memeloop/auth.json)\nproviders:\n  # - name: \"Westlake HPC\"\n  #   options:\n  #     baseURL: \"https://hpc-api.westlake.edu.cn/v1\"\n  #   models:\n  #     deepseek:\n  #       name: \"DeepSeek V4 Pro\"\n\nauth:\n  ws:\n    enabled: true\n    mode: lan-pin\n";
    fs.mkdirSync(path.dirname(hp), { recursive: true });
    fs.writeFileSync(hp, template, "utf-8");
    console.log("Created config at " + hp);
  });

const authCmd = new Command("auth").description("Manage API keys (stored in ~/.local/share/memeloop/auth.json)");

authCmd
  .command("set")
  .description("Store an API key for a provider")
  .argument("<provider>", "Provider name (must match config)")
  .argument("<key>", "API key")
  .action(async (provider: string, key: string) => {
    const { setApiKey, getAuthPath: gap } = await import("./auth/authStore.js");
    setApiKey(provider, key);
    console.log("API key for \"" + provider + "\" saved to " + gap());
  });

authCmd
  .command("list")
  .description("List stored provider keys (masked)")
  .action(async () => {
    const { loadAuth } = await import("./auth/authStore.js");
    const auth = loadAuth();
    const entries = Object.entries(auth);
    if (entries.length === 0) {
      console.log("No API keys stored. Use: memeloop config auth set <provider> <key>");
      return;
    }
    console.log("Stored API keys:");
    for (const [p, e] of entries) {
      const e2 = e as { type: string; key: string };
      console.log("  " + p + ": " + e2.key.slice(0, 8) + "..." + e2.key.slice(-4));
    }
  });

configCmd.addCommand(authCmd);

const secretCmd = new Command("secret").description("Manage VS Code-style input secrets");

secretCmd
  .command("set")
  .description("Set a secret value by input secret id")
  .argument("<secretId>", "Secret id, e.g. chat.lm.secret.-5886adbd")
  .argument("<key>", "Secret value")
  .action(async (secretId: string, key: string) => {
    const { setInputSecret, getAuthPath: gap } = await import("./auth/authStore.js");
    setInputSecret(secretId, key);
    console.log(`Secret for \"${secretId}\" saved to ${gap()}`);
  });

secretCmd
  .command("list")
  .description("List stored input secret ids")
  .action(async () => {
    const { loadAuth } = await import("./auth/authStore.js");
    const auth = loadAuth();
    const keys = Object.keys(auth).filter((k) => k.startsWith("chat.lm.secret."));
    if (keys.length === 0) {
      console.log("No input secrets stored.");
      return;
    }
    console.log("Stored input secret ids:");
    for (const key of keys) {
      console.log(`  ${key}`);
    }
  });

configCmd.addCommand(secretCmd);
program.addCommand(configCmd);

const imCmd = new Command("im").description("IM Webhook 频道（/im/webhook/<channelId>）");

imCmd
  .command("add")
  .description("添加 IM channel 并写入 YAML")
  .option("-c, --config <path>", "Config file path", getDefaultConfigPath())
  .requiredOption("--platform <platform>", "telegram | discord | lark | wecom")
  .requiredOption("--token <token>", "Bot token（Telegram 等）")
  .option("--secret <secret>", "Webhook 校验 secret（如 Telegram secret_token）")
  .option("--definition <id>", "默认 Agent Definition", "memeloop:general-assistant")
  .option("--discord-public-key <hex>", "Discord Application Public Key（hex）")
  .action(
    async (options: {
      config: string;
      platform: string;
      token: string;
      secret?: string;
      definition: string;
      discordPublicKey?: string;
    }) => {
      const { randomUUID } = await import("node:crypto");
      const cfg = loadConfig(options.config);
      const platform = options.platform.trim().toLowerCase();
      if (!["telegram", "discord", "lark", "wecom"].includes(platform)) {
        console.error("Unsupported platform:", platform);
        process.exit(1);
      }
      const channel = {
        channelId: randomUUID(),
        platform: platform as import("@memeloop/protocol").IMPlatformType,
        botToken: options.token,
        webhookSecret: options.secret,
        defaultDefinitionId: options.definition,
        discordPublicKey: options.discordPublicKey,
      };
      cfg.im = cfg.im ?? { channels: [] };
      cfg.im.channels = [...(cfg.im.channels ?? []), channel];
      saveConfig(cfg, options.config);
      console.log("channelId:", channel.channelId);
      console.log("Direct webhook path: POST /im/webhook/" + channel.channelId);
    },
  );

imCmd
  .command("list")
  .description("列出 YAML 中的 IM channels")
  .option("-c, --config <path>", "Config file path", getDefaultConfigPath())
  .action((options: { config: string }) => {
    const cfg = loadConfig(options.config);
    console.log(JSON.stringify(cfg.im?.channels ?? [], null, 2));
  });

imCmd
  .command("remove")
  .description("按 channelId 删除")
  .argument("<channelId>", "Channel UUID")
  .option("-c, --config <path>", "Config file path", getDefaultConfigPath())
  .action((channelId: string, options: { config: string }) => {
    const cfg = loadConfig(options.config);
    cfg.im ??= { channels: [] };
    cfg.im.channels = (cfg.im.channels ?? []).filter((c) => c.channelId !== channelId);
    saveConfig(cfg, options.config);
    console.log("removed", channelId);
  });

program.addCommand(imCmd);

// ─── Plugin Management ──────────────────────────────────────────────

const pluginCmd = new Command("plugin").description("Manage third-party plugins (tools, hooks, skills)");

pluginCmd
  .command("list")
  .description("List installed plugins")
  .option("--global", "List user-global plugins (~/.memeloop/plugins/)", false)
  .action(async (options: { global: boolean }) => {
    const { listPlugins, loadAllPlugins, createPluginAPI } = await import("memeloop");
    const { homedir } = await import("node:os");
    const { resolve } = await import("node:path");

    // Try to load plugins from the target directory first
    const api = createPluginAPI();
    const projectRoot = options.global ? homedir() : process.cwd();
    await loadAllPlugins(api, projectRoot);

    const plugins = listPlugins();
    if (plugins.length === 0) {
      console.log("No plugins installed.");
      if (!options.global) {
        console.log(`Project-local: ${resolve(process.cwd(), ".memeloop", "plugins")}`);
      }
      console.log(`User-global: ${resolve(homedir(), ".memeloop", "plugins")}`);
      return;
    }
    console.log(`Loaded ${plugins.length} plugin(s):\n`);
    for (const p of plugins) {
      console.log(`  ${p.manifest.name} v${p.manifest.version}`);
      console.log(`    Description: ${p.manifest.description || "(none)"}`);
      console.log(`    Directory: ${p.directory}`);
      console.log(`    Exports: ${JSON.stringify(p.manifest.exports ?? {})}`);
      console.log(`    Loaded at: ${p.loadedAt.toISOString()}`);
      console.log();
    }
  });

pluginCmd
  .command("install")
  .description("Install a plugin from a local directory")
  .argument("<source>", "Path to plugin directory (must contain memeloop-plugin.json)")
  .option("--global", "Install to user-global plugins (~/.memeloop/plugins/)", false)
  .option("-n, --name <name>", "Plugin directory name (defaults to source basename)")
  .action(async (source: string, options: { global: boolean; name?: string }) => {
    const { readFileSync, existsSync, mkdirSync, cpSync } = await import("node:fs");
    const { resolve, basename, join } = await import("node:path");
    const { homedir } = await import("node:os");

    const srcDir = resolve(source);
    const manifestPath = join(srcDir, "memeloop-plugin.json");

    if (!existsSync(manifestPath)) {
      console.error(`No memeloop-plugin.json found in: ${srcDir}`);
      process.exit(1);
    }

    // Read manifest to validate
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      console.error(`Invalid memeloop-plugin.json in: ${srcDir}`);
      process.exit(1);
    }

    const pluginName = manifest.name || options.name || basename(srcDir);
    const targetBase = options.global
      ? resolve(homedir(), ".memeloop", "plugins")
      : resolve(process.cwd(), ".memeloop", "plugins");
    const targetDir = join(targetBase, options.name ?? pluginName);

    try {
      mkdirSync(targetBase, { recursive: true });
      // Remove existing if present
      if (existsSync(targetDir)) {
        cpSync(srcDir, targetDir, { recursive: true, force: true });
        console.log(`Updated plugin "${pluginName}" in ${targetDir}`);
      } else {
        cpSync(srcDir, targetDir, { recursive: true });
        console.log(`Installed plugin "${pluginName}" to ${targetDir}`);
      }
      console.log(`Restart the node to activate: memeloop start`);
    } catch (err) {
      console.error(`Failed to install plugin:`, err);
      process.exit(1);
    }
  });

pluginCmd
  .command("uninstall")
  .description("Remove an installed plugin")
  .argument("<name>", "Plugin name to uninstall")
  .option("--global", "Uninstall from user-global plugins (~/.memeloop/plugins/)", false)
  .action(async (name: string, options: { global: boolean }) => {
    const { existsSync, rmSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    const { homedir } = await import("node:os");

    const targetBase = options.global
      ? resolve(homedir(), ".memeloop", "plugins")
      : resolve(process.cwd(), ".memeloop", "plugins");

    const targetDir = join(targetBase, name);

    if (!existsSync(targetDir)) {
      console.error(`Plugin "${name}" not found in: ${targetBase}`);
      process.exit(1);
    }

    try {
      rmSync(targetDir, { recursive: true, force: true });
      console.log(`Uninstalled plugin "${name}" from ${targetDir}`);
    } catch (err) {
      console.error(`Failed to uninstall plugin:`, err);
      process.exit(1);
    }
  });

program.addCommand(pluginCmd);

// ACP (Agent Client Protocol) mode – IDE integration
// Check for ACP flags BEFORE program.parse() so we can skip subcommand dispatch.
const acpArgs = process.argv.slice(2);
const acpIndex = acpArgs.indexOf("--acp");
if (acpIndex !== -1) {
  const useStdio = acpArgs.includes("--acp-stdio");
  const portArg = acpArgs.indexOf("--acp-port");
  const port = portArg !== -1 && portArg + 1 < acpArgs.length ? parseInt(acpArgs[portArg + 1], 10) : 3000;

  void (async () => {
    try {
      const config = loadConfig(getDefaultConfigPath());
      const pathMod = await import("node:path");
      const dataDirectory = pathMod.resolve(process.cwd());
      const { createNodeRuntime } = await import("./runtime/index.js");
      const { TerminalSessionManager } = await import("./terminal/index.js");
      const terminalManager = new TerminalSessionManager();
      const keypair = loadOrCreateNodeKeypair(getDefaultKeypairPath());
      const nodeId = config.nodeId ?? keypair.nodeId;
      const { PeerConnectionManager } = await import("./network/index.js");
      const { nodeKeypairToNoiseStaticKeyPair } = await import("./auth/noiseKeypair.js");
      const peerConnectionManager = new PeerConnectionManager({
        localNodeId: nodeId,
        handshakeCredential: config.auth?.ws?.mode === "lan-pin" ? (config.auth?.ws?.pin ?? "") : "",
        noiseStaticKeyPair: nodeKeypairToNoiseStaticKeyPair(keypair),
      });
      const { runtime } = createNodeRuntime({
        config,
        dataDir: dataDirectory,
        terminalManager,
        fileBaseDir: config.fileBaseDir ? pathMod.resolve(config.fileBaseDir) : undefined,
        peerConnectionManager,
        localNodeId: nodeId,
        wikiAgentDefinitionWikiIds: config.wikiAgentDefinitionWikiIds,
      });
      const { startAcpServer } = await import("./acp/server.js");
      await startAcpServer({
        mode: useStdio ? "stdio" : "tcp",
        port: useStdio ? undefined : port,
        runtime,
        logger: (msg) => {
          if (msg.startsWith("[acp]")) {
            process.stderr.write(msg + "\n");
          }
        },
      });
    } catch (error) {
      process.stderr.write(`[acp] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  })();
} else {
  program.parse();
}
