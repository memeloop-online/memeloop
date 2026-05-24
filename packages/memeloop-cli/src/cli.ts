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
    const { readFileSync, existsSync, mkdirSync, cpSync, statSync } = await import("node:fs");
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
