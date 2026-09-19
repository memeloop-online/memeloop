#!/usr/bin/env node
/**
 * memeloop-cli CLI
 *
 * Commands / 命令：
 *   memeloop          Interactive AI chat TUI (default) / 交互式 AI 聊天（默认）
 *   memeloop config   Configuration TUI (providers, node, cloud)
 *                     配置 TUI（提供商、节点状态、云注册）
 *   memeloop start    Launch node daemon / 启动节点守护进程
 */

import { Command } from 'commander';
import { Cron } from 'croner';
import type { Server } from 'node:http';

import {
  type ControlStore,
  createAgentRuntimeDeviceRpcHandler,
  createAuditRecordAuthorizer,
  createPolicyDecisionAuthorizer,
  createScheduledTaskRpcHandler,
  DEVICE_PAIRING_INVITE_TTL_MS,
  type DeviceAuthorizer,
  type DeviceCapabilities,
  type DeviceCloudCommitFence,
  type DeviceConnectionGrant,
  encodeDevicePairingInvite,
  LocalTrustDeviceAuthorizer,
  type ScheduledAgentTaskStore,
  ScheduledTaskExecutionCoordinator,
  type ScheduledTaskExecutionStore,
  type TrustedDeviceRecord,
} from 'memeloop';
import { parseBoundedIntegerOption } from './cliOptionParsing.js';
import { getDefaultConfigPath, loadConfig } from './config.js';
import {
  authorizeAgentRuntimeRpcWithDeviceAuthorizer,
  CliCloudConnection,
  CloudDeviceAuthorizer,
  createCliDeviceNetworkService,
  createOrdinaryPeerOrchestrationHandler,
  createSignedDevicePairingInvite,
  DeviceCloudClient,
  getDefaultDeviceIdentityPath,
  loadOrCreateDeviceIdentity,
  locallyPairedRecord,
  MutableDeviceAuthorizer,
  pairWithInviteFile,
} from './deviceNetwork/index.js';
import { type CliCloudDirectorySnapshotTrustStore, FileDeviceTrustStore } from './deviceNetwork/trustStore.js';
import { resolveUnconfiguredDaemonModelRuntime } from './providers/unconfiguredProvider.js';
import { MEMELOOP_CLI_VERSION } from './remote/bootstrap.js';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : '';
}

class CachedCliDeviceTrustStore implements CliCloudDirectorySnapshotTrustStore {
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

