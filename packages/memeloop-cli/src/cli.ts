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

import { Command } from 'commander';

import type { DeviceCapabilities } from 'memeloop';
import { getDefaultConfigPath, loadConfig } from './config';
import { createCliDeviceNetworkService, DeviceCloudClient, getDefaultDeviceIdentityPath, loadOrCreateDeviceIdentity, signDeviceBinding } from './deviceNetwork/index.js';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : '';
}

const program = new Command();

program.name('memeloop').description('MemeLoop CLI — AI agent compute node').version('0.0.0');

// ─── config — Interactive configuration TUI ─────────────────────────

program
  .command('config')
  .description('Open interactive configuration TUI (providers, node, diagnostics, cloud)')
  .action(async () => {
    const { launchConfigTUI } = await import('./providers/ConfigTUI.js');
    await launchConfigTUI();
  });

// ─── start — Launch node daemon ────────────────────────────────────────

program
  .command('start')
  .description('Start MemeLoop device network service')
  .option('-c, --config <path>', 'Config file path', getDefaultConfigPath())
  .option('-i, --identity <path>', 'Device identity path', getDefaultDeviceIdentityPath())
  .option('-d, --data-dir <path>', 'Data directory for SQLite', process.cwd())
  .option('--file-base-dir <path>', 'Root directory exposed to file.* tools')
  .action(
    async (options: {
      config: string;
      identity: string;
      dataDir: string;
      fileBaseDir?: string;
    }) => {
      const config = loadConfig(options.config);
      const pathMod = await import('node:path');
      const dataDirectory = pathMod.resolve(options.dataDir);
      const fileBaseDirectory = options.fileBaseDir
        ? pathMod.resolve(options.fileBaseDir)
        : config.fileBaseDir
        ? pathMod.resolve(config.fileBaseDir)
        : undefined;
      const { createNodeRuntime } = await import('./runtime/index.js');
      const { TerminalSessionManager } = await import('./terminal/index.js');
      const terminalManager = new TerminalSessionManager();
      const wikiBasePath = config.wikiPath ? pathMod.resolve(config.wikiPath) : undefined;
      const identity = await loadOrCreateDeviceIdentity(
        options.identity,
        config.name ?? 'memeloop-cli',
      );
      const capabilities: DeviceCapabilities = {
        tools: [],
        mcpServers: config.mcpServers?.map((server) => server.name) ?? [],
        hasWiki: Boolean(config.wikiPath),
        imChannels: config.im?.channels?.map((channel) => channel.channelId) ?? [],
        wikis: wikiBasePath ? [{ wikiId: 'default', pathHint: wikiBasePath }] : [],
      };
      const deviceNetwork = createCliDeviceNetworkService({ identity, capabilities });
      const nodeRuntime = createNodeRuntime({
        config,
        dataDir: dataDirectory,
        terminalManager,
        fileBaseDir: fileBaseDirectory,
        wikiBasePath,
        localNodeId: identity.peerId,
        wikiAgentDefinitionWikiIds: config.wikiAgentDefinitionWikiIds,
        builtinToolContext: {
          sendRpcToNode: async (peerId, method, parameters) => deviceNetwork.sendRpc(peerId, method, parameters),
        },
      });
      if (wikiBasePath && nodeRuntime.refreshWikiAgentDefinitions) {
        const fs = await import('node:fs');
        const refreshDefinitions = nodeRuntime.refreshWikiAgentDefinitions;
        let debounce: ReturnType<typeof setTimeout> | undefined;
        const schedule = (): void => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            void refreshDefinitions().catch((error: unknown) => {
              console.warn('[memeloop-cli] wiki defs refresh:', error);
            });
          }, 900);
        };
        try {
          fs.watch(wikiBasePath, { recursive: true }, schedule);
        } catch (error: unknown) {
          console.warn('[memeloop-cli] fs.watch wikiPath failed:', error);
        }
      }
      await deviceNetwork.start();
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      if (config.cloudUrl && config.cloudAccessToken) {
        const client = new DeviceCloudClient(config.cloudUrl, config.cloudAccessToken);
        const nonce = await client.createBindingNonce();
        await client.registerDevice({
          identity,
          cloudNonce: nonce.nonce,
          signature: await signDeviceBinding({ identity, accountId: nonce.accountId, nonce: nonce.nonce }),
          capabilities,
          multiaddrs: [],
          relayReservations: [],
        });
        heartbeatTimer = setInterval(() => {
          void client.heartbeat({
            peerId: identity.peerId,
            capabilities,
            multiaddrs: [],
            relayReservations: [],
          }).catch((error: unknown) => {
            console.warn('[memeloop-cli] device heartbeat failed:', getErrorMessage(error));
          });
        }, 60_000);
      }
      const shutdown = async (): Promise<void> => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        await deviceNetwork.stop();
        process.exit(0);
      };
      process.once('SIGINT', () => void shutdown());
      process.once('SIGTERM', () => void shutdown());
      console.log('Device network started | PeerId:', identity.peerId, '| Data dir:', dataDirectory);
      console.log(
        'Providers:',
        config.providers?.length ?? 0,
        '| Wiki:',
        config.wikiPath ?? '(none)',
      );
      console.log('Runtime ready | Agents:', nodeRuntime.agentDefinitions.length, '| File base:', nodeRuntime.fileBaseDirResolved);
      if (process.env.NODE_ENV !== 'test') {
        await new Promise(() => {});
      }
    },
  );

// ─── Default — Interactive chat TUI ──────────────────────────────────

// When no subcommand is given, launch the chat TUI.
const arguments_ = process.argv.slice(2);
if (
  arguments_.length === 0 ||
  (arguments_.length === 1 &&
    (arguments_[0] === '-h' ||
      arguments_[0] === '--help' ||
      arguments_[0] === '-V' ||
      arguments_[0] === '--version'))
) {
  // If no subcommand, launch chat TUI (unless it's --help/--version handled by commander)
}
if (arguments_.length === 0 || arguments_[0] === 'chat') {
  // Remove "chat" from args so commander doesn't try to parse it as a subcommand
  if (arguments_[0] === 'chat') process.argv.splice(2, 1);
  void (async () => {
    const { launchChat } = await import('./chat/index.js');
    await launchChat();
  })();
} else {
  program.parse();
}
