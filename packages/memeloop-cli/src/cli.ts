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

program
  .command("checkpoint")
  .description("Manage session checkpoints (saved conversation state)")
  .argument("[action]", "Action: list or delete", "list")
  .argument("[conversationId]", "Conversation ID (required for delete)")
  .option("-d, --directory <path>", "Checkpoint directory (default: ~/.memeloop/sessions/)")
  .action(
    async (action: string, conversationId: string | undefined, options: { directory?: string }) => {
      const { SessionStorage } = await import("memeloop");
      const storage = new SessionStorage(
        options.directory ? { directory: options.directory } : {},
      );

      if (action === "list") {
        const checkpoints = await storage.listCheckpoints();
        if (checkpoints.length === 0) {
          console.log("No checkpoints found.");
          return;
        }
        console.log(`Found ${checkpoints.length} checkpoint(s):\n`);
        for (const cp of checkpoints) {
          console.log(`  ${cp.conversationId}`);
          console.log(`    Saved: ${cp.savedAt}`);
          console.log(`    Messages: ${cp.messageCount}`);
          console.log(`    Preview: ${cp.lastMessagePreview.slice(0, 80)}...`);
          console.log();
        }
      } else if (action === "delete") {
        if (!conversationId) {
          console.error("Usage: memeloop checkpoint delete <conversationId>");
          process.exit(1);
        }
        const deleted = await storage.deleteCheckpoint(conversationId);
        if (deleted) {
          console.log(`Deleted checkpoint for ${conversationId}`);
        } else {
          console.log(`No checkpoint found for ${conversationId}`);
        }
      } else {
        console.error(`Unknown action: ${action}. Use "list" or "delete".`);
        process.exit(1);
      }
    },
  );

program
  .command("resume")
  .description("Resume a conversation from a saved checkpoint")
  .argument("<conversationId>", "Conversation ID to resume")
  .option("-d, --directory <path>", "Checkpoint directory (default: ~/.memeloop/sessions/)")
  .action(async (conversationId: string, options: { directory?: string }) => {
    const { SessionStorage } = await import("memeloop");
    const storage = new SessionStorage(
      options.directory ? { directory: options.directory } : {},
    );

    const checkpoint = await storage.loadCheckpoint(conversationId);
    if (!checkpoint) {
      console.error(`No checkpoint found for conversation: ${conversationId}`);
      console.error("Run `memeloop checkpoint list` to see available checkpoints.");
      process.exit(1);
    }

    console.log(`Resuming conversation: ${conversationId}`);
    console.log(`Messages in checkpoint: ${checkpoint.messageCount}`);
    console.log(`Saved at: ${checkpoint.savedAt}`);
    console.log();

    // Print last 5 messages for context
    const recent = checkpoint.messages.slice(-5);
    for (const msg of recent) {
      const role = msg.role.padEnd(10);
      const content =
        typeof msg.content === "string"
          ? msg.content.slice(0, 120)
          : JSON.stringify(msg.content).slice(0, 120);
      console.log(`  [${role}] ${content}${content.length >= 120 ? "..." : ""}`);
    }
    console.log();
    console.log("To continue this conversation, start the node with resume support enabled:");
    console.log(`  memeloop start --resume ${conversationId}`);
  });

program
  .command("status")
  .description("Show node status (config, connectivity)")
  .option("-c, --config <path>", "Config file path", getDefaultConfigPath())
  .option("-k, --keypair <path>", "Node keypair path", getDefaultKeypairPath())
  .action((options: { config: string; keypair: string }) => {
    const config = loadConfig(options.config);
    const keypair = loadOrCreateNodeKeypair(options.keypair);
    console.log("Config path:", options.config);
    console.log("Keypair path:", options.keypair);
    console.log("nodeId:", config.nodeId ?? keypair.nodeId);
    console.log("nodeSecret:", config.nodeSecret ? "***" : "(not set)");
    console.log("name:", config.name ?? "(default)");
    console.log("providers:", config.providers?.length ?? 0);
    console.log("wikiPath:", config.wikiPath ?? "(none)");
    console.log("fileBaseDir:", config.fileBaseDir ?? "(default cwd)");
    console.log("tools allowlist:", config.tools?.allowlist?.length ?? 0);
    console.log("tools blocklist:", config.tools?.blocklist?.length ?? 0);
  });

program.parse();
