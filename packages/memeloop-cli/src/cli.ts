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

import {
  CloudDeviceAuthorizer,
  createAgentRuntimeDeviceRpcHandler,
  type DeviceCapabilities,
  type DeviceConnectionGrant,
  type DeviceRelayReservationToken,
  type DeviceTrustStore,
  type TrustedDeviceRecord,
} from 'memeloop';
import { getDefaultConfigPath, loadConfig } from './config';
import { createCliDeviceNetworkService, DeviceCloudClient, getDefaultDeviceIdentityPath, loadOrCreateDeviceIdentity, signDeviceBinding } from './deviceNetwork/index.js';
import { FileDeviceTrustStore } from './deviceNetwork/trustStore.js';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : '';
}

class CachedCliDeviceTrustStore implements DeviceTrustStore {
  private readonly records = new Map<string, TrustedDeviceRecord>();

  constructor(private readonly store = new FileDeviceTrustStore()) {}

  public async loadTrustedDevices(): Promise<TrustedDeviceRecord[]> {
    const records = await this.store.loadTrustedDevices();
    this.records.clear();
    for (const record of records) {
      this.records.set(record.peerId, record);
    }
    return records;
  }

  public async saveTrustedDevice(record: TrustedDeviceRecord): Promise<void> {
    this.records.set(record.peerId, record);
    await this.store.saveTrustedDevice(record);
  }

  public async removeTrustedDevice(peerId: string): Promise<void> {
    this.records.delete(peerId);
    await this.store.removeTrustedDevice(peerId);
  }

  public getTrustedDevice(peerId: string): TrustedDeviceRecord | undefined {
    return this.records.get(peerId);
  }
}

function createConnectionGrantResolver(input: {
  client?: DeviceCloudClient;
  localPeerId: string;
}): (peerId: string) => Promise<DeviceConnectionGrant | undefined> {
  const cache = new Map<string, DeviceConnectionGrant>();
  return async (peerId) => {
    if (!input.client) return undefined;
    const cached = cache.get(peerId);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached;
    try {
      const grant = await input.client.createConnectionGrant({
        subjectPeerId: input.localPeerId,
        allowedPeerIds: [peerId],
      });
      cache.set(peerId, grant);
      return grant;
    } catch (error) {
      console.warn('[memeloop-cli] connection grant failed:', getErrorMessage(error));
      return undefined;
    }
  };
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
        agentLoop: true,
        imChannels: config.im?.channels?.map((channel) => channel.channelId) ?? [],
        wikis: wikiBasePath ? [{ wikiId: 'default', pathHint: wikiBasePath }] : [],
      };
      const trustStore = new CachedCliDeviceTrustStore();
      const cloudClient = config.cloudUrl && config.cloudAccessToken
        ? new DeviceCloudClient(config.cloudUrl, config.cloudAccessToken)
        : undefined;
      const connectionGrant = createConnectionGrantResolver({ client: cloudClient, localPeerId: identity.peerId });
      let authorizer: CloudDeviceAuthorizer | undefined;
      if (cloudClient) {
        try {
          const publicKey = await cloudClient.getConnectionGrantPublicKey();
          authorizer = new CloudDeviceAuthorizer({
            localPeerId: identity.peerId,
            grantVerificationPublicKeyMultibase: publicKey.publicKeyMultibase,
            getTrustedDevice: (peerId) => trustStore.getTrustedDevice(peerId),
          });
        } catch (error) {
          console.warn('[memeloop-cli] cloud grant public key failed:', getErrorMessage(error));
        }
      }
      const nodeRuntime = await createNodeRuntime({
        config,
        dataDir: dataDirectory,
        terminalManager,
        fileBaseDir: fileBaseDirectory,
        wikiBasePath,
        localNodeId: identity.peerId,
        wikiAgentDefinitionWikiIds: config.wikiAgentDefinitionWikiIds,
        builtinToolContext: {
          getPeers: async () => deviceNetwork.listDevices(),
          sendRpcToNode: async (peerId, method, parameters) => {
            const grant = await connectionGrant(peerId);
            return deviceNetwork.sendRpc(peerId, method, parameters, grant);
          },
        },
      });
      const deviceNetwork = createCliDeviceNetworkService({
        identity,
        capabilities,
        trustStore,
        authorizer,
        syncStorage: nodeRuntime.storage,
        rpcHandler: createAgentRuntimeDeviceRpcHandler({
          runtime: nodeRuntime.runtime,
          storage: nodeRuntime.storage,
          getAgentDefinitions: () => nodeRuntime.agentDefinitions,
          localNodeId: identity.peerId,
        }),
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
      let relayReservation: DeviceRelayReservationToken | undefined;
      if (cloudClient) {
        const nonce = await cloudClient.createBindingNonce();
        await cloudClient.registerDevice({
          identity,
          cloudNonce: nonce.nonce,
          signature: await signDeviceBinding({ identity, accountId: nonce.accountId, nonce: nonce.nonce }),
          capabilities,
          multiaddrs: deviceNetwork.getMultiaddrs(),
          relayReservations: [],
        });
        try {
          relayReservation = await cloudClient.createRelayReservation({ peerId: identity.peerId });
          await deviceNetwork.configureRelayReservation(relayReservation);
        } catch (error) {
          console.warn('[memeloop-cli] relay reservation failed:', getErrorMessage(error));
        }
        const currentRelayReservations = (): string[] => {
          const relayedAddresses = deviceNetwork.getMultiaddrs().filter((address) => address.includes('/p2p-circuit'));
          return relayedAddresses.length > 0 ? relayedAddresses : relayReservation?.relayMultiaddrs ?? [];
        };
        const sendHeartbeat = (): void => {
          void cloudClient.heartbeat({
            peerId: identity.peerId,
            capabilities,
            multiaddrs: deviceNetwork.getMultiaddrs(),
            relayReservations: currentRelayReservations(),
          }).catch((error: unknown) => {
            console.warn('[memeloop-cli] device heartbeat failed:', getErrorMessage(error));
          });
        };
        sendHeartbeat();
        heartbeatTimer = setInterval(() => {
          sendHeartbeat();
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