  public commitCloudAccountSnapshot(
    records: readonly TrustedDeviceRecord[],
    fence: DeviceCloudCommitFence,
  ): readonly TrustedDeviceRecord[] | undefined {
    const committed = this.store.commitCloudAccountSnapshot(records, fence);
    if (!committed) return undefined;
    this.records.clear();
    for (const record of committed) this.records.set(record.peerId, record);
    return committed;
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
        protocols: ['/memeloop/rpc/2.0.0'],
        rpcMethodScope: { mode: 'all' },
        conversationScope: { mode: 'all' },
        definitionScope: { mode: 'all' },
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
program.enablePositionalOptions();

program
  .name('memeloop')
  .description('MemeLoop CLI — AI agent compute node')
  .version(MEMELOOP_CLI_VERSION);

// ─── config — Interactive configuration TUI ─────────────────────────

program
  .command('config')
  .description('Open interactive configuration TUI (providers, node, cloud)')
  .action(async () => {
    const { launchConfigTUI } = await import('./providers/ConfigTUI.js');
    await launchConfigTUI();
  });

// ─── device invite — Print a signed pairing QR payload ──────────────

program
  .command('device')
  .description('Manage the local MemeLoop device identity')
  .command('invite')
  .description('Create and print an identity-bound signed pairing invitation')
  .option('-i, --identity <path>', 'Device identity path', getDefaultDeviceIdentityPath())
  .requiredOption(
    '--multiaddr <address>',
    'Dialable WebSocket multiaddr ending in /p2p/<local PeerId> (repeatable)',
    (value: string, addresses: string[]) => [...addresses, value],
    [],
  )
  .option(
    '--ttl-ms <milliseconds>',
    'Invitation lifetime, at most five minutes',
    (value: string) =>
      parseBoundedIntegerOption(
        value,
        '--ttl-ms',
        1,
        DEVICE_PAIRING_INVITE_TTL_MS,
      ),
  )
  .action(async (options: {
    identity: string;
    multiaddr: string[];
    ttlMs?: number;
  }) => {
    const identity = await loadOrCreateDeviceIdentity(options.identity);
    const invite = await createSignedDevicePairingInvite({
      identity,
      multiaddrs: options.multiaddr,
      ttlMs: options.ttlMs,
    });
    process.stdout.write(`${encodeDevicePairingInvite(invite)}\n`);
  });

// ─── remote bootstrap — Install a pinned CLI on an SSH host ─────────

const remoteCommand = program
  .command('remote')
  .description('Manage remote MemeLoop compute nodes')
  .enablePositionalOptions();

remoteCommand
  .command('bootstrap <target>')
  .description('Install or select a pinned memeloop-cli version over SSH')
  .option('--version <version>', 'Exact memeloop-cli version', MEMELOOP_CLI_VERSION)
  .option(
    '-p, --port <port>',
    'SSH port',
    (value: string) => parseBoundedIntegerOption(value, '--port', 1, 65_535),
    22,
  )
  .option('-i, --identity <path>', 'SSH private key')
  .option('--known-hosts <path>', 'Dedicated known_hosts file')
  .option(
    '--accept-new-host-key',
    'Trust a previously unseen host key (TOFU); changed keys are still rejected',
  )
  .option(
    '--replace-existing-link',
    'Replace ~/.local/bin/memeloop even when it is not managed by MemeLoop',
  )
  .option('--dry-run', 'Verify SSH, Node.js and npm without changing the host')
  .option(
    '--timeout-ms <milliseconds>',
    'Overall timeout',
    (value: string) =>
      parseBoundedIntegerOption(
        value,
        '--timeout-ms',
        1_000,
        60 * 60_000,
      ),
    10 * 60_000,
  )
  .action(
    async (
      target: string,
      options: {
        version: string;
        port: number;
        identity?: string;
        knownHosts?: string;
        acceptNewHostKey?: boolean;
        replaceExistingLink?: boolean;
        dryRun?: boolean;
        timeoutMs: number;
      },
    ) => {
      const { bootstrapRemoteCli } = await import('./remote/bootstrap.js');
      const evidence = await bootstrapRemoteCli({
        target,
        version: options.version,
        port: options.port,
        identityFile: options.identity,
        knownHostsFile: options.knownHosts,
        hostKeyPolicy: options.acceptNewHostKey ? 'accept-new' : 'strict',
        replaceExistingLink: options.replaceExistingLink,
        dryRun: options.dryRun,
        timeoutMs: options.timeoutMs,
      });
      process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    },
  );

// ─── start — Launch node daemon ────────────────────────────────────────

program
  .command('start')
  .description('Start MemeLoop device network service')
  .option('-c, --config <path>', 'Config file path', getDefaultConfigPath())
  .option('-i, --identity <path>', 'Device identity path', getDefaultDeviceIdentityPath())
  .option('-d, --data-dir <path>', 'Data directory for SQLite', process.cwd())
  .option('--file-base-dir <path>', 'Root directory exposed to file.* tools')
  .option(
    '--pair-with-invite-file <path>',
    'Pair with one identity-bound signed device invite after the node starts',
  )
  .option('--mode <mode>', 'Worker mode: ordinary, restricted, or quarantine', 'ordinary')
  .option('--worker-gateway-public-url <url>', 'HTTPS URL advertised to external workers')
  .option(
    '--worker-gateway-listen <host:port>',
    'Bind the dedicated worker gateway (for example 0.0.0.0:9443)',
  )
  .option('--worker-gateway-tls-cert <path>', 'PEM certificate for an HTTPS worker gateway')
  .option('--worker-gateway-tls-key <path>', 'PEM private key for an HTTPS worker gateway')
  .option(
    '--worker-gateway-ca-cert <path>',
    'PEM CA sent to workers when the HTTPS gateway uses private PKI',
  )
  .option('--control-store <mode>', 'ControlStore mode: sqlite or etcd', 'sqlite')
  .option('--etcd-endpoints <urls>', 'Comma-separated etcd client URLs')
  .option('--etcd-namespace <prefix>', 'etcd key namespace', '/memeloop/control/v1/')
  .option('--etcd-username <name>', 'etcd username')
  .option(
    '--etcd-password-env <name>',
    'Environment variable containing the etcd password',
    'MEMELOOP_ETCD_PASSWORD',
  )
  .option('--etcd-ca-cert <path>', 'PEM CA for etcd TLS')
  .option('--etcd-client-cert <path>', 'PEM client certificate for etcd mTLS')
  .option('--etcd-client-key <path>', 'PEM client private key for etcd mTLS')
  .action(
    async (options: {
      config: string;
      identity: string;
      dataDir: string;
      fileBaseDir?: string;
      pairWithInviteFile?: string;
      mode: string;
      workerGatewayPublicUrl?: string;
      workerGatewayListen?: string;
      workerGatewayTlsCert?: string;
      workerGatewayTlsKey?: string;
      workerGatewayCaCert?: string;
      controlStore: string;
      etcdEndpoints?: string;
      etcdNamespace: string;
      etcdUsername?: string;
      etcdPasswordEnv: string;
      etcdCaCert?: string;
      etcdClientCert?: string;
      etcdClientKey?: string;
    }) => {
      const config = loadConfig(options.config);
      const pathMod = await import('node:path');
      const { resolveWorkerModeConfig, trustClassForWorkerMode } = await import('./runtime/workerMode.js');
      const workerMode = resolveWorkerModeConfig({
        mode: options.mode as 'ordinary' | 'restricted' | 'quarantine',
        dataDir: options.dataDir,
        identityPath: options.identity,
        enableOrdinaryPlugins: config.plugins?.enabled === true,
        allowedPluginPaths: config.plugins?.allowedPaths?.map(pluginPath => pathMod.resolve(pluginPath)),
      });
      const dataDirectory = pathMod.resolve(workerMode.dataDir);
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
        workerMode.identityPath,
        config.name ?? 'memeloop-cli',
      );
      const trustClass = trustClassForWorkerMode(workerMode.mode);
      if (Boolean(options.workerGatewayPublicUrl) !== Boolean(options.workerGatewayListen)) {
        throw new Error(
          '--worker-gateway-public-url and --worker-gateway-listen must be configured together',
        );
      }
      if (options.workerGatewayCaCert && !options.workerGatewayPublicUrl) {
        throw new Error('--worker-gateway-ca-cert requires --worker-gateway-public-url');
      }
      const workerGatewayCaCertificate = options.workerGatewayCaCert
        ? (await import('node:fs')).readFileSync(
          pathMod.resolve(options.workerGatewayCaCert),
          'utf8',
        )
        : undefined;
      let configuredControlStore: ControlStore | undefined;
      if (options.controlStore !== 'sqlite' && options.controlStore !== 'etcd') {
        throw new Error('--control-store must be sqlite or etcd');
      }
      if (options.controlStore === 'etcd') {
        const endpoints = options.etcdEndpoints
          ?.split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        if (!endpoints?.length) {
          throw new Error('--etcd-endpoints is required when --control-store=etcd');
        }
        if (Boolean(options.etcdClientCert) !== Boolean(options.etcdClientKey)) {
          throw new Error('--etcd-client-cert and --etcd-client-key must be configured together');
        }
        const fs = await import('node:fs');
        const rootCertificate = options.etcdCaCert
          ? fs.readFileSync(pathMod.resolve(options.etcdCaCert))
          : undefined;
        const clientCertificate = options.etcdClientCert
          ? fs.readFileSync(pathMod.resolve(options.etcdClientCert))
          : undefined;
        const clientKey = options.etcdClientKey
          ? fs.readFileSync(pathMod.resolve(options.etcdClientKey))
          : undefined;
        const password = process.env[options.etcdPasswordEnv];
        if (options.etcdUsername && !password) {
          throw new Error(`etcd username requires a password in ${options.etcdPasswordEnv}`);
        }
        if (!options.etcdUsername && password) {
          throw new Error(`set --etcd-username when ${options.etcdPasswordEnv} is present`);
        }
        const { EtcdControlStore } = await import('./orchestration/etcdControlStore.js');
        const authorizePolicyDecision = createPolicyDecisionAuthorizer();
        const authorizeAuditRecord = createAuditRecordAuthorizer();
        configuredControlStore = new EtcdControlStore({
          connection: {
            hosts: endpoints,
            dialTimeout: 10_000,
            defaultCallOptions: (context) => context.isStream ? {} : { deadline: Date.now() + 10_000 },
            ...(rootCertificate
              ? {
                credentials: {
                  rootCertificate,
                  ...(clientCertificate && clientKey
                    ? { certChain: clientCertificate, privateKey: clientKey }
                    : {}),
                },
              }
              : {}),
            ...(options.etcdUsername
              ? { auth: { username: options.etcdUsername, password: password! } }
              : {}),
          },
          namespace: options.etcdNamespace,
          authorizer: {
            authorize(request) {
              authorizePolicyDecision(request);
              authorizeAuditRecord(request);
            },
          },
        });
      }
      const capabilities: DeviceCapabilities = {
        tools: [],
        mcpServers: config.mcpServers?.map((server) => server.name) ?? [],
        hasWiki: Boolean(config.wikiPath),
        agentLoop: true,
        imChannels: config.im?.channels?.map((channel) => channel.channelId) ?? [],
        wikis: wikiBasePath ? [{ wikiId: 'default', pathHint: wikiBasePath }] : [],
        ...(options.workerGatewayPublicUrl
          ? { workerGateway: { publicUrl: options.workerGatewayPublicUrl } }
          : {}),
      };
      const trustStore = new CachedCliDeviceTrustStore();
      const cloudClient = config.cloudUrl && config.cloudAccessToken
        ? new DeviceCloudClient(config.cloudUrl, config.cloudAccessToken)
        : undefined;
      const connectionGrant = createConnectionGrantResolver({
        client: cloudClient,
        localPeerId: identity.peerId,
      });
      const localOnlyAuthorizer = new LocalTrustDeviceAuthorizer({
        getTrustedDevice: peerId => locallyPairedRecord(trustStore.getTrustedDevice(peerId)),
      });
      const authorizer = new MutableDeviceAuthorizer(localOnlyAuthorizer);
      let cloudGrantVerificationPublicKeyMultibase: string | undefined;
      const configureCloudAuthorizer = (
        publicKey: { issuer: 'memeloop-cloud'; publicKeyMultibase: string },
        signal: AbortSignal,
        fence: DeviceCloudCommitFence,
      ): void => {
        signal.throwIfAborted();
        const cloudAuthorizer: DeviceAuthorizer = new CloudDeviceAuthorizer({
          localPeerId: identity.peerId,
          grantVerificationPublicKeyMultibase: publicKey.publicKeyMultibase,
          getTrustedDevice: peerId => locallyPairedRecord(trustStore.getTrustedDevice(peerId)),
        });
        const committed = authorizer.setDelegate(cloudAuthorizer, fence);
        if (!committed) fence.throwIfStale();
        cloudGrantVerificationPublicKeyMultibase = publicKey.publicKeyMultibase;
      };
      const clearCloudAuthorizer = (signal: AbortSignal): void => {
        signal.throwIfAborted();
        authorizer.resetDelegate(signal);
        cloudGrantVerificationPublicKeyMultibase = undefined;
      };
      const unconfiguredModelRuntime = resolveUnconfiguredDaemonModelRuntime(config);
      const nodeRuntime = await createNodeRuntime({
        config,
        dataDir: dataDirectory,
        terminalManager,
        fileBaseDir: fileBaseDirectory,
        wikiBasePath,
        localNodeId: identity.peerId,
        trustClass,
        plugins: {
          enabled: workerMode.enableOrdinaryPlugins,
          projectRoot: process.cwd(),
          allowedPluginPaths: workerMode.allowedPluginPaths,
        },
        ...(unconfiguredModelRuntime ?? {}),
        ...(configuredControlStore ? { controlStore: configuredControlStore } : {}),
        ...(options.workerGatewayPublicUrl
          ? {
            workerGateway: {
              publicUrl: options.workerGatewayPublicUrl,
              ...(workerGatewayCaCertificate
                ? { caCertificate: workerGatewayCaCertificate }
                : {}),
            },
          }
          : {}),
        wikiAgentDefinitionWikiIds: config.wikiAgentDefinitionWikiIds,
        builtinToolContext: {
          getPeers: async () => deviceNetwork.listDevices(),
          sendRpcToNode: async (peerId, method, parameters, rpcOptions) => {
            const grant = await connectionGrant(peerId);
            return deviceNetwork.sendRpc(peerId, method, parameters, {
              presentedGrant: grant,
              signal: rpcOptions?.signal,
            });
          },
        },
      });
      let workerGatewayServer: Server | undefined;
      if (options.workerGatewayPublicUrl && options.workerGatewayListen) {
        if (!nodeRuntime.workerGateway) {
          throw new Error('worker gateway was not initialized');
        }
        const publicUrl = new URL(options.workerGatewayPublicUrl);
        const listenUrl = new URL(`tcp://${options.workerGatewayListen}`);
        const port = Number(listenUrl.port);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          throw new Error('--worker-gateway-listen must include a valid TCP port');
        }
        if (publicUrl.protocol === 'https:') {
          if (!options.workerGatewayTlsCert || !options.workerGatewayTlsKey) {
            throw new Error(
              'HTTPS worker gateway requires --worker-gateway-tls-cert and --worker-gateway-tls-key',
            );
          }
          const [{ createServer }, fs] = await Promise.all([
            import('node:https'),
            import('node:fs'),
          ]);
          workerGatewayServer = createServer(
            {
              cert: fs.readFileSync(pathMod.resolve(options.workerGatewayTlsCert)),
              key: fs.readFileSync(pathMod.resolve(options.workerGatewayTlsKey)),
            },
            nodeRuntime.workerGateway.handler,
          );
        } else {
          const loopback = publicUrl.hostname === '127.0.0.1' ||
            publicUrl.hostname === '::1' ||
            publicUrl.hostname === 'localhost';
          if (publicUrl.protocol !== 'http:' || !loopback) {
            throw new Error('worker gateway must use HTTPS outside loopback');
          }
          const { createServer } = await import('node:http');
          workerGatewayServer = createServer(nodeRuntime.workerGateway.handler);
        }
        await new Promise<void>((resolve, reject) => {
          workerGatewayServer?.once('error', reject);
          workerGatewayServer?.listen(port, listenUrl.hostname, () => {
            workerGatewayServer?.off('error', reject);
            resolve();
          });
        });
      }
      if (
        typeof nodeRuntime.storage.getMessageIdentity !== 'function' ||
        typeof nodeRuntime.storage.readMessageDetailRange !== 'function' ||
        typeof nodeRuntime.storage.readAttachmentRange !== 'function' ||
        typeof (nodeRuntime.storage as { createScheduledTaskStore?: unknown })
            .createScheduledTaskStore !== 'function' ||
        typeof (nodeRuntime.storage as Partial<ScheduledTaskExecutionStore>).listRunnablePage !== 'function' ||
        typeof (nodeRuntime.storage as Partial<ScheduledTaskExecutionStore>).updateExecution !== 'function'
      ) {
        throw new Error('daemon storage is missing bounded RPC read capabilities');
      }
      const rpcStorage = nodeRuntime.storage as Parameters<typeof createAgentRuntimeDeviceRpcHandler>[0]['storage'];
      const daemonStorage = nodeRuntime.storage as
        & typeof nodeRuntime.storage
        & ScheduledTaskExecutionStore
        & {
          createScheduledTaskStore(): ScheduledAgentTaskStore;
        };
      const persistedScheduledTasks = daemonStorage.createScheduledTaskStore();
      type RetryTurnHandler = NonNullable<
        Parameters<typeof createAgentRuntimeDeviceRpcHandler>[0]['retryTurn']
      >;
      const retryRuntime = nodeRuntime.runtime as typeof nodeRuntime.runtime & {
        retryTurn(
          options: Parameters<RetryTurnHandler>[0] & { requestPeerId: string },
        ): ReturnType<RetryTurnHandler>;
      };
      const scheduledTaskCoordinator = new ScheduledTaskExecutionCoordinator({
        localPeerId: identity.peerId,
        store: daemonStorage,
        runAgent: async input => {
          const requestId = `${input.occurrenceId}:attempt:${input.attempt}`;
          const handle = await nodeRuntime.runtime.sendMessage({
            conversationId: input.conversationId,
            definitionId: input.agentDefinitionId,
            message: input.message,
            requestId,
            requestPeerId: identity.peerId,
            turnId: requestId,
          });
          for (;;) {
            input.signal.throwIfAborted();
            const status = await nodeRuntime.runtime.getRunStatus(handle.runId);
            if (!status) throw new Error('scheduled_agent_run_status_missing');
            if (status.state === 'completed') return;
            if (status.state === 'failed' || status.state === 'cancelled') {
              throw new Error(status.error?.code ?? `scheduled_agent_run_${status.state}`);
            }
            await new Promise<void>((resolve, reject) => {
              const onAbort = (): void => {
                clearTimeout(timer);
                reject(
                  input.signal.reason instanceof Error
                    ? input.signal.reason
                    : new Error('scheduled_agent_run_aborted'),
                );
              };
              const timer = setTimeout(() => {
                input.signal.removeEventListener('abort', onAbort);
                resolve();
              }, 250);
              input.signal.addEventListener('abort', onAbort, { once: true });
              if (input.signal.aborted) onAbort();
            });
          }
        },
        onError: error => {
          console.warn('[memeloop-cli] scheduled task coordinator:', getErrorMessage(error));
        },
      });
      const managedScheduledTasks: ScheduledAgentTaskStore = {
        list: (request, context) => persistedScheduledTasks.list(request, context),
        get: (request, context) => persistedScheduledTasks.get(request, context),
        async create(input, context) {
          const task = await persistedScheduledTasks.create(input, context);
          await scheduledTaskCoordinator.upsert(task, { signal: context.signal });
          return task;
        },
        async update(request, context) {
          const task = await persistedScheduledTasks.update(request, context);
          await scheduledTaskCoordinator.reconcile(task, { signal: context.signal });
          return task;
        },
        async delete(request, context) {
          scheduledTaskCoordinator.remove(request.taskId);
          await persistedScheduledTasks.delete(request, context);
        },
      };
      const scheduledTaskHandler = createScheduledTaskRpcHandler({
        localPeerId: identity.peerId,
        store: managedScheduledTasks,
        cronPreviewer: {
          async preview(request) {
            const cron = new Cron(request.expression, {
              paused: true,
              protect: true,
              ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
            });
            return cron.nextRuns(request.count ?? 3).map(date => date.toISOString());
          },
        },
      });
      await scheduledTaskCoordinator.restore();
      const deviceNetwork = createCliDeviceNetworkService({
        identity,
        capabilities,
        trustStore,
        authorizer,
        syncStorage: nodeRuntime.storage,
        rpcHandler: createAgentRuntimeDeviceRpcHandler({
          runtime: nodeRuntime.runtime,
          storage: rpcStorage,
          scheduledTaskHandler,
          getAgentDefinitions: () => nodeRuntime.agentDefinitions,
          localNodeId: identity.peerId,
          authorize: authorizeAgentRuntimeRpcWithDeviceAuthorizer(authorizer),
          retryTurn: (request, requestPeerId) =>
            retryRuntime.retryTurn({
              ...request,
              requestPeerId,
            }),
        }),
        resolveRunGrantResources: async (runId, remotePeerId) => {
          const run = await nodeRuntime.runtime.getRunStatus(runId);
          if (!run || run.requestPeerId !== remotePeerId) return undefined;
          return {
            requestPeerId: run.requestPeerId,
            conversationId: run.conversationId,
            definitionId: run.definitionId,
          };
        },
        orchestrationHandler: nodeRuntime.context.orchestration
          ? createOrdinaryPeerOrchestrationHandler(nodeRuntime.context.orchestration)
          : undefined,
        ...(cloudClient
          ? {
            getRelayAdmissionVerificationPublicKeyMultibase: () => cloudGrantVerificationPublicKeyMultibase,
          }
          : {}),
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
      if (options.pairWithInviteFile) {
        try {
          const evidence = await pairWithInviteFile({
            inviteFile: options.pairWithInviteFile,
            network: deviceNetwork,
          });
          console.log(
            'Pairing accepted locally | Remote PeerId:',
            evidence.remotePeerId,
            '| Confirm code:',
            evidence.confirmCode,
          );
          console.log(
            'Confirm the same code on the remote device, then explicitly accept its pending pairing request.',
          );
        } catch (error) {
          console.warn('[memeloop-cli] pairing invite failed:', getErrorMessage(error));
        }
      }
      let cloudConnection: CliCloudConnection | undefined;
      if (cloudClient) {
        cloudConnection = new CliCloudConnection({
          capabilities: () => capabilities,
          client: cloudClient,
          clearCloudAuthorizer,
          configureCloudAuthorizer,
          identity,
          logWarning: (message, error) => {
            console.warn(`[memeloop-cli] ${message}:`, getErrorMessage(error));
          },
          network: deviceNetwork,
          trustStore,
        });
        try {
          await cloudConnection.start();
        } catch (error) {
          console.warn('[memeloop-cli] initial Cloud connection failed:', getErrorMessage(error));
        }
      }
      const shutdown = async (): Promise<void> => {
        scheduledTaskCoordinator.stopAll();
        await cloudConnection?.stop();
        if (workerGatewayServer) {
          await new Promise<void>((resolve) =>
            workerGatewayServer?.close(() => {
              resolve();
            })
          );
        }
        await nodeRuntime.stop();
        await deviceNetwork.stop();
        await configuredControlStore?.close();
        process.exit(0);
      };
      process.once('SIGINT', () => void shutdown());
      process.once('SIGTERM', () => void shutdown());
      console.log(
        'Device network started | PeerId:',
        identity.peerId,
        '| Data dir:',
        dataDirectory,
      );
      console.log(
        'Providers:',
        config.providers?.length ?? 0,
        '| Wiki:',
        config.wikiPath ?? '(none)',
      );
      console.log(
        'Runtime ready | Agents:',
        nodeRuntime.agentDefinitions.length,
        '| File base:',
        nodeRuntime.fileBaseDirResolved,
      );
      console.log('ControlStore:', options.controlStore);
      if (options.workerGatewayPublicUrl) {
        console.log('Worker gateway ready | Public URL:', options.workerGatewayPublicUrl);
      }
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
