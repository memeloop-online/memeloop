#!/usr/bin/env node
/**
 * memeloop-cli CLI
 *
 * Commands / 命令：
 *   memeloop          Interactive AI chat TUI (default) / 交互式 AI 聊天（默认）
 *   memeloop config   Configuration TUI (providers, node, diagnostics, cloud)
 *                     配置 TUI（提供商、节点状态、诊断、云注册）
 *   memeloop start    Launch node daemon / 启动节点守护进程
 */

import { Command } from "commander";

import type { ImWebhookHandler } from "memeloop";
import { IMChannelManager } from "memeloop";

import { getDefaultKeypairPath, loadOrCreateNodeKeypair } from "./auth/keypair.js";
import { nodeKeypairToNoiseStaticKeyPair } from "./auth/noiseKeypair.js";
import { createLanPinWsAuth } from "./auth/wsAuth.js";
import { getDefaultConfigPath, loadConfig } from "./config";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "";
}

const program = new Command();

program.name("memeloop").description("MemeLoop CLI — AI agent compute node").version("0.0.0");

// ─── config — Interactive configuration TUI ─────────────────────────

program
  .command("config")
  .description("Open interactive configuration TUI (providers, node, diagnostics, cloud)")
  .action(async () => {
    const { launchConfigTUI } = await import("./providers/ConfigTUI.js");
    await launchConfigTUI();
  });

// ─── start — Launch node daemon ────────────────────────────────────────

program
  .command("start")
  .description("Start node daemon (WS server, mDNS, cloud heartbeat)")
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
      if (process.env.NODE_ENV !== "test" && process.env.MEMELOOP_DISABLE_MDNS !== "1") {
        const { browse } = await import("./network/lanDiscovery.js");
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

// ─── Default — Interactive chat TUI ──────────────────────────────────

// When no subcommand is given, launch the chat TUI.
const arguments_ = process.argv.slice(2);
if (
  arguments_.length === 0 ||
  (arguments_.length === 1 &&
    (arguments_[0] === "-h" ||
      arguments_[0] === "--help" ||
      arguments_[0] === "-V" ||
      arguments_[0] === "--version"))
) {
  // If no subcommand, launch chat TUI (unless it's --help/--version handled by commander)
}
if (arguments_.length === 0 || arguments_[0] === "chat") {
  // Remove "chat" from args so commander doesn't try to parse it as a subcommand
  if (arguments_[0] === "chat") process.argv.splice(2, 1);
  void (async () => {
    const { launchChat } = await import("./chat/index.js");
    await launchChat();
  })();
} else {
  program.parse();
}
