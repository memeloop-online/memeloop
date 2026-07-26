import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  AGENT_RUN_API_VERSION,
  AGENT_RUN_KIND,
  AGENT_WORKLOAD_KIND,
  type AgentDefinition,
  type AgentFrameworkContext,
  type AgentRunResource,
  type AgentVolumeClaimResource,
  type AgentVolumeResource,
  type AgentWorkloadResource,
  type ArtifactInspector,
  type ArtifactManagementDriver,
  type ArtifactManagementStateSnapshot,
  BUILTIN_RUNTIME_CLASSES,
  type BuiltinToolContext,
  canDriverSatisfyClass,
  canonicalDriverValue,
  type ChatSyncEngine,
  consumeWorkloadCapabilityGrant,
  type ControllerRunnerHandle,
  type ControlStore,
  type ControlStoreActor,
  createAgentToolLoopRunner,
  createBindingController,
  createCapacityScheduler,
  createControllerRunner,
  createControlStoreLoopCheckpointStore,
  createControlStoreOrchestrationClient,
  createCredentialGrantBindingController,
  createCredentialGrantExecutionController,
  createCredentialGrantLifecycleController,
  createExternalOrchestrationController,
  createFakeArtifactManagementState,
  createGatewayMediatedLLMProvider,
  createInProcessLoopRuntimeDriver,
  createInProcessToolExecutionDriver,
  createManagedArtifactDriverAdapter,
  createManagedCredentialBrokerAdapter,
  createManagedLoopRuntimeExecutionRoute,
  createManagedNetworkAdapter,
  createManagedStorageDriverAdapter,
  createManagedToolDescriptors,
  createManagedToolExecutionRoute,
  createMemeLoopRuntime,
  createModelEndpointBindingController,
  createModelEndpointRegistrar,
  createModelProviderDriverFromLLMProvider,
  createNetworkAttachmentBindingController,
  createNetworkAttachmentExecutionController,
  createRuntimeClassRoutingDriver,
  createRunVolumeController,
  createScriptLoadGate,
  createToolExecutorManifest,
  createToolOperationBindingController,
  createToolOperationExecutionController,
  createVolumeClaimBindingController,
  createVolumeClaimExecutionController,
  createVolumeManifest,
  createWorkerEnrollmentManifest,
  createWorkloadExecutionController,
  CREDENTIAL_GRANT_KIND,
  type CredentialBrokerDriver,
  type CredentialBrokerEndpoint,
  type CredentialGrantResource,
  type CredentialHandleVault,
  type CredentialIssuePayload,
  type CredentialManagementDriver,
  defaultAdmissionPolicyForTrustClass,
  defaultRequestedInterfacesForTrustClass,
  DRIVER_REQUEST_API_VERSION,
  type DriverRequestEnvelope,
  evaluateToolAdmission,
  type ExternalOrchestrationControllerHandle,
  featuresRequiredByClass,
  getAgentProfileRegistry,
  getBuiltinLoopProfiles,
  type IAgentStorage,
  type ILLMProvider,
  type INetworkService,
  issueWorkloadCapabilityGrant,
  type IToolRegistry,
  type LoopRunStartRequest,
  type LoopRuntimeManagementDriver,
  type LoopRuntimePreparePayload,
  type ManagedModelDescriptor,
  type MemeLoopRuntime,
  MODEL_CLASS_API_VERSION,
  MODEL_CLASS_KIND,
  MODEL_ENDPOINT_API_VERSION,
  MODEL_ENDPOINT_KIND,
  type ModelAccessHandleBudget,
  type ModelClassResource,
  type ModelClassSpec,
  type ModelEndpointRegistrarHandle,
  type ModelEndpointResource,
  NETWORK_ATTACHMENT_KIND,
  NETWORK_CLASS_API_VERSION,
  NETWORK_CLASS_KIND,
  type NetworkAttachmentNode,
  type NetworkAttachmentResource,
  type NetworkClassResource,
  type NetworkEnforcementLevel,
  type NetworkPreparePayload,
  OrchestrationError,
  ProviderRegistry,
  registerBuiltinTools,
  restoreArtifactManagementState,
  type SchedulerNode,
  type ScriptTrustClass,
  STORAGE_CLASS_API_VERSION,
  STORAGE_CLASS_KIND,
  type StorageClassResource,
  type StorageDriverEndpoint,
  type StorageManagementDriver,
  TOOL_EXECUTOR_API_VERSION,
  TOOL_EXECUTOR_KIND,
  TOOL_OPERATION_KIND,
  type ToolAdmissionPolicy,
  type ToolExecutorResource,
  type ToolManagementDriver,
  type ToolOperationResource,
  verifyWorkloadCapabilityGrant,
  VOLUME_CLAIM_KIND,
  VOLUME_KIND,
  WORKER_PROTOCOL_VERSION,
  type WorkloadExecutionControllerHandle,
} from 'memeloop';
import { createProviderFromEntry, resolveProviderModelId } from 'memeloop/llm-providers';
import type { NodeConfig } from '../config.js';
import { normalizeAgentDefinition } from '../config.js';
import { type IWikiManager, TiddlyWikiWikiManager } from '../knowledge/wikiManager.js';
import { type DiscoveredExternalDriver, discoverExternalDrivers, registerExternalDriverManifests } from '../orchestration/externalDriverDiscovery.js';
import { createIsolatedArtifactInspector } from '../orchestration/isolatedArtifactInspector.js';
import { createFileManagedStorageStateStore, createLocalDirectoryStorageDriver, LOCAL_DIRECTORY_STORAGE_DRIVER_NAME } from '../orchestration/localDirectoryStorageDriver.js';
import { createManagedScriptArtifactStore, SCRIPT_ARTIFACT_POLICY_DIGEST } from '../orchestration/managedScriptArtifactStore.js';
import { createNodeModelGateway, type NodeModelGateway } from '../orchestration/nodeModelGateway.js';
import { hashWorkerBootstrapToken, loadOrCreateWorkerGatewayKeyPair, type NodeWorkerGatewayKeyPair, verifyWorkerEd25519Signature } from '../orchestration/nodeWorkerSecurity.js';
import { createProcessLoopRuntimeDriver } from '../orchestration/processLoopRuntimeDriver.js';
import { createProcessNetworkDriver, PROCESS_NETWORK_DRIVER_NAME } from '../orchestration/processNetworkDriver.js';
import { createFileScriptArtifactStore, type FileScriptArtifactStore } from '../orchestration/scriptArtifactStore.js';
import { SQLiteControlStore } from '../orchestration/sqliteControlStore.js';
import { createWorkerGatewayHttpHandler, type WorkerGatewayHttpHandler } from '../orchestration/workerGatewayHttpHandler.js';
import { prepareLinuxProcessSandbox } from '../sandbox/linuxProcessSandbox.js';
import { FileCheckpointStore } from '../storage/fileCheckpointStore.js';
import { SQLiteAgentStorage } from '../storage/sqliteStorage.js';
import type { ITerminalSessionManager } from '../terminal/index.js';
import { registerNodeEnvironmentTools } from '../tools/registerNodeEnvironmentTools.js';
import { ToolRegistry } from './toolRegistry.js';

function sha256DriverValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalDriverValue(value)).digest('hex')}`;
}

function managedPolicyForNetworkClass(
  networkClass: NetworkClassResource,
): Omit<NetworkPreparePayload['policy'], 'digest'> {
  const spec = networkClass.spec;
  const serviceAllowlist = [
    ...(spec.serviceAccess?.allowControlPlane ? ['control-plane'] : []),
    ...(spec.serviceAccess?.allowClusterServices ? ['cluster-services'] : []),
    ...(spec.serviceAccess?.allowModelGateway ? ['model-gateway'] : []),
  ];
  return {
    ...(spec.dns
      ? {
        dns: {
          policy: spec.dns.policy ?? 'default',
          ...(spec.dns.servers ? { servers: spec.dns.servers } : {}),
        },
      }
      : {}),
    ...(spec.proxy
      ? {
        proxy: {
          ...(spec.proxy.httpProxy ? { httpProxy: spec.proxy.httpProxy } : {}),
          ...(spec.proxy.httpsProxy ? { httpsProxy: spec.proxy.httpsProxy } : {}),
          ...(spec.proxy.noProxy ? { noProxy: spec.proxy.noProxy } : {}),
          ...(spec.proxy.mandatory !== undefined ? { mandatory: spec.proxy.mandatory } : {}),
        },
      }
      : {}),
    ...(spec.ingress
      ? {
        ingress: {
          defaultAction: spec.ingress.defaultAction ?? 'deny',
          ...(spec.ingress.allow
            ? {
              rules: spec.ingress.allow.map((rule) => ({
                target: rule.from ?? '*',
                ...(rule.ports ? { ports: rule.ports } : {}),
                action: 'allow' as const,
              })),
            }
            : {}),
        },
      }
      : {}),
    ...(spec.egress
      ? {
        egress: {
          defaultAction: spec.egress.defaultAction,
          ...(spec.egress.rules
            ? {
              rules: spec.egress.rules.map((rule) => ({
                target: rule.target,
                ...(rule.ports ? { ports: rule.ports } : {}),
                ...(rule.protocol ? { protocol: rule.protocol } : {}),
                action: rule.action,
              })),
            }
            : {}),
        },
      }
      : {}),
    ...(spec.bandwidth ? { bandwidth: spec.bandwidth } : {}),
    ...(serviceAllowlist.length > 0 ? { serviceAllowlist } : {}),
    ...(spec.dataPolicy?.classification
      ? { dataClassification: spec.dataPolicy.classification }
      : {}),
  };
}

async function registerProvidersFromConfig(
  providerRegistry: ProviderRegistry,
  providers: import('../config.js').ProviderEntry[],
): Promise<void> {
  for (const entry of providers) {
    const provider = await createProviderFromEntry(entry);
    providerRegistry.register(provider);
  }
}

/**
 * Optional overrides merged into `registerBuiltinTools` (peer RPC, `notifyAskQuestion`, etc.).
 */
export type NodeRuntimeBuiltinToolOverrides = Pick<
  BuiltinToolContext,
  | 'getPeers'
  | 'sendRpcToNode'
  | 'mcpCallRemote'
  | 'remoteAgentStreamTimeoutMs'
  | 'notifyAskQuestion'
  | 'localNodeId'
>;

type CoreAgentToolLoopOptions = NonNullable<AgentFrameworkContext['agentToolLoop']>;
type NodeAgentToolLoopSessionCheckpoint = NonNullable<CoreAgentToolLoopOptions['sessionCheckpoint']> & {
  directory?: string;
};

export type NodeAgentToolLoopOptions = Omit<CoreAgentToolLoopOptions, 'sessionCheckpoint'> & {
  sessionCheckpoint?: NodeAgentToolLoopSessionCheckpoint;
};

export interface NodeRuntimeOptions {
  /**
   * YAML-derived config. Defaults to `{}` when embedding with injected `storage` / `llmProvider`.
   * Used for `tools` allowlist/blocklist (unless `toolRegistry` is injected), `providers`, `agents`, timeouts.
   */
  config?: NodeConfig;
  /**
   * Directory for `memeloop.db` when using default SQLite storage.
   * **Required** unless `storage` is injected.
   */
  dataDir?: string;
  /**
   * Absolute path to a host-provided better-sqlite3 N-API addon. This is
   * required by packaged Electron embedders whose native modules live outside
   * app.asar; ordinary Node hosts can omit it.
   */
  sqliteNativeBinding?: string;
  /** Stable node id（ChatSyncEngine、sync RPC 时钟键；与 cloud 注册 id 对齐） */
  localNodeId?: string;
  /**
   * Replace default SQLite with an app-provided store (e.g. TidGi in-memory + wiki IPC).
   * When set, `dataDir` is not used for storage.
   */
  storage?: IAgentStorage;
  /**
   * Replace ProviderRegistry-driven LLM with a custom provider (e.g. Desktop `generateFromAI` bridge).
   * When set, `config.providers` is ignored unless you also register models on `providerRegistry`.
   */
  llmProvider?: ILLMProvider;
  /**
   * When using custom `llmProvider`, optional registry (defaults to empty `ProviderRegistry`).
   * CLI mode builds this from `config.providers` when `llmProvider` is omitted.
   */
  providerRegistry?: ProviderRegistry;
  /**
   * Custom tool registry (e.g. simple Map-based). If omitted, a `ToolRegistry` is created with `config.tools` permissions.
   */
  toolRegistry?: IToolRegistry;
  /**
   * Register app-specific tools before builtins and env tools (e.g. TidGi `zx-script`).
   */
  configureTools?: (registry: IToolRegistry) => void;
  /** Merged into peer fields when `peerConnectionManager` is absent */
  builtinToolContext?: NodeRuntimeBuiltinToolOverrides;
  /** If provided, terminal tools (terminal.execute / list / respond) are registered */
  terminalManager?: ITerminalSessionManager;
  /** Base directory for file.* tools (default cwd) */
  fileBaseDir?: string;
  /**
   * Project memory content (e.g. from memeloop.md). Appended to all agent system prompts.
   * If omitted, CLI auto-loads from `process.cwd()/memeloop.md` (Node-only).
   * Electron embedders should inject this directly.
   */
  projectMemory?: string;
  /** Wiki base path; creates `FileWikiManager`. Ignored if `wikiManager` is set. */
  wikiBasePath?: string;
  /** Embed: use an existing wiki manager instead of `FileWikiManager` (e.g. TidGi TiddlyWiki in worker). */
  wikiManager?: IWikiManager;
  /** 覆盖 config.remoteAgentStreamTimeoutMs */
  remoteAgentStreamTimeoutMs?: number;
  /** 从 Wiki 加载带 MemeLoop AgentDefinition 标签的 tiddler（默认仅 default wiki） */
  wikiAgentDefinitionWikiIds?: string[];
  /** Passed to `registerNodeEnvironmentTools` (CLI default true; Electron worker often false). */
  includeVscodeCli?: boolean;
  network?: INetworkService;
  logger?: AgentFrameworkContext['logger'];
  /** Policy for script-backed loops. Source/dynamic scripts remain opt-in. */
  loopScriptPolicy?: AgentFrameworkContext['loopScriptPolicy'];
  /**
   * Trust class of this node (from `--mode` / worker enrollment). Drives the
   * default script load gate: generated scripts are admitted under this
   * class's policy (plan 24.15/24.17). Defaults to `trusted` (ordinary
   * single-node mode). Ignored when `loopScriptPolicy` is provided.
   */
  trustClass?: ScriptTrustClass;
  agentToolLoop?: Partial<NodeAgentToolLoopOptions>;
  /** Share cancellation set with the host (e.g. worker `cancelAgent`). */
  conversationCancellation?: Set<string>;
  /** Optional controller state store; defaults to dataDir/control.db when dataDir is provided. */
  controlStore?: AgentFrameworkContext['controlStore'];
  /**
   * Plan 24.36: advertise this node's configured models as ModelClass/
   * ModelEndpoint resources with a health heartbeat so the scheduler can
   * place model calls. Enabled by default when a ControlStore is available;
   * set `enabled: false` to opt out.
   */
  modelEndpointRegistration?: {
    enabled?: boolean;
    heartbeatIntervalMs?: number;
    /** Honest provider concurrency advertised to endpoint placement (default 1). */
    maxConcurrent?: number;
    tokensPerMinute?: number;
    /** Placement rejects heartbeats older than this (default 90s). */
    staleAfterMs?: number;
  };
  /**
   * Plan §12 / 24.65: the daemon's trusted ModelGateway. Workers present
   * short-lived ModelAccessHandles instead of provider keys; the gateway
   * enforces Run/model/audience/budget/expiry and writes ModelCallRecords
   * to the ControlStore. Enabled by default when `dataDir` and a
   * ControlStore are available.
   */
  modelGateway?: {
    enabled?: boolean;
    costPerToken?: number;
    currency?: string;
    maxRequestsPerSecond?: number;
    /**
     * Immutable models exposed through the process-local managed-driver
     * surface. Each digest must identify real weights or a provider snapshot;
     * ordinary mutable aliases are intentionally not inferred.
     */
    managedModels?: ManagedModelDescriptor[];
    managedMaxConcurrentCalls?: number;
    managedMaxOutputTokens?: number;
    /**
     * Route loop model calls through the gateway (default true; plan §12.1,
     * 24.35): every chat issues a short-lived handle, is budget-enforced and
     * audited at the gateway, and the handle is revoked at call end. Set
     * false to let loops call the provider directly (legacy direct path).
     */
    routeLoops?: boolean;
    /** Budget stamped into every loop-call handle (enforced at the gateway). */
    loopBudget?: ModelAccessHandleBudget;
  };
  /**
   * Plan 24.62: discover external orchestrator drivers (Swarm/K8s/...) from
   * `<dataDir>/drivers.d/*.json` manifests and register them as DriverManifest
   * resources so the scheduler can discover them. Enabled by default when
   * `dataDir` and a ControlStore are available; a missing directory means no
   * drivers installed (not an error).
   */
  externalDrivers?: {
    enabled?: boolean;
    /** Override the discovery directory (default `<dataDir>/drivers.d`). */
    directory?: string;
  };
  /**
   * Hostile-content inspection boundary for managed artifacts. Electron
   * embedders may inject a UtilityProcess-backed implementation; ordinary
   * Node hosts use the bounded disposable subprocess implementation.
   */
  artifactManagement?: {
    inspector?: ArtifactInspector;
    inspectionIsolation?: 'process' | 'namespace' | 'container' | 'external';
    maxArtifactBytes?: number;
  };
  /**
   * Dedicated outbound worker gateway (§13). The runtime owns identity,
   * enrollment and policy; the embedding host mounts `handler` on the exact
   * public URL supplied here. HTTPS is required outside loopback.
   */
  workerGateway?: {
    enabled?: boolean;
    publicUrl?: string;
    /** PEM CA included only in the native bootstrap Secret for private PKI. */
    caCertificate?: string;
    sessionTtlMs?: number;
  };
  /**
   * Plan 24.14 / Phase 4.2: run the binding controller (scheduler) and the
   * workload execution controller against the ControlStore so applied
   * AgentWorkloads are scheduled onto this node and executed.
   * Enabled by default when a ControlStore is available.
   */
  workloadExecution?: {
    enabled?: boolean;
    /**
     * Honor RuntimeClass `isolation: 'process'` by executing script
     * workloads in a sanitized child process (default true; plan 24.18/24.35).
     * Set false only on hosts without a spawnable Node binary: profile
     * workloads remain available, while process-isolated scripts fail closed
     * instead of silently weakening their RuntimeClass.
     */
    processIsolation?: boolean;
    /** Model gateway endpoint exposed to isolated workers as MEMELOOP_MODEL_GATEWAY. */
    modelGatewayEndpoint?: string;
    /**
     * Host-asserted local scheduling metadata. `name` and `trustClass` always
     * come from the runtime identity and cannot be overridden here.
     */
    localNode?: Omit<Partial<SchedulerNode>, 'name' | 'trustClass'>;
    /**
     * Authoritative multi-node inventory. Supply this from the peer/control
     * plane to schedule beyond the local daemon; the local node is not added
     * implicitly when this callback is present.
     */
    listSchedulerNodes?: () => Promise<SchedulerNode[]>;
    /**
     * Authoritative network-driver inventory used by the singleton attachment
     * binding leader. Multi-node hosts must supply every eligible node here.
     */
    listNetworkAttachmentNodes?: () => Promise<NetworkAttachmentNode[]>;
    /** Authoritative provisioner inventory used by the singleton claim binder. */
    listStorageDriverEndpoints?: () => Promise<StorageDriverEndpoint[]>;
    /**
     * Resolve a provider transport for an independently selected endpoint.
     * Multi-node hosts return a ModelGateway-backed provider here.
     */
    resolveModelProvider?: (
      endpoint: ModelEndpointResource,
      request: import('memeloop').LoopRunStartRequest,
    ) => Promise<ILLMProvider | undefined>;
    /** Resolve a reachable gateway URL/handle for an isolated process worker. */
    resolveModelGatewayEndpoint?: (
      endpoint: ModelEndpointResource,
      request: import('memeloop').LoopRunStartRequest,
    ) => Promise<string | undefined>;
  };
  /** Local ToolOperation scheduling/execution (enabled with ControlStore by default). */
  toolExecution?: {
    enabled?: boolean;
    maxConcurrent?: number;
    maxOutputLength?: number;
    /** Host-bound admission. Restricted/quarantine default deny when omitted. */
    admission?: ToolAdmissionPolicy;
    /** Authenticated host/user approval boundary for require-approval decisions. */
    approvalBroker?: import('memeloop').ToolOperationApprovalBroker;
  };
  /**
   * Host-owned JIT credential broker. Tokens remain in the injected vault and
   * are never persisted in ControlStore or child-process environment.
   */
  credentialBroker?: {
    driver: CredentialBrokerDriver;
    vault: CredentialHandleVault;
    brokerClass: string;
    audiences: string[];
    methods?: string[];
    targets?: string[];
    maxGrants?: number;
    /** Maximum lifetime accepted by the managed broker route. */
    maxTtlMs?: number;
    listBrokers?: () => Promise<CredentialBrokerEndpoint[]>;
    /**
     * Verify worker-key enrollment/ownership and any host policy not encoded
     * in AgentWorkload. Return true to allow or a denial reason to reject.
     */
    authorizeGrant(
      grant: CredentialGrantResource,
      run: AgentRunResource,
      workload: AgentWorkloadResource,
    ): Promise<true | string>;
  };
}

export interface NodeToolOperationControllers {
  binding: ControllerRunnerHandle;
  execution: ControllerRunnerHandle;
  stop(): Promise<void>;
}

export interface NodeNetworkAttachmentControllers {
  binding: ControllerRunnerHandle;
  execution: ControllerRunnerHandle;
  stop(): Promise<void>;
}

export interface NodeCredentialGrantControllers {
  binding: ControllerRunnerHandle;
  execution: ControllerRunnerHandle;
  lifecycle: ControllerRunnerHandle;
  stop(): Promise<void>;
}

export interface NodeVolumeControllers {
  binding: ControllerRunnerHandle;
  provisioning: ControllerRunnerHandle;
  publishing: ControllerRunnerHandle;
  stop(): Promise<void>;
}

export interface NodeRuntimeResult {
  /**
   * Stop every controller/registrar started by this runtime and close stores
   * it created. Injected stores remain owned by the embedding host.
   */
  stop(): Promise<void>;
  runtime: MemeLoopRuntime;
  storage: IAgentStorage;
  controlStore?: ControlStore;
  providerRegistry: ProviderRegistry;
  toolRegistry: IToolRegistry;
  context: AgentFrameworkContext;
  wikiManager?: IWikiManager;
  /** 供 RPC `memeloop.agent.getDefinitions` 使用 */
  agentDefinitions: AgentDefinition[];
  /** 与 `file.*` RPC 一致的根目录 */
  fileBaseDirResolved: string;
  /** 已连接 peer 时可用于 `syncEngine.syncOnce()` */
  syncEngine?: ChatSyncEngine;
  /** Wiki 中 Agent 定义变更后可调用以合并进内存与 SQLite */
  refreshWikiAgentDefinitions?: () => Promise<void>;
  /** Effective trust class used for the default script load gate. */
  workerTrustClass: ScriptTrustClass;
  /**
   * Plan 24.36: heartbeat registrar keeping this node's ModelEndpoint
   * resources healthy/current in the ControlStore. Present when a
   * ControlStore is available and registration is not disabled. Call
   * `stop()` on shutdown to mark endpoints unhealthy.
   */
  modelEndpointRegistrar?: ModelEndpointRegistrarHandle;
  /**
   * Plan §12 / 24.65: daemon model gateway + handle broker. Present when
   * `dataDir` and a ControlStore are available and not disabled.
   */
  modelGateway?: NodeModelGateway;
  /**
   * Process-local managed lifecycle used by the workload controller. Its
   * handles are not adoptable after daemon restart.
   */
  managedLoopRuntimeDriver?: LoopRuntimeManagementDriver;
  /**
   * Host-persistent managed credential route. Raw signed tokens remain in the
   * injected CredentialHandleVault and are never returned through this API.
   */
  managedCredentialDriver?: CredentialManagementDriver;
  /** Host-persistent managed Controller/Node route for the local storage driver. */
  managedStorageDriver?: StorageManagementDriver;
  /** Process-local managed catalog/execution lifecycle for host tools. */
  managedToolDriver?: ToolManagementDriver;
  /** Dedicated restricted/quarantine worker bootstrap and message boundary. */
  workerGateway?: {
    handler: WorkerGatewayHttpHandler;
    publicKey: string;
    publicKeyFingerprint: string;
  };
  /**
   * Plan 24.62: external orchestrator drivers discovered from `drivers.d`
   * manifests and registered into the ControlStore (empty when none
   * installed). Present when discovery is enabled.
   */
  externalDrivers?: DiscoveredExternalDriver[];
  /** Routes explicitly external workloads/operations and mirrors native status. */
  externalOrchestrationController?: ExternalOrchestrationControllerHandle;
  /** Independent local ToolOperation binding and fenced execution controllers. */
  toolOperationControllers?: NodeToolOperationControllers;
  /** Binding (scheduler) controller runner; stop on shutdown. */
  bindingControllerRunner?: ControllerRunnerHandle;
  /** Independently selects and fences ModelEndpoint bindings for AgentRuns. */
  modelEndpointBindingControllerRunner?: ControllerRunnerHandle;
  /** Independently binds, prepares, and releases local NetworkAttachments. */
  networkAttachmentControllers?: NodeNetworkAttachmentControllers;
  /** Independently binds, issues, and revokes scoped CredentialGrants. */
  credentialGrantControllers?: NodeCredentialGrantControllers;
  /** Independently binds/provisions claims and publishes Run volumes. */
  volumeControllers?: NodeVolumeControllers;
  /** Workload execution controller; stop on shutdown (cancels active loops). */
  workloadExecutionController?: WorkloadExecutionControllerHandle;
  /**
   * Production script artifact store (plan 24.15): content-addressed,
   * hash-verified persistence for generated-script ArtifactRecords.
   * Present when `dataDir` is provided. Pass to `deployGeneratedScript`
   * as `{ artifactStore }`.
   */
  scriptArtifactStore?: FileScriptArtifactStore;
  /** Host-persistent Artifact lifecycle with process-isolated inspection. */
  managedArtifactDriver?: ArtifactManagementDriver;
}

const noopNetwork: INetworkService = {
  async start() {},
  async stop() {},
};

const defaultLogger: NonNullable<AgentFrameworkContext['logger']> = {
  warn: (...arguments_: unknown[]) => {
    console.warn('[memeloop-cli]', ...arguments_);
  },
  error: (...arguments_: unknown[]) => {
    console.error('[memeloop-cli]', ...arguments_);
  },
};

/**
 * Build MemeLoopRuntime + storage + LLM + IToolRegistry with optional injection for embedders (SDK).
 *
 * **CLI default:** pass `config` + `dataDir` → SQLite + `config.providers` + `ToolRegistry(config.tools)`.
 *
 * **Embed (e.g. TidGi-Desktop):** pass `storage` + `llmProvider` + optional `toolRegistry` / `configureTools` /
 * `builtinToolContext` / `wikiManager`; `config` and `dataDir` may be omitted.
 */
export async function createNodeRuntime(options: NodeRuntimeOptions): Promise<NodeRuntimeResult> {
  if (
    options.workerGateway?.caCertificate &&
    Buffer.byteLength(options.workerGateway.caCertificate, 'utf8') > 8 * 1024
  ) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'worker gateway CA certificate exceeds the 8 KiB bootstrap bound',
      retryable: false,
    });
  }
  const config = options.config ?? {};

  let storage: IAgentStorage;
  let ownedStorage: SQLiteAgentStorage | undefined;
  if (options.storage) {
    storage = options.storage;
  } else {
    if (!options.dataDir) {
      throw new Error(
        'createNodeRuntime: provide `dataDir` for SQLite storage, or inject `storage`',
      );
    }
    const databasePath = path.join(options.dataDir, 'memeloop.db');
    ownedStorage = new SQLiteAgentStorage({
      filename: databasePath,
      nativeBinding: options.sqliteNativeBinding,
    });
    storage = ownedStorage;
  }

  const ownedControlStore = !options.controlStore && options.dataDir
    ? new SQLiteControlStore({
      filename: path.join(options.dataDir, 'control.db'),
      nativeBinding: options.sqliteNativeBinding,
      authorizer: {
        authorize(request) {
          if (request.actor.kind === 'admin' || request.actor.kind === 'controller' || request.actor.kind === 'verifier') return;
          throw new OrchestrationError({
            code: 'FORBIDDEN',
            message: `actor '${request.actor.id}' cannot ${request.verb} ControlStore resources`,
            retryable: false,
          });
        },
      },
    })
    : undefined;
  const controlStore = options.controlStore ?? ownedControlStore;

  // Script deployment security chain (plan 24.15): generated scripts are
  // admitted by the load gate under this node's trust class, and admitted
  // artifacts persist through the content-addressed file store.
  const workerTrustClass: ScriptTrustClass = options.trustClass ?? 'trusted';
  let managedArtifactDriver: ArtifactManagementDriver | undefined;
  let scriptArtifactStore: FileScriptArtifactStore | undefined;
  if (options.dataDir) {
    const maxArtifactBytes = options.artifactManagement?.maxArtifactBytes ??
      1024 * 1024;
    const mirror = createFileScriptArtifactStore({ dataDir: options.dataDir });
    const stateStore = createFileManagedStorageStateStore(
      path.join(options.dataDir, 'artifacts', '.managed-state'),
    );
    const savedState = await stateStore.get('artifact-management:v1');
    const state = savedState === undefined
      ? createFakeArtifactManagementState()
      : await restoreArtifactManagementState(
        savedState as ArtifactManagementStateSnapshot,
      );
    const artifactCapability = `capability:artifact:${randomBytes(32).toString('hex')}`;
    const artifactSession = `node-artifact:${randomBytes(16).toString('hex')}`;
    managedArtifactDriver = createManagedArtifactDriverAdapter({
      state,
      inspector: options.artifactManagement?.inspector ??
        createIsolatedArtifactInspector({
          maxInputBytes: maxArtifactBytes,
          timeoutMs: 5000,
          maxOldSpaceSizeMb: 64,
        }),
      name: `${(options.localNodeId ?? 'memeloop-local').trim() || 'memeloop-local'}-artifacts`,
      maxArtifactBytes,
      inspectionIsolation: options.artifactManagement?.inspectionIsolation ??
        'process',
      persistence: 'host',
      authorizeRequest: (request) =>
        request.capabilityHandleRef === artifactCapability &&
        request.session?.id === artifactSession,
      persistState: (snapshot) => stateStore.put('artifact-management:v1', snapshot),
      reviewer: 'verifier/node-artifact-inspector',
      destinationPolicies: {
        volume: {
          minimumTrust: 'untrusted',
          policyDigest: SCRIPT_ARTIFACT_POLICY_DIGEST,
          requiredReviews: ['scan', 'verify'],
        },
      },
      threatAssumptions: [
        'the private atomically replaced host state and controller are trusted',
        'hostile content is parsed only in a disposable memory- and time-bounded Node subprocess',
        'archives are rejected instead of being expanded by the reference inspector',
      ],
    });
    scriptArtifactStore = createManagedScriptArtifactStore({
      driver: managedArtifactDriver,
      mirror,
      capabilityHandleRef: artifactCapability,
      sessionId: artifactSession,
      actorId: `controller/artifact-${(options.localNodeId ?? 'memeloop-local').trim() || 'memeloop-local'}`,
    });
  }
  const defaultLoopScriptPolicy: AgentFrameworkContext['loopScriptPolicy'] = {
    // Source scripts are allowed to reach the gate; the gate applies
    // AST validation + trust-class admission before any import().
    allowSource: true,
    scriptLoadGate: createScriptLoadGate({
      authorTrust: workerTrustClass,
      requestedInterfaces: defaultRequestedInterfacesForTrustClass(workerTrustClass),
    }),
  };

  // Load project memory: prefer injected value, fallback to file (Node-only)
  let projectMemory = options.projectMemory ?? '';
  if (!projectMemory) {
    try {
      const memoryPath = path.join(process.cwd(), 'memeloop.md');
      if (fs.existsSync(memoryPath)) {
        projectMemory = fs.readFileSync(memoryPath, 'utf-8').trim();
      }
    } catch {
      // ignore read errors
    }
  }

  const builtinDefs = getBuiltinLoopProfiles();
  const fromConfig = (config.agents ?? []).map(normalizeAgentDefinition);
  const definitionById = new Map<string, AgentDefinition>();
  for (const d of builtinDefs) {
    definitionById.set(d.id, {
      ...d,
      systemPrompt: d.systemPrompt ?? '',
      tools: d.tools ?? [],
      version: d.version ?? '1',
    });
  }
  for (const d of fromConfig) {
    definitionById.set(d.id, d);
  }

  // Append project memory to all agent system prompts
  if (projectMemory) {
    for (const [id, definition] of definitionById) {
      if (definition.systemPrompt) {
        definitionById.set(id, {
          ...definition,
          systemPrompt: `${definition.systemPrompt}\n\n--- Project Memory ---\n${projectMemory}`,
        });
      }
    }
  }
  const agentDefinitions: AgentDefinition[] = [];
  const rebuildAgentDefinitionsList = (): void => {
    agentDefinitions.length = 0;
    agentDefinitions.push(...definitionById.values());
  };
  rebuildAgentDefinitionsList();
  if (storage instanceof SQLiteAgentStorage) {
    storage.seedAgentDefinitions(agentDefinitions);
  }

  let providerRegistry: ProviderRegistry;
  let llmProvider: ILLMProvider;

  if (options.llmProvider) {
    providerRegistry = options.providerRegistry ?? new ProviderRegistry();
    llmProvider = options.llmProvider;
  } else {
    providerRegistry = options.providerRegistry ?? new ProviderRegistry();
    await registerProvidersFromConfig(providerRegistry, config.providers ?? []);
    const defaultModelId = config.providers?.[0]
      ? resolveProviderModelId(config.providers[0])
      : 'default';
    const { provider } = providerRegistry.resolve(defaultModelId);
    llmProvider = provider;
  }

  const toolRegistry: IToolRegistry = options.toolRegistry ?? new ToolRegistry(config.tools);

  if (options.configureTools) {
    options.configureTools(toolRegistry);
  }

  const conversationCancellation = options.conversationCancellation ?? new Set<string>();
  const network = options.network ?? noopNetwork;
  const logger = options.logger ?? defaultLogger;
  const terminalManager = options.terminalManager;

  const { sessionCheckpoint, ...agentToolLoopOverrides } = options.agentToolLoop ?? {};
  const checkpointDirectory = sessionCheckpoint?.directory ??
    (sessionCheckpoint?.enabled && options.dataDir
      ? path.join(options.dataDir, 'sessions')
      : undefined);
  const checkpointStore = sessionCheckpoint?.store ??
    (checkpointDirectory ? new FileCheckpointStore({ directory: checkpointDirectory }) : undefined);

  const agentToolLoopConfig: CoreAgentToolLoopOptions = {
    ...agentToolLoopOverrides,
    maxIterations: options.agentToolLoop?.maxIterations ?? 32,
    isCancelled: options.agentToolLoop?.isCancelled ?? ((cid: string) => conversationCancellation.has(cid)),
    waitForTerminalSession: options.agentToolLoop?.waitForTerminalSession ??
      (terminalManager
        ? (sessionId) =>
          new Promise((resolve) => {
            const finish = (info: import('../terminal/types.js').TerminalSessionInfo) => {
              resolve({
                exitCode: info.exitCode,
                truncatedOutput: terminalManager.getOutputText(sessionId, { tailChars: 12_000 }),
              });
            };
            const current = terminalManager.get(sessionId);
            if (current && current.status !== 'running') {
              finish(current);
              return;
            }
            const off = terminalManager.onSessionComplete((sid, info) => {
              if (sid !== sessionId) return;
              off();
              finish(info);
            });
          })
        : undefined),
  };

  if (sessionCheckpoint) {
    agentToolLoopConfig.sessionCheckpoint = {
      enabled: sessionCheckpoint.enabled,
      store: checkpointStore,
    };
  }

  // Seed per-agent tool permissions from registered task delegation profiles.
  const agentProfileRegistry = getAgentProfileRegistry();
  const perAgent: NonNullable<
    NonNullable<AgentFrameworkContext['agentToolLoop']>['toolPermissions']
  >['perAgent'] = {};
  for (const profile of agentProfileRegistry.listAgentProfiles()) {
    perAgent[profile.id] = {
      default: profile.permissions.default,
      rules: profile.permissions.rules,
    };
  }
  agentToolLoopConfig.toolPermissions = {
    default: 'allow',
    rules: [],
    perAgent,
  };

  const syncNodeId = (options.localNodeId ?? 'memeloop-local').trim() || 'memeloop-local';

  const orchestrationClient = controlStore
    ? createControlStoreOrchestrationClient(controlStore, {
      id: `controller/runtime-manager-${syncNodeId}`,
      kind: 'controller',
    })
    : undefined;
  const context: AgentFrameworkContext = {
    storage,
    llmProvider,
    tools: toolRegistry,
    syncAdapters: [],
    network,
    controlStore,
    orchestration: orchestrationClient,
    loopCheckpoints: controlStore
      ? createControlStoreLoopCheckpointStore(controlStore, {
        id: `controller/${(options.localNodeId ?? 'memeloop-local').trim() || 'memeloop-local'}`,
        kind: 'controller',
      })
      : undefined,
    logger,
    loopScriptPolicy: options.loopScriptPolicy ?? defaultLoopScriptPolicy,
    // Plan 24.14: scripts deploy through ctx.scriptClient; trust class and
    // interface ceilings stay host-bound here, never script-controlled. The
    // ControlStore-backed facade lets the scheduler bind deployments.
    scriptDeployment: {
      authorTrust: workerTrustClass,
      requestedInterfaces: defaultRequestedInterfacesForTrustClass(workerTrustClass),
      artifactStore: scriptArtifactStore,
      orchestration: orchestrationClient,
    },
    agentToolLoop: agentToolLoopConfig,
    conversationCancellation,
    resolveAgentDefinition: async (definitionId) => {
      const hit = definitionById.get(definitionId);
      if (hit) return hit;
      return storage.getAgentDefinition(definitionId);
    },
  };

  const runLocalAgent = createAgentToolLoopRunner(context);

  const embedBuiltin = options.builtinToolContext ?? {};
  const streamTimeout = options.remoteAgentStreamTimeoutMs ??
    embedBuiltin.remoteAgentStreamTimeoutMs ??
    config.remoteAgentStreamTimeoutMs ??
    30_000;

  const builtinToolContext: BuiltinToolContext = {
    ...context,
    localNodeId: embedBuiltin.localNodeId ?? syncNodeId,
    runLocalAgent,
    getPeers: embedBuiltin.getPeers,
    sendRpcToNode: embedBuiltin.sendRpcToNode,
    mcpCallRemote: embedBuiltin.mcpCallRemote,
    remoteAgentStreamTimeoutMs: streamTimeout,
    notifyAskQuestion: embedBuiltin.notifyAskQuestion,
  };
  registerBuiltinTools(toolRegistry, builtinToolContext);

  const fileBaseResolved = options.fileBaseDir ?? config.fileBaseDir ?? process.cwd();

  let wikiManager: IWikiManager | undefined;
  let refreshWikiAgentDefinitions: (() => Promise<void>) | undefined;

  if (options.wikiManager) {
    wikiManager = options.wikiManager;
  } else if (options.wikiBasePath) {
    wikiManager = new TiddlyWikiWikiManager(options.wikiBasePath);
  }

  if (wikiManager) {
    const currentWikiManager = wikiManager;
    const wikiIds = options.wikiAgentDefinitionWikiIds?.length && options.wikiAgentDefinitionWikiIds.length > 0
      ? options.wikiAgentDefinitionWikiIds
      : ['default'];
    refreshWikiAgentDefinitions = async () => {
      for (const wid of wikiIds) {
        currentWikiManager.clearWikiCache(wid);
      }
      for (const wid of wikiIds) {
        const defs = await currentWikiManager.listAgentDefinitionsFromWiki(wid);
        for (const d of defs) {
          definitionById.set(d.id, d);
        }
      }
      rebuildAgentDefinitionsList();
      if (storage instanceof SQLiteAgentStorage) {
        storage.seedAgentDefinitions(agentDefinitions);
      }
    };
    void refreshWikiAgentDefinitions().catch((error: unknown) => {
      context.logger?.warn?.('wiki agent definitions load failed', error);
    });
  }

  registerNodeEnvironmentTools(toolRegistry, {
    terminalManager: options.terminalManager,
    fileBaseDir: fileBaseResolved,
    wikiManager,
    wikiDefaultId: 'default',
    includeVscodeCli: options.includeVscodeCli !== false,
    storage,
    nodeId: syncNodeId,
  });

  const runtime = createMemeLoopRuntime(context);

  // Plan 24.36: advertise this node's models as ModelClass/ModelEndpoint
  // resources and keep their health/heartbeat fresh so the scheduler can
  // place model calls. Trust and node identity stay host-bound.
  const configuredModels: ModelClassSpec[] = (config.providers ?? []).flatMap((entry) =>
    Object.entries(entry.models ?? {}).map(([modelId, model]) => ({
      provider: entry.name,
      model: model.name || modelId,
      ...(model.limit?.context ? { contextWindow: model.limit.context } : {}),
    }))
  );
  // `ILLMProvider.model` is often an AI SDK model factory/object. It is a
  // runtime capability, not serializable orchestration metadata. Persist only
  // the explicit modelId (or a stable host/provider fallback) in ModelClass.
  const advertisedModelId = llmProvider.modelId ??
    (typeof llmProvider.model === 'string' ? llmProvider.model : undefined) ??
    config.providers?.[0]?.name ??
    llmProvider.name ??
    'default';
  const advertisedModels = configuredModels.length > 0
    ? configuredModels
    : [{ provider: llmProvider.name, model: advertisedModelId }];
  let modelEndpointRegistrar: ModelEndpointRegistrarHandle | undefined;
  if (controlStore && options.modelEndpointRegistration?.enabled !== false) {
    const driver = createModelProviderDriverFromLLMProvider(llmProvider, { models: advertisedModels });
    modelEndpointRegistrar = createModelEndpointRegistrar(controlStore, driver, {
      actor: { id: `controller/model-registrar-${syncNodeId}`, kind: 'controller' },
      advertisement: {
        nodeId: syncNodeId,
        trust: workerTrustClass,
        capacity: {
          maxConcurrent: options.modelEndpointRegistration?.maxConcurrent ?? 1,
          ...(options.modelEndpointRegistration?.tokensPerMinute !== undefined
            ? { tokensPerMinute: options.modelEndpointRegistration.tokensPerMinute }
            : {}),
        },
      },
      ...(options.modelEndpointRegistration?.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: options.modelEndpointRegistration.heartbeatIntervalMs }
        : {}),
      onError: (error) => logger.warn?.('model endpoint registration tick failed', error),
    });
  }

  // Plan §12 / 24.65: the daemon's trusted ModelGateway. The executor holds
  // the provider credentials inside the daemon; workers receive short-lived
  // handles from the broker and never see provider keys (24.35).
  let modelGateway: NodeModelGateway | undefined;
  if (controlStore && options.dataDir && options.modelGateway?.enabled !== false) {
    modelGateway = createNodeModelGateway({
      dataDir: options.dataDir,
      nodeId: syncNodeId,
      actor: { id: `controller/model-gateway-${syncNodeId}`, kind: 'controller' },
      controlStore,
      executor: createModelProviderDriverFromLLMProvider(llmProvider, {
        models: advertisedModels,
        // Accept both raw string chunks and { content } delta objects so
        // routed loops see the same text as the direct provider path.
        toDelta: (chunk) => {
          if (typeof chunk === 'string') return chunk;
          if (chunk != null && typeof chunk === 'object' && 'content' in chunk) {
            const content = (chunk as { content?: unknown }).content;
            if (typeof content === 'string') return content;
          }
          return undefined;
        },
      }),
      ...(options.modelGateway?.costPerToken !== undefined ? { costPerToken: options.modelGateway.costPerToken } : {}),
      ...(options.modelGateway?.currency !== undefined ? { currency: options.modelGateway.currency } : {}),
      ...(options.modelGateway?.maxRequestsPerSecond !== undefined
        ? { maxRequestsPerSecond: options.modelGateway.maxRequestsPerSecond }
        : {}),
      ...(options.modelGateway?.managedModels !== undefined
        ? { managedModels: options.modelGateway.managedModels }
        : {}),
      ...(options.modelGateway?.managedMaxConcurrentCalls !== undefined
        ? {
          managedMaxConcurrentCalls: options.modelGateway.managedMaxConcurrentCalls,
        }
        : {}),
      ...(options.modelGateway?.managedMaxOutputTokens !== undefined
        ? {
          managedMaxOutputTokens: options.modelGateway.managedMaxOutputTokens,
        }
        : {}),
      onError: (error) => logger.warn?.('model gateway error', error),
    });
  }

  // Plan §12.1 / 24.35: route loop model calls through the gateway by
  // default — the direct provider path is the exception (§12.3), not the
  // default. Loops keep the ILLMProvider surface; each chat issues and
  // revokes a short-lived handle and is audited in the ControlStore.
  if (modelGateway && options.modelGateway?.routeLoops !== false) {
    const primaryAdvertisement = advertisedModels[0];
    const rawModelName = llmProvider.modelId ??
      (typeof llmProvider.model === 'string' ? llmProvider.model : undefined) ??
      primaryAdvertisement?.model;
    const modelClassName = primaryAdvertisement
      ? `${primaryAdvertisement.provider}-${primaryAdvertisement.model}`
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'model'
      : 'default';
    context.llmProvider = createGatewayMediatedLLMProvider({
      gateway: modelGateway.gateway,
      broker: modelGateway.broker,
      modelClassRef: { apiVersion: MODEL_CLASS_API_VERSION, kind: MODEL_CLASS_KIND, name: modelClassName },
      name: llmProvider.name,
      modelId: typeof rawModelName === 'string' ? rawModelName : modelClassName,
      model: llmProvider.model,
      ...(options.modelGateway?.loopBudget !== undefined ? { budget: options.modelGateway.loopBudget } : {}),
    });
  }

  // Plan §13 / 24.62: dedicated worker gateway. The host mounts this handler
  // on workerGateway.publicUrl; external workers receive only a short-lived
  // one-time enrollment secret through the orchestrator's native Secret.
  let workerGateway: NodeRuntimeResult['workerGateway'];
  let workerGatewayKeys: NodeWorkerGatewayKeyPair | undefined;
  if (
    controlStore &&
    options.dataDir &&
    options.workerGateway?.enabled !== false
  ) {
    workerGatewayKeys = loadOrCreateWorkerGatewayKeyPair(options.dataDir);
    const workerGatewayActor = {
      id: `controller/worker-gateway-${syncNodeId}`,
      kind: 'controller' as const,
    };
    const handler = createWorkerGatewayHttpHandler({
      store: controlStore,
      actor: workerGatewayActor,
      gatewayKeyFingerprint: workerGatewayKeys.publicKeyFingerprint,
      signBootstrap: (payload) => workerGatewayKeys!.sign(payload),
      ...(options.workerGateway?.sessionTtlMs !== undefined
        ? { maxSessionTtlMs: options.workerGateway.sessionTtlMs }
        : {}),
      async dispatch({ requestId, session, method, target, payload }) {
        if (method === 'assignment.pull') {
          const runs = await controlStore.list<AgentRunResource['spec'], AgentRunResource['status']>({
            apiVersion: AGENT_RUN_API_VERSION,
            kind: AGENT_RUN_KIND,
          });
          const run = runs.items.find((candidate) => candidate.metadata.uid === session.run.uid);
          if (!run) {
            throw new OrchestrationError({
              code: 'NOT_FOUND',
              message: 'worker assignment Run is unavailable',
              retryable: false,
            });
          }
          const workload = await controlStore.get<AgentWorkloadResource['spec'], AgentWorkloadResource['status']>({
            apiVersion: run.spec.workloadRef.apiVersion,
            kind: run.spec.workloadRef.kind,
            name: run.spec.workloadRef.name,
            namespace: run.spec.workloadRef.namespace ?? run.metadata.namespace,
          }) as AgentWorkloadResource | null;
          if (!workload || workload.metadata.uid !== run.spec.workloadRef.uid) {
            throw new OrchestrationError({
              code: 'FORBIDDEN',
              message: 'worker assignment workload identity is unavailable',
              retryable: false,
            });
          }
          if (!workload.spec.profileId) {
            throw new OrchestrationError({
              code: 'UNSUPPORTED',
              message: 'worker assignment is not a profile workload',
              retryable: false,
            });
          }
          return {
            profileId: workload.spec.profileId,
            prompt: run.spec.promptReference ??
              workload.spec.promptReference ??
              workload.metadata.name,
          };
        }
        if (method !== 'capability.request') {
          throw new OrchestrationError({
            code: 'FORBIDDEN',
            message: `worker method '${method}' is not configured on this host`,
            retryable: false,
          });
        }
        const request = payload as {
          kind?: unknown;
          input?: {
            profileId?: unknown;
            profile?: unknown;
            prompt?: unknown;
          };
        };
        const profileId = typeof request.input?.profileId === 'string'
          ? request.input.profileId
          : typeof request.input?.profile === 'string'
          ? request.input.profile
          : undefined;
        if (
          request.kind !== 'runAgent' ||
          !profileId ||
          typeof request.input?.prompt !== 'string' ||
          profileId.length > 256 ||
          request.input.prompt.length > 16_384 ||
          !context.runChildAgent
        ) {
          throw new OrchestrationError({
            code: 'INVALID',
            message: 'worker runAgent capability request is malformed',
            retryable: false,
          });
        }
        const grantId = `cap-${
          createHash('sha256')
            .update(`${session.name}\0${requestId}`, 'utf8')
            .digest('hex')
            .slice(0, 40)
        }`;
        const channelBinding = `gateway-key:${workerGatewayKeys!.publicKeyFingerprint}`;
        const grant = await issueWorkloadCapabilityGrant(
          controlStore,
          workerGatewayActor,
          {
            grantId,
            session,
            channelBinding,
            protocolMethod: 'capability.request',
            capability: 'runAgent',
            target,
            budget: {
              maxRequests: 1,
              maxInputBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
              maxOutputBytes: 256 * 1024,
            },
            ttlMs: 60_000,
          },
          (message) => workerGatewayKeys!.sign(message),
        );
        await verifyWorkloadCapabilityGrant(
          grant,
          {
            grantId,
            sessionName: session.name,
            run: session.run,
            workerKeyFingerprint: session.workerKeyFingerprint,
            channelBinding,
            audience: session.audience,
            protocol: session.protocol,
            protocolMethod: 'capability.request',
            capability: 'runAgent',
            target,
            policyDigest: session.policyDigest,
          },
          (message, signature) => verifyWorkerEd25519Signature(workerGatewayKeys!.publicKey, message, signature),
        );
        await consumeWorkloadCapabilityGrant(controlStore, workerGatewayActor, grant);
        const conversationId = `external:${session.run.uid}:${session.run.attempt}:${session.run.epoch}`;
        const steps = [];
        let text = '';
        for await (
          const step of context.runChildAgent({
            profileId,
            prompt: request.input.prompt,
            conversationId,
          })
        ) {
          steps.push(step);
          if (step.type === 'message' && typeof step.data === 'string') text += step.data;
          if (Buffer.byteLength(JSON.stringify({ steps, text }), 'utf8') > 256 * 1024) {
            throw new OrchestrationError({
              code: 'EXHAUSTED',
              message: 'worker child-agent response exceeds 256 KiB',
              retryable: false,
            });
          }
        }
        return { profileId, conversationId, steps, text };
      },
      onError: (error) => logger.warn?.('worker gateway error', error),
    });
    workerGateway = {
      handler,
      publicKey: workerGatewayKeys.publicKey,
      publicKeyFingerprint: workerGatewayKeys.publicKeyFingerprint,
    };
  }

  // Plan 24.62: external orchestrator driver discovery (CNI-analogue
  // manifests in drivers.d) and ControlStore DriverManifest registration.
  let externalDrivers: DiscoveredExternalDriver[] | undefined;
  let externalOrchestrationController: ExternalOrchestrationControllerHandle | undefined;
  if (controlStore && options.dataDir && options.externalDrivers?.enabled !== false) {
    const discoveryDirectory = options.externalDrivers?.directory ?? path.join(options.dataDir, 'drivers.d');
    const discovery = await discoverExternalDrivers({ directory: discoveryDirectory });
    for (const discoveryError of discovery.errors) {
      logger.warn?.(`external driver manifest '${discoveryError.file}' skipped: ${discoveryError.error}`);
    }
    if (discovery.drivers.length > 0) {
      const registration = await registerExternalDriverManifests(
        controlStore,
        { id: `controller/driver-registry-${syncNodeId}`, kind: 'controller' },
        discovery.drivers,
      );
      for (const registrationError of registration.errors) {
        logger.warn?.(`external driver '${registrationError.name}' registration failed: ${registrationError.error}`);
      }
    }
    externalDrivers = discovery.drivers;
    externalOrchestrationController = createExternalOrchestrationController(controlStore, {
      actor: { id: `controller/external-orchestration-${syncNodeId}`, kind: 'controller' },
      drivers: discovery.drivers,
      resolveScriptSource: async (reference) => {
        if (!scriptArtifactStore) return undefined;
        const digestHex = reference.replace(/^sha256:/, '');
        if (!/^[a-f0-9]{64}$/.test(digestHex)) return undefined;
        return scriptArtifactStore.readArtifactContent(`script-${digestHex}`);
      },
      ...(options.workerGateway?.publicUrl && workerGatewayKeys
        ? {
          async createWorkerBootstrap(workload, runReference) {
            const gatewayUrl = new URL(options.workerGateway?.publicUrl ?? '');
            const loopback = gatewayUrl.hostname === '127.0.0.1' ||
              gatewayUrl.hostname === '::1' ||
              gatewayUrl.hostname === 'localhost';
            if (gatewayUrl.protocol !== 'https:' && !(gatewayUrl.protocol === 'http:' && loopback)) {
              throw new OrchestrationError({
                code: 'INVALID',
                message: 'external worker gateway must use HTTPS outside loopback',
                retryable: false,
              });
            }
            const run = await controlStore.get<AgentRunResource['spec'], AgentRunResource['status']>(
              runReference,
            ) as AgentRunResource | null;
            if (!run) {
              throw new OrchestrationError({
                code: 'NOT_FOUND',
                message: `external AgentRun '${runReference.name ?? ''}' is unavailable for worker enrollment`,
                retryable: true,
              });
            }
            const token = randomBytes(32).toString('base64url');
            const enrollmentName = `enroll-${
              workload.metadata.uid
                .toLowerCase()
                .replaceAll(/[^a-z0-9-]/g, '-')
                .slice(0, 40)
            }-${randomBytes(6).toString('hex')}`;
            const now = new Date();
            const ttlMs = Math.min(
              options.workerGateway?.sessionTtlMs ?? 15 * 60 * 1000,
              60 * 60 * 1000,
            );
            await controlStore.create(
              { id: `controller/worker-enrollment-${syncNodeId}`, kind: 'controller' },
              createWorkerEnrollmentManifest(enrollmentName, {
                nodeRef: {
                  apiVersion: 'nodes.memeloop.io/v1alpha1',
                  kind: 'Node',
                  name: syncNodeId,
                },
                trustClass: workload.spec.trust ?? 'restricted',
                expectedGateway: gatewayUrl.toString().replace(/\/$/, ''),
                gatewayKeyFingerprint: workerGatewayKeys.publicKeyFingerprint,
                audience: `worker-gateway://${syncNodeId}`,
                allowedProtocol: WORKER_PROTOCOL_VERSION,
                run: {
                  uid: run.metadata.uid,
                  // An AgentRun is itself the immutable root attempt. Its
                  // `spec.retry` is retry policy/count, not the attempt ID.
                  attempt: 1,
                  epoch: Math.max(1, workload.metadata.generation),
                },
                policyDigest: `sha256:${
                  createHash('sha256')
                    .update(JSON.stringify(workload.spec), 'utf8')
                    .digest('hex')
                }`,
                allowedMethods: ['assignment.pull', 'capability.request'],
                allowedTargets: [run.metadata.uid],
                bootstrapTokenHash: hashWorkerBootstrapToken(token),
                enrolledBy: `controller/worker-enrollment-${syncNodeId}`,
                expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
              }),
            );
            return {
              apiVersion: WORKER_PROTOCOL_VERSION,
              gatewayUrl: gatewayUrl.toString().replace(/\/$/, ''),
              gatewayPublicKey: workerGatewayKeys.publicKey,
              gatewayKeyFingerprint: workerGatewayKeys.publicKeyFingerprint,
              ...(options.workerGateway?.caCertificate
                ? { gatewayCaCertificate: options.workerGateway.caCertificate }
                : {}),
              enrollmentName,
              bootstrapToken: token,
            };
          },
        }
        : {}),
      onError: (error) => logger.warn?.('external orchestration controller error', error),
    });
  }

  // Phase 4.5 / 7.3: ToolOperations are independently bound to a declared
  // ToolExecutor and claimed under a fencing epoch before any local effect.
  // This is separate from AgentWorkload placement and external drivers.
  let toolOperationControllers: NodeToolOperationControllers | undefined;
  let managedToolDriver: ToolManagementDriver | undefined;
  if (controlStore && options.toolExecution?.enabled !== false) {
    const managedToolDescriptors = await createManagedToolDescriptors(
      toolRegistry,
      syncNodeId,
    );
    const toolCapabilityHandle = `capability:tool:${randomBytes(32).toString('hex')}`;
    const toolSessionId = `node-tool:${syncNodeId}:${randomBytes(16).toString('hex')}`;
    const numericToolLeaseEpoch = (leaseEpoch: string): number => {
      const epoch = Number(leaseEpoch);
      if (!Number.isSafeInteger(epoch) || epoch < 1) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `tool controller lease epoch '${leaseEpoch}' is not a positive safe integer`,
          retryable: false,
        });
      }
      return epoch;
    };
    const createManagedToolRequest = <T>(input: {
      method: string;
      payload: T;
      operation: ToolOperationResource;
      actor: ControlStoreActor;
      leaseEpoch: string;
      idempotencyKey: string;
      payloadFields: string[];
    }): DriverRequestEnvelope<T> => ({
      apiVersion: DRIVER_REQUEST_API_VERSION,
      method: input.method,
      resource: {
        apiVersion: input.operation.apiVersion,
        kind: input.operation.kind,
        name: input.operation.metadata.name,
        uid: input.operation.metadata.uid,
        generation: input.operation.metadata.generation,
      },
      fencingEpoch: numericToolLeaseEpoch(input.leaseEpoch),
      requestId: `${input.method}:${randomBytes(16).toString('hex')}`,
      idempotencyKey: input.idempotencyKey,
      deadline: new Date(Date.now() + 60_000).toISOString(),
      actor: input.actor,
      session: { id: toolSessionId },
      capabilityHandleRef: toolCapabilityHandle,
      trace: {
        traceId: randomBytes(16).toString('hex'),
        spanId: randomBytes(8).toString('hex'),
      },
      payloadSchemaDigest: sha256DriverValue({
        apiVersion: `drivers.memeloop.io/${input.method}/v1alpha1`,
        fields: input.payloadFields,
      }),
      payload: input.payload,
    });
    const toolAdmission = options.toolExecution?.admission ??
      defaultAdmissionPolicyForTrustClass(workerTrustClass);
    const narrowToolDriver = createInProcessToolExecutionDriver(
      toolRegistry,
      {
        context: builtinToolContext,
        approvalBroker: {
          async requestApproval(request) {
            const approval = request.operation.status?.approval;
            if (!approval || approval.decision !== 'allow') {
              throw new OrchestrationError({
                code: 'FORBIDDEN',
                message: 'managed tool invocation has no bound approval evidence',
                retryable: false,
              });
            }
            return approval;
          },
        },
        ...(options.toolExecution?.maxOutputLength !== undefined
          ? { maxOutputLength: options.toolExecution.maxOutputLength }
          : {}),
      },
    );
    const managedToolRoute = createManagedToolExecutionRoute(
      narrowToolDriver,
      {
        name: `${syncNodeId}-managed-tools`,
        descriptors: managedToolDescriptors,
        authorizeRequest: (request) =>
          request.capabilityHandleRef === toolCapabilityHandle &&
          request.session?.id === toolSessionId,
        async resolveOperation(resourceUid) {
          const operations = await controlStore.list<
            ToolOperationResource['spec'],
            ToolOperationResource['status']
          >({ kind: TOOL_OPERATION_KIND });
          return (operations.items as ToolOperationResource[]).find(
            (operation) => operation.metadata.uid === resourceUid,
          );
        },
        async authorizeOperation(operation, signal) {
          const admission = evaluateToolAdmission(toolAdmission, operation);
          if (admission.action === 'deny') {
            throw new OrchestrationError({
              code: 'FORBIDDEN',
              message: admission.reason ??
                `ToolOperation denied by trusted admission policy (${admission.source})`,
              retryable: false,
            });
          }
          const approvalReason = admission.action === 'require-approval'
            ? admission.reason ??
              `ToolOperation requires approval (${admission.source})`
            : operation.spec.policy?.requireApproval
            ? 'ToolOperation policy requires approval'
            : undefined;
          let approval;
          if (approvalReason) {
            const broker = options.toolExecution?.approvalBroker;
            if (!broker) {
              throw new OrchestrationError({
                code: 'FORBIDDEN',
                message: `${approvalReason}; no trusted approval broker is configured`,
                retryable: false,
              });
            }
            approval = await broker.requestApproval({
              operation,
              reason: approvalReason,
              signal,
            });
            if (
              !approval.approvalId ||
              !approval.actor ||
              !approval.decidedAt ||
              (approval.decision !== 'allow' && approval.decision !== 'deny') ||
              Number.isNaN(Date.parse(approval.decidedAt)) ||
              approval.decision !== 'allow'
            ) {
              throw new OrchestrationError({
                code: 'FORBIDDEN',
                message: approval.reason ??
                  'Trusted approval broker denied or returned invalid evidence',
                retryable: false,
              });
            }
          }
          const policyDigest = sha256DriverValue({
            admission: toolAdmission,
            operationPolicy: operation.spec.policy,
            tool: operation.spec.toolRef.name,
            effect: operation.spec.effect,
          });
          return {
            handle: `policy-decision:${
              sha256DriverValue({
                resourceUid: operation.metadata.uid,
                policyDigest,
                approval,
              })
            }`,
            policyDigest,
            ...(approval ? { approval } : {}),
          };
        },
        createRequest: createManagedToolRequest,
        maxOutputBytes: options.toolExecution?.maxOutputLength ?? 64 * 1024,
        maxOutputChunks: 8,
        threatAssumptions: [
          'the host tool registry, admission policy, approval broker, and controller are trusted',
          'tool implementations execute in the daemon process and are not crash-adoptable',
          'non-read cancellation or daemon loss is conservatively classified as an unknown effect',
        ],
      },
    );
    managedToolDriver = managedToolRoute.managementDriver;
    const executorActor = {
      id: `controller/tool-executor-registry-${syncNodeId}`,
      kind: 'controller' as const,
    };
    const executorName = `${syncNodeId}-builtin-tools`
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'local-builtin-tools';
    const executorManifest = createToolExecutorManifest(executorName, {
      nodeId: syncNodeId,
      trust: workerTrustClass,
      selectors: options.workloadExecution?.localNode?.labels,
      capabilities: toolRegistry.listTools().map((toolId) => ({
        toolClassRef: {
          apiVersion: 'tool.memeloop.io/v1alpha1',
          kind: 'ToolClass',
          name: toolId,
        },
        schemaDigest: managedToolDescriptors.find(
          (descriptor) => descriptor.name === toolId,
        )!.schemaDigest,
        endpoint: `local-tool://${encodeURIComponent(syncNodeId)}/${encodeURIComponent(toolId)}`,
        capacity: {
          maxConcurrent: options.toolExecution?.maxConcurrent ?? 8,
          queueDepth: 0,
        },
        health: { healthy: true },
      })),
    });
    const executorReference = {
      apiVersion: TOOL_EXECUTOR_API_VERSION,
      kind: TOOL_EXECUTOR_KIND,
      name: executorName,
    };
    let executor = await controlStore.get<ToolExecutorResource['spec']>(executorReference);
    if (
      executor &&
      JSON.stringify(executor.spec) !== JSON.stringify(executorManifest.spec)
    ) {
      await controlStore.delete(executorActor, executorReference, {
        preconditions: { resourceVersion: executor.metadata.resourceVersion },
      });
      executor = null;
    }
    if (!executor) {
      try {
        executor = await controlStore.create(executorActor, executorManifest);
      } catch (error) {
        if (!(error instanceof OrchestrationError) || error.code !== 'CONFLICT') throw error;
        executor = await controlStore.get<ToolExecutorResource['spec']>(executorReference);
      }
    }
    if (executor) {
      executor = await controlStore.updateStatus(
        executorActor,
        executorReference,
        { ...executor.status, healthy: true, heartbeat: new Date().toISOString() },
        { resourceVersion: executor.metadata.resourceVersion },
      );
    }

    const bindingActor = {
      id: `controller/tool-binding-${syncNodeId}`,
      kind: 'controller' as const,
    };
    const executionActor = {
      id: `controller/tool-execution-${syncNodeId}`,
      kind: 'controller' as const,
    };
    const binding = await createControllerRunner(
      controlStore,
      createToolOperationBindingController({
        actor: bindingActor,
        listExecutors: async () => {
          const list = await controlStore.list({
            apiVersion: TOOL_EXECUTOR_API_VERSION,
            kind: TOOL_EXECUTOR_KIND,
          });
          return list.items as unknown as ToolExecutorResource[];
        },
      }),
      {
        actor: bindingActor,
        leaseName: 'tool-operation-binding',
        watchKind: TOOL_OPERATION_KIND,
        leaseTtlMs: 5000,
      },
    );
    const toolExecutionController = createToolOperationExecutionController({
      actor: executionActor,
      nodeId: syncNodeId,
      driver: managedToolRoute.executionDriver,
    });
    const execution = await createControllerRunner(
      controlStore,
      toolExecutionController,
      {
        actor: executionActor,
        leaseName: `tool-operation-execution-${syncNodeId}`,
        watchKind: TOOL_OPERATION_KIND,
        leaseTtlMs: 5000,
      },
    );
    const cancellationWatchAbort = new AbortController();
    const cancellationIterator = controlStore.watch(
      { kind: TOOL_OPERATION_KIND },
      { signal: cancellationWatchAbort.signal },
    )[Symbol.asyncIterator]();
    let cancellationWatcherStopped = false;
    const cancellationDone = (async () => {
      while (!cancellationWatcherStopped) {
        const event = await cancellationIterator.next();
        if (event.done || !event.value) break;
        if (event.value.type === 'DELETED') {
          toolExecutionController.cancel(
            event.value.resource as unknown as ToolOperationResource,
          );
        } else if (
          event.value.type === 'MODIFIED' &&
          (event.value.resource.status as { phase?: string } | undefined)?.phase === 'Cancelled'
        ) {
          toolExecutionController.cancel(
            event.value.resource as unknown as ToolOperationResource,
          );
        }
      }
    })().catch((error: unknown) => {
      if (!cancellationWatcherStopped) {
        logger.warn?.('tool operation cancellation watcher stopped', error);
      }
    });
    toolOperationControllers = {
      binding,
      execution,
      async stop() {
        cancellationWatcherStopped = true;
        toolExecutionController.cancelAll();
        cancellationWatchAbort.abort();
        await cancellationIterator.return?.();
        await Promise.all([binding.stop(), execution.stop()]);
        await cancellationDone;
        const current = await controlStore.get(executorReference).catch(() => null);
        if (current) {
          await controlStore.updateStatus(
            executorActor,
            executorReference,
            { ...current.status, healthy: false, heartbeat: new Date().toISOString() },
            { resourceVersion: current.metadata.resourceVersion },
          ).catch(() => undefined);
        }
      },
    };
  }

  let credentialGrantControllers: NodeCredentialGrantControllers | undefined;
  let managedCredentialDriver: CredentialManagementDriver | undefined;
  if (controlStore && options.credentialBroker) {
    const credentialConfig = options.credentialBroker;
    const credentialMaxTtlMs = credentialConfig.maxTtlMs ?? 60 * 60_000;
    const credentialCapabilityHandle = `capability:credential:${randomBytes(32).toString('hex')}`;
    const credentialSessionId = `node-credential:${syncNodeId}:${randomBytes(16).toString('hex')}`;
    const credentialPayloadSchemaDigests = {
      issue: sha256DriverValue({
        apiVersion: 'drivers.memeloop.io/credential.issue/v1alpha1',
        fields: [
          'runRef',
          'workerKey',
          'target',
          'targetMethod',
          'targetDriver',
          'audience',
          'policyDigest',
          'ttlMs',
          'exposure',
        ],
      }),
      revoke: sha256DriverValue({
        apiVersion: 'drivers.memeloop.io/credential.revoke/v1alpha1',
        fields: ['grantHandle'],
      }),
    };
    const numericCredentialLeaseEpoch = (leaseEpoch: string): number => {
      const epoch = Number(leaseEpoch);
      if (!Number.isSafeInteger(epoch) || epoch < 1) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `credential controller lease epoch '${leaseEpoch}' is not a positive safe integer`,
          retryable: false,
        });
      }
      return epoch;
    };
    const stableCredentialHandle = (grantUid: string): string => `credential://${syncNodeId}/${grantUid}`;
    const createManagedCredentialRequest = <T>(input: {
      method: string;
      payload: T;
      grant: CredentialGrantResource;
      actor: ControlStoreActor;
      leaseEpoch: string;
      payloadSchemaDigest: string;
    }): DriverRequestEnvelope<T> => ({
      apiVersion: DRIVER_REQUEST_API_VERSION,
      method: input.method,
      resource: {
        apiVersion: input.grant.apiVersion,
        kind: input.grant.kind,
        name: input.grant.metadata.name,
        uid: input.grant.metadata.uid,
        generation: input.grant.metadata.generation,
      },
      run: {
        uid: input.grant.spec.runRef.uid,
        attempt: input.grant.spec.attempt,
      },
      fencingEpoch: numericCredentialLeaseEpoch(input.leaseEpoch),
      requestId: `${input.method}:${randomBytes(16).toString('hex')}`,
      idempotencyKey: `${input.grant.metadata.uid}:${input.method}`,
      deadline: new Date(Date.now() + 30_000).toISOString(),
      actor: input.actor,
      session: {
        id: credentialSessionId,
        keyFingerprint: input.grant.spec.workerKey,
      },
      capabilityHandleRef: credentialCapabilityHandle,
      trace: {
        traceId: randomBytes(16).toString('hex'),
        spanId: randomBytes(8).toString('hex'),
      },
      payloadSchemaDigest: input.payloadSchemaDigest,
      payload: input.payload,
    });
    managedCredentialDriver = createManagedCredentialBrokerAdapter(
      credentialConfig.driver,
      {
        name: credentialConfig.brokerClass,
        maxTtlMs: credentialMaxTtlMs,
        authorizeRequest: (request) =>
          request.capabilityHandleRef === credentialCapabilityHandle &&
          request.session?.id === credentialSessionId,
        handleStore: credentialConfig.vault,
        stableHandleFor: (request) => stableCredentialHandle(request.resource.uid),
        async materialize(claims) {
          return stableCredentialHandle(claims.grantId);
        },
        threatAssumptions: [
          'the injected CredentialHandleVault is trusted host storage',
          'the NodeRuntime capability handle and controller session remain host-confined',
          'target drivers resolve opaque vault references without exposing raw tokens',
        ],
      },
    );
    const createManagedCredentialIssueRequest = async (input: {
      grant: CredentialGrantResource;
      actor: ControlStoreActor;
      leaseEpoch: string;
    }): Promise<DriverRequestEnvelope<CredentialIssuePayload>> =>
      createManagedCredentialRequest({
        method: 'credential.issue',
        grant: input.grant,
        actor: input.actor,
        leaseEpoch: input.leaseEpoch,
        payloadSchemaDigest: credentialPayloadSchemaDigests.issue,
        payload: {
          runRef: input.grant.spec.runRef,
          workerKey: input.grant.spec.workerKey,
          target: input.grant.spec.target,
          targetMethod: input.grant.spec.method,
          targetDriver: input.grant.spec.audience,
          audience: input.grant.spec.audience,
          policyDigest: input.grant.spec.policyDigest,
          ttlMs: input.grant.spec.ttlMs ?? Math.min(60_000, credentialMaxTtlMs),
          exposure: 'worker-visible',
        },
      });
    const createManagedCredentialRevokeRequest = async (input: {
      grant: CredentialGrantResource;
      grantHandle: string;
      actor: ControlStoreActor;
      leaseEpoch: string;
    }): Promise<DriverRequestEnvelope<{ grantHandle: string }>> =>
      createManagedCredentialRequest({
        method: 'credential.revoke',
        grant: input.grant,
        actor: input.actor,
        leaseEpoch: input.leaseEpoch,
        payloadSchemaDigest: credentialPayloadSchemaDigests.revoke,
        payload: { grantHandle: input.grantHandle },
      });
    const bindingActor = {
      id: 'controller/credential-grant-binding',
      kind: 'controller' as const,
    };
    const binding = await createControllerRunner(
      controlStore,
      createCredentialGrantBindingController({
        listBrokers: credentialConfig.listBrokers ?? (async () => [{
          nodeId: syncNodeId,
          brokerClass: credentialConfig.brokerClass,
          healthy: true,
          audiences: credentialConfig.audiences,
          ...(credentialConfig.methods ? { methods: credentialConfig.methods } : {}),
          ...(credentialConfig.targets ? { targets: credentialConfig.targets } : {}),
          ...(credentialConfig.maxGrants !== undefined
            ? { maxGrants: credentialConfig.maxGrants }
            : {}),
        }]),
        async requirementsForGrant(grant) {
          const run = await controlStore.get<
            AgentRunResource['spec'],
            AgentRunResource['status']
          >(grant.spec.runRef) as AgentRunResource | null;
          if (!run || run.metadata.uid !== grant.spec.runRef.uid) {
            return { denyReason: 'referenced AgentRun identity is unavailable' };
          }
          const workloadReference = run.spec.workloadRef;
          const workload = await controlStore.get<
            AgentWorkloadResource['spec'],
            AgentWorkloadResource['status']
          >({
            apiVersion: workloadReference.apiVersion,
            kind: workloadReference.kind,
            name: workloadReference.name,
            namespace: run.metadata.namespace,
          }) as AgentWorkloadResource | null;
          if (
            !workload ||
            (workloadReference.uid && workload.metadata.uid !== workloadReference.uid)
          ) {
            return { denyReason: 'referenced AgentWorkload identity is unavailable' };
          }
          const policy = workload.spec.credentialPolicy;
          if (!policy) return { denyReason: 'workload declares no credential policy' };
          if (policy.audiences?.length && !policy.audiences.includes(grant.spec.audience)) {
            return { denyReason: `credential audience '${grant.spec.audience}' is not allowed by workload policy` };
          }
          if (policy.targets?.length && !policy.targets.includes(grant.spec.target)) {
            return { denyReason: `credential target '${grant.spec.target}' is not allowed by workload policy` };
          }
          const admission = await credentialConfig.authorizeGrant(grant, run, workload);
          if (admission !== true) return { denyReason: admission };
          return {
            brokerClass: policy.brokerClass ?? credentialConfig.brokerClass,
            ...(workload.status?.assignedNode
              ? { requiredNode: workload.status.assignedNode }
              : {}),
          };
        },
      }),
      {
        actor: bindingActor,
        leaseName: 'credential-grant-binding',
        watchKind: CREDENTIAL_GRANT_KIND,
        leaseTtlMs: 5000,
        resourceFilter: (resource) => {
          const grant = resource as CredentialGrantResource;
          return !grant.status?.phase || grant.status.phase === 'Pending';
        },
      },
    );
    const executionActor = {
      id: `controller/credential-grant-execution-${syncNodeId}`,
      kind: 'controller' as const,
    };
    const execution = await createControllerRunner(
      controlStore,
      createCredentialGrantExecutionController({
        nodeId: syncNodeId,
        getBroker: async (brokerClass, nodeId) =>
          brokerClass === credentialConfig.brokerClass && nodeId === syncNodeId
            ? credentialConfig.driver
            : undefined,
        vault: credentialConfig.vault,
        managed: {
          getDriver: async (brokerClass, nodeId) =>
            brokerClass === credentialConfig.brokerClass && nodeId === syncNodeId
              ? managedCredentialDriver
              : undefined,
          createIssueRequest: createManagedCredentialIssueRequest,
        },
      }),
      {
        actor: executionActor,
        leaseName: `credential-grant-execution-${syncNodeId}`,
        watchKind: CREDENTIAL_GRANT_KIND,
        leaseTtlMs: 5000,
        resourceFilter: (resource) => {
          const grant = resource as CredentialGrantResource;
          return grant.status?.assignedNode === syncNodeId &&
            (grant.status.phase === 'Pending' || grant.status.phase === 'Issuing');
        },
      },
    );
    const lifecycleActor = {
      id: `controller/credential-grant-lifecycle-${syncNodeId}`,
      kind: 'controller' as const,
    };
    const lifecycle = await createControllerRunner(
      controlStore,
      createCredentialGrantLifecycleController({
        nodeId: syncNodeId,
        getBroker: async (brokerClass, nodeId) =>
          brokerClass === credentialConfig.brokerClass && nodeId === syncNodeId
            ? credentialConfig.driver
            : undefined,
        vault: credentialConfig.vault,
        managed: {
          getDriver: async (brokerClass, nodeId) =>
            brokerClass === credentialConfig.brokerClass && nodeId === syncNodeId
              ? managedCredentialDriver
              : undefined,
          createRevokeRequest: createManagedCredentialRevokeRequest,
        },
        async isRunTerminal(grant) {
          const run = await controlStore.get<
            AgentRunResource['spec'],
            AgentRunResource['status']
          >(grant.spec.runRef) as AgentRunResource | null;
          return !run ||
            run.metadata.uid !== grant.spec.runRef.uid ||
            run.status?.phase === 'Completed' ||
            run.status?.phase === 'Failed' ||
            run.status?.phase === 'Cancelled';
        },
      }),
      {
        actor: lifecycleActor,
        leaseName: `credential-grant-lifecycle-${syncNodeId}`,
        watchKind: CREDENTIAL_GRANT_KIND,
        leaseTtlMs: 5000,
        resourceFilter: (resource) => {
          const grant = resource as CredentialGrantResource;
          return grant.status?.assignedNode === syncNodeId &&
            (grant.status.phase === 'Issued' || grant.status.phase === 'Renewed');
        },
      },
    );
    const cleanupAbort = new AbortController();
    const cleanupIterator = controlStore.watch(
      { kind: CREDENTIAL_GRANT_KIND },
      { signal: cleanupAbort.signal },
    )[Symbol.asyncIterator]();
    const runCleanupIterator = controlStore.watch(
      { kind: AGENT_RUN_KIND },
      { signal: cleanupAbort.signal, sendInitialEvents: true },
    )[Symbol.asyncIterator]();
    let cleanupStopped = false;
    const cleanupDone = (async () => {
      while (!cleanupStopped) {
        const event = await cleanupIterator.next();
        if (event.done || !event.value) break;
        if (event.value.type === 'DELETED') {
          const grant = event.value.resource as unknown as CredentialGrantResource;
          if (
            grant.status?.assignedNode === syncNodeId &&
            grant.status.assignedBroker === credentialConfig.brokerClass &&
            grant.status.handleRef &&
            grant.status.binding
          ) {
            await managedCredentialDriver.revoke(
              await createManagedCredentialRevokeRequest({
                grant,
                grantHandle: grant.status.handleRef,
                actor: lifecycleActor,
                leaseEpoch: grant.status.binding.leaseEpoch,
              }),
            );
          }
        }
      }
    })().catch((error: unknown) => {
      if (!cleanupStopped) logger.warn?.('credential grant cleanup watcher stopped', error);
    });
    const runCleanupDone = (async () => {
      while (!cleanupStopped) {
        const event = await runCleanupIterator.next();
        if (event.done || !event.value) break;
        if (event.value.type !== 'ADDED' && event.value.type !== 'MODIFIED') continue;
        const run = event.value.resource as unknown as AgentRunResource;
        if (
          run.status?.phase !== 'Completed' &&
          run.status?.phase !== 'Failed' &&
          run.status?.phase !== 'Cancelled'
        ) continue;
        const grants = await controlStore.list<
          CredentialGrantResource['spec'],
          CredentialGrantResource['status']
        >({ kind: CREDENTIAL_GRANT_KIND, namespace: run.metadata.namespace });
        for (const grant of grants.items as CredentialGrantResource[]) {
          if (
            grant.spec.runRef.uid !== run.metadata.uid ||
            grant.status?.assignedNode !== syncNodeId ||
            grant.status.assignedBroker !== credentialConfig.brokerClass ||
            !grant.status.handleRef ||
            !grant.status.binding ||
            (grant.status.phase !== 'Issued' && grant.status.phase !== 'Renewed')
          ) continue;
          await managedCredentialDriver.revoke(
            await createManagedCredentialRevokeRequest({
              grant,
              grantHandle: grant.status.handleRef,
              actor: lifecycleActor,
              leaseEpoch: grant.status.binding.leaseEpoch,
            }),
          );
          await controlStore.updateStatus(
            lifecycleActor,
            {
              apiVersion: grant.apiVersion,
              kind: grant.kind,
              name: grant.metadata.name,
              namespace: grant.metadata.namespace,
            },
            {
              ...grant.status,
              phase: 'Revoked',
              revokedAt: new Date().toISOString(),
            },
            { resourceVersion: grant.metadata.resourceVersion },
          ).catch((error: unknown) => {
            logger.warn?.('credential grant terminal-Run status update failed', error);
          });
        }
      }
    })().catch((error: unknown) => {
      if (!cleanupStopped) logger.warn?.('credential grant Run watcher stopped', error);
    });
    credentialGrantControllers = {
      binding,
      execution,
      lifecycle,
      async stop() {
        cleanupStopped = true;
        cleanupAbort.abort();
        await cleanupIterator.return?.();
        await runCleanupIterator.return?.();
        await Promise.all([binding.stop(), execution.stop(), lifecycle.stop()]);
        await Promise.race([
          Promise.all([cleanupDone, runCleanupDone]).then(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 100)),
        ]);
      },
    };
  }

  // Plan 24.14 / Phase 4.2: schedule and execute AgentWorkloads. The
  // binding controller assigns this node; the execution controller runs
  // bound workloads through the LoopRuntimeDriver. Script workloads whose
  // RuntimeClass declares process isolation run in a sanitized child process
  // by default (24.18 isolation made real; 24.35 env sanitization point).
  let bindingControllerRunner: ControllerRunnerHandle | undefined;
  let modelEndpointBindingControllerRunner: ControllerRunnerHandle | undefined;
  let networkAttachmentControllers: NodeNetworkAttachmentControllers | undefined;
  let volumeControllers: NodeVolumeControllers | undefined;
  let managedStorageDriver: StorageManagementDriver | undefined;
  let workloadExecutionController: WorkloadExecutionControllerHandle | undefined;
  let managedLoopRuntimeDriver: LoopRuntimeManagementDriver | undefined;
  if (controlStore && options.workloadExecution?.enabled !== false) {
    const modelBindingActor = {
      id: 'controller/model-endpoint-binding',
      kind: 'controller' as const,
    };
    modelEndpointBindingControllerRunner = await createControllerRunner(
      controlStore,
      createModelEndpointBindingController({
        actor: modelBindingActor,
        async getWorkload(run) {
          const reference = run.spec.workloadRef;
          const resource = await controlStore.get<
            AgentWorkloadResource['spec'],
            AgentWorkloadResource['status']
          >({
            apiVersion: reference.apiVersion,
            kind: reference.kind,
            name: reference.name,
            namespace: reference.namespace,
          }) as AgentWorkloadResource | null;
          if (resource && reference.uid && resource.metadata.uid !== reference.uid) return null;
          return resource;
        },
        async listEndpoints() {
          const result = await controlStore.list<
            ModelEndpointResource['spec'],
            ModelEndpointResource['status']
          >({
            apiVersion: MODEL_ENDPOINT_API_VERSION,
            kind: MODEL_ENDPOINT_KIND,
          });
          return result.items as ModelEndpointResource[];
        },
        async listRuns() {
          const result = await controlStore.list<
            AgentRunResource['spec'],
            AgentRunResource['status']
          >({
            apiVersion: AGENT_RUN_API_VERSION,
            kind: AGENT_RUN_KIND,
          });
          return result.items as AgentRunResource[];
        },
        async getModelClass(endpoint) {
          return await controlStore.get<
            ModelClassResource['spec'],
            ModelClassResource['status']
          >(endpoint.spec.modelClassRef) as ModelClassResource | null;
        },
        ...(options.modelEndpointRegistration?.staleAfterMs !== undefined
          ? { endpointHeartbeatTtlMs: options.modelEndpointRegistration.staleAfterMs }
          : {}),
      }),
      {
        actor: modelBindingActor,
        leaseName: 'model-endpoint-binding',
        watchKind: AGENT_RUN_KIND,
        leaseTtlMs: 5000,
        resourceFilter: (resource) => {
          const run = resource as AgentRunResource;
          return !run.status?.phase || run.status.phase === 'Pending';
        },
      },
    );

    const processNetworkDriver = createProcessNetworkDriver({
      resolveService: async (name) => {
        if (name !== 'model-gateway') return undefined;
        return options.workloadExecution?.modelGatewayEndpoint;
      },
    });
    const networkCapabilityHandle = `capability:network:${randomBytes(32).toString('hex')}`;
    const networkSessionId = `node-network:${syncNodeId}:${randomBytes(16).toString('hex')}`;
    const networkPayloadSchemaDigests = {
      prepare: sha256DriverValue('drivers.memeloop.io/network.prepare/v1alpha1'),
      release: sha256DriverValue('drivers.memeloop.io/network.release/v1alpha1'),
    };
    const numericLeaseEpoch = (leaseEpoch: string): number => {
      const epoch = Number(leaseEpoch);
      if (!Number.isSafeInteger(epoch) || epoch < 1) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `network controller lease epoch '${leaseEpoch}' is not a positive safe integer`,
          retryable: false,
        });
      }
      return epoch;
    };
    const createManagedNetworkRequest = <T>(input: {
      method: string;
      payload: T;
      attachment: NetworkAttachmentResource;
      actor: ControlStoreActor;
      leaseEpoch: string;
      idempotencyKey: string;
      payloadSchemaDigest: string;
    }): DriverRequestEnvelope<T> => {
      const runReference = input.attachment.spec.runRef;
      if (!runReference?.uid) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `NetworkAttachment '${input.attachment.metadata.name}' has no bound AgentRun identity`,
          retryable: false,
        });
      }
      return {
        apiVersion: DRIVER_REQUEST_API_VERSION,
        method: input.method,
        resource: {
          apiVersion: input.attachment.apiVersion,
          kind: input.attachment.kind,
          name: input.attachment.metadata.name,
          uid: input.attachment.metadata.uid,
          generation: input.attachment.metadata.generation,
        },
        run: { uid: runReference.uid, attempt: 1 },
        fencingEpoch: numericLeaseEpoch(input.leaseEpoch),
        requestId: `${input.method}:${randomBytes(16).toString('hex')}`,
        idempotencyKey: input.idempotencyKey,
        deadline: new Date(Date.now() + 30_000).toISOString(),
        actor: input.actor,
        session: { id: networkSessionId },
        capabilityHandleRef: networkCapabilityHandle,
        trace: {
          traceId: randomBytes(16).toString('hex'),
          spanId: randomBytes(8).toString('hex'),
        },
        payloadSchemaDigest: input.payloadSchemaDigest,
        payload: input.payload,
      };
    };
    const managedNetworkDriver = createManagedNetworkAdapter(processNetworkDriver, {
      supportedTrustClasses: [workerTrustClass],
      threatAssumptions: [
        'process environment policy is cooperative and cannot contain a hostile workload',
        'the NodeRuntime capability token and ControlStore desired state are trusted',
      ],
      maxPolicyRules: 256,
      verifyCapability: (request) =>
        request.capabilityHandleRef === networkCapabilityHandle &&
        request.session?.id === networkSessionId,
      async resolveAttachRequest(request) {
        const attachment = await controlStore.get<
          NetworkAttachmentResource['spec'],
          NetworkAttachmentResource['status']
        >({
          apiVersion: request.resource.apiVersion,
          kind: request.resource.kind,
          name: request.resource.name,
        }) as NetworkAttachmentResource | null;
        if (!attachment || attachment.metadata.uid !== request.resource.uid) {
          throw new OrchestrationError({
            code: 'NOT_FOUND',
            message: `NetworkAttachment '${request.resource.name}' is unavailable`,
            retryable: false,
          });
        }
        const networkClass = await controlStore.get<
          NetworkClassResource['spec'],
          NetworkClassResource['status']
        >(attachment.spec.networkClassRef) as NetworkClassResource | null;
        if (!networkClass) {
          throw new OrchestrationError({
            code: 'NOT_FOUND',
            message: `NetworkClass '${attachment.spec.networkClassRef.name}' is unavailable`,
            retryable: false,
          });
        }
        const policy = managedPolicyForNetworkClass(networkClass);
        return {
          attachRequest: {
            attachment,
            networkClass,
            sandboxRef: request.payload.sandboxHandle,
          },
          networkClassDigest: sha256DriverValue(networkClass.spec),
          policyDigest: sha256DriverValue(policy),
        };
      },
    });
    const networkCapabilities = await processNetworkDriver.getCapabilities();
    const getNetworkClass = async (attachment: NetworkAttachmentResource) =>
      await controlStore.get<
        NetworkClassResource['spec'],
        NetworkClassResource['status']
      >(attachment.spec.networkClassRef) as NetworkClassResource | null;
    const networkBindingActor = {
      id: 'controller/network-attachment-binding',
      kind: 'controller' as const,
    };
    const networkBinding = await createControllerRunner(
      controlStore,
      createNetworkAttachmentBindingController({
        getNetworkClass,
        async getWorkload(attachment) {
          const reference = attachment.spec.workloadRef;
          if (!reference?.name) return null;
          const resource = await controlStore.get<
            AgentWorkloadResource['spec'],
            AgentWorkloadResource['status']
          >({
            apiVersion: reference.apiVersion,
            kind: reference.kind,
            name: reference.name,
            namespace: attachment.metadata.namespace,
          }) as AgentWorkloadResource | null;
          if (resource && reference.uid && resource.metadata.uid !== reference.uid) return null;
          return resource;
        },
        listNodes: options.workloadExecution?.listNetworkAttachmentNodes ?? (async () => [{
          nodeId: syncNodeId,
          healthy: (await processNetworkDriver.getHealth()).healthy,
          capabilities: [networkCapabilities],
        }]),
      }),
      {
        actor: networkBindingActor,
        leaseName: 'network-attachment-binding',
        watchKind: NETWORK_ATTACHMENT_KIND,
        leaseTtlMs: 5000,
        resourceFilter: (resource) =>
          !(resource.status as NetworkAttachmentResource['status'])?.phase ||
          (resource.status as NetworkAttachmentResource['status'])?.phase === 'Pending',
      },
    );
    const networkExecutionActor = {
      id: `controller/network-attachment-execution-${syncNodeId}`,
      kind: 'controller' as const,
    };
    const createManagedNetworkReleaseRequest = async (input: {
      attachment: NetworkAttachmentResource;
      networkHandle: string;
      actor: ControlStoreActor;
      leaseEpoch: string;
    }) =>
      createManagedNetworkRequest({
        method: 'network.release',
        payload: { networkHandle: input.networkHandle },
        attachment: input.attachment,
        actor: input.actor,
        leaseEpoch: input.leaseEpoch,
        idempotencyKey: `${input.attachment.metadata.uid}:release:${input.networkHandle}`,
        payloadSchemaDigest: networkPayloadSchemaDigests.release,
      });
    const networkExecution = await createControllerRunner(
      controlStore,
      createNetworkAttachmentExecutionController({
        nodeId: syncNodeId,
        getNetworkClass,
        getDriver: async (name) => name === PROCESS_NETWORK_DRIVER_NAME ? processNetworkDriver : undefined,
        managed: {
          getDriver: async (name) => name === PROCESS_NETWORK_DRIVER_NAME ? managedNetworkDriver : undefined,
          async createPrepareRequest({
            attachment,
            networkClass,
            sandboxHandle,
            actor,
            leaseEpoch,
          }) {
            const policyWithoutDigest = managedPolicyForNetworkClass(networkClass);
            const payload: NetworkPreparePayload = {
              sandboxHandle,
              networkClass: networkClass.metadata.name,
              networkClassDigest: sha256DriverValue(networkClass.spec),
              requestedFeatures: featuresRequiredByClass(networkClass),
              minimumEnforcementLevel: (
                networkClass.spec.enforcement === 'required'
                  ? 'namespace'
                  : 'process'
              ) satisfies NetworkEnforcementLevel,
              trustClass: workerTrustClass,
              policy: {
                ...policyWithoutDigest,
                digest: sha256DriverValue(policyWithoutDigest),
              },
            };
            return createManagedNetworkRequest({
              method: 'network.prepare',
              payload,
              attachment,
              actor,
              leaseEpoch,
              idempotencyKey: [
                attachment.metadata.uid,
                'prepare',
                attachment.metadata.generation,
                networkClass.metadata.resourceVersion,
                sandboxHandle,
              ].join(':'),
              payloadSchemaDigest: networkPayloadSchemaDigests.prepare,
            });
          },
          createReleaseRequest: createManagedNetworkReleaseRequest,
        },
      }),
      {
        actor: networkExecutionActor,
        leaseName: `network-attachment-execution-${syncNodeId}`,
        watchKind: NETWORK_ATTACHMENT_KIND,
        leaseTtlMs: 5000,
        resourceFilter: (resource) => {
          const attachment = resource as NetworkAttachmentResource;
          return attachment.status?.assignedNode === syncNodeId &&
            (
              attachment.status.phase === 'Pending' ||
              attachment.status.phase === 'Preparing' ||
              (attachment.status.phase === 'Attached' && Boolean(attachment.status.releaseRequestedAt))
            );
        },
      },
    );
    const networkCleanupAbort = new AbortController();
    const networkCleanupIterator = controlStore.watch(
      { kind: NETWORK_ATTACHMENT_KIND },
      { signal: networkCleanupAbort.signal },
    )[Symbol.asyncIterator]();
    let networkCleanupStopped = false;
    const networkCleanupDone = (async () => {
      while (!networkCleanupStopped) {
        const event = await networkCleanupIterator.next();
        if (event.done || !event.value) break;
        if (event.value.type === 'DELETED') {
          const attachment = event.value.resource as unknown as NetworkAttachmentResource;
          if (
            attachment.status?.assignedNode === syncNodeId &&
            attachment.status.assignedDriver === PROCESS_NETWORK_DRIVER_NAME &&
            attachment.status.handle
          ) {
            const leaseEpoch = attachment.status.executionClaim?.leaseEpoch;
            if (!leaseEpoch) {
              logger.warn?.(
                `deleted NetworkAttachment '${attachment.metadata.name}' has no fencing claim; refusing unfenced cleanup`,
              );
              continue;
            }
            await managedNetworkDriver.releaseNetwork(
              await createManagedNetworkReleaseRequest({
                attachment,
                networkHandle: attachment.status.handle,
                actor: networkExecutionActor,
                leaseEpoch,
              }),
            );
          }
        }
      }
    })().catch((error: unknown) => {
      if (!networkCleanupStopped) logger.warn?.('network attachment cleanup watcher stopped', error);
    });
    networkAttachmentControllers = {
      binding: networkBinding,
      execution: networkExecution,
      async stop() {
        networkCleanupStopped = true;
        networkCleanupAbort.abort();
        await networkCleanupIterator.return?.();
        await Promise.all([networkBinding.stop(), networkExecution.stop()]);
        await Promise.race([
          networkCleanupDone,
          new Promise<void>((resolve) => setTimeout(resolve, 100)),
        ]);
      },
    };

    const localStorageDriver = options.dataDir && workerTrustClass === 'trusted'
      ? createLocalDirectoryStorageDriver({
        rootDirectory: path.join(options.dataDir, 'volumes'),
        nodeId: syncNodeId,
      })
      : undefined;
    if (localStorageDriver) {
      const storageCapabilityHandle = `capability:storage:${randomBytes(32).toString('hex')}`;
      const storageSessionId = `node-storage:${syncNodeId}:${randomBytes(16).toString('hex')}`;
      const numericStorageLeaseEpoch = (leaseEpoch: string): number => {
        const epoch = Number(leaseEpoch);
        if (!Number.isSafeInteger(epoch) || epoch < 1) {
          throw new OrchestrationError({
            code: 'INVALID',
            message: `storage controller lease epoch '${leaseEpoch}' is not a positive safe integer`,
            retryable: false,
          });
        }
        return epoch;
      };
      const storageSchemaDigest = (method: string, fields: string[]) =>
        sha256DriverValue({
          apiVersion: `drivers.memeloop.io/${method}/v1alpha1`,
          fields,
        });
      const createManagedStorageRequest = <T>(input: {
        method: string;
        payload: T;
        resource: AgentVolumeClaimResource | AgentRunResource;
        actor: ControlStoreActor;
        leaseEpoch: string;
        idempotencyKey: string;
        fields: string[];
      }): DriverRequestEnvelope<T> => ({
        apiVersion: DRIVER_REQUEST_API_VERSION,
        method: input.method,
        resource: {
          apiVersion: input.resource.apiVersion,
          kind: input.resource.kind,
          name: input.resource.metadata.name,
          uid: input.resource.metadata.uid,
          generation: input.resource.metadata.generation,
        },
        ...(
          input.resource.kind === AGENT_RUN_KIND
            ? {
              run: {
                uid: input.resource.metadata.uid,
                attempt: 1,
              },
            }
            : {}
        ),
        fencingEpoch: numericStorageLeaseEpoch(input.leaseEpoch),
        requestId: `${input.method}:${randomBytes(16).toString('hex')}`,
        idempotencyKey: input.idempotencyKey,
        deadline: new Date(Date.now() + 30_000).toISOString(),
        actor: input.actor,
        session: { id: storageSessionId },
        capabilityHandleRef: storageCapabilityHandle,
        trace: {
          traceId: randomBytes(16).toString('hex'),
          spanId: randomBytes(8).toString('hex'),
        },
        payloadSchemaDigest: storageSchemaDigest(input.method, input.fields),
        payload: input.payload,
      });
      const findVolumeByDriverHandle = async (driverHandle: string) => {
        const volumes = await controlStore.list<
          AgentVolumeResource['spec'],
          AgentVolumeResource['status']
        >({ kind: VOLUME_KIND });
        const matches = (volumes.items as AgentVolumeResource[])
          .filter((volume) => volume.spec.driverHandle === driverHandle);
        if (matches.length > 1) {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: `storage handle '${driverHandle}' resolves to multiple volumes`,
            retryable: false,
          });
        }
        return matches[0];
      };
      managedStorageDriver = createManagedStorageDriverAdapter(
        localStorageDriver,
        {
          authorizeRequest: (request) =>
            request.capabilityHandleRef === storageCapabilityHandle &&
            request.session?.id === storageSessionId,
          async resolveProvisionInput(request) {
            const claims = await controlStore.list<
              AgentVolumeClaimResource['spec'],
              AgentVolumeClaimResource['status']
            >({ kind: VOLUME_CLAIM_KIND });
            const claim = (claims.items as AgentVolumeClaimResource[]).find(
              (candidate) =>
                candidate.metadata.uid === request.resource.uid &&
                candidate.apiVersion === request.resource.apiVersion &&
                candidate.kind === request.resource.kind &&
                candidate.metadata.name === request.resource.name &&
                candidate.metadata.generation === request.resource.generation,
            );
            if (!claim) {
              throw new OrchestrationError({
                code: 'NOT_FOUND',
                message: 'managed storage claim identity is unavailable',
                retryable: false,
              });
            }
            const storageClass = await controlStore.get<
              StorageClassResource['spec'],
              StorageClassResource['status']
            >(claim.spec.storageClassRef) as StorageClassResource | null;
            if (!storageClass) {
              throw new OrchestrationError({
                code: 'NOT_FOUND',
                message: 'managed StorageClass is unavailable',
                retryable: false,
              });
            }
            return { claim, storageClass };
          },
          resolveVolume: findVolumeByDriverHandle,
          stateStore: createFileManagedStorageStateStore(
            path.join(options.dataDir!, 'volumes', '.managed-state'),
          ),
          stableStageHandleFor: (request) =>
            `storage-stage:${
              sha256DriverValue({
                resourceUid: request.resource.uid,
                volumeHandle: request.payload.volumeHandle,
                nodeId: request.payload.nodeId,
              })
            }`,
          threatAssumptions: [
            'the local private volume root and managed state directory are trusted host storage',
            'the ControlStore volume resolver and NodeRuntime capability remain host-confined',
            'local-directory publication provides a process mount path, not kernel-enforced remote storage isolation',
          ],
        },
      );
      const storageCapabilities = await localStorageDriver.getCapabilities();
      const getStorageClass = async (claim: AgentVolumeClaimResource) =>
        await controlStore.get<
          StorageClassResource['spec'],
          StorageClassResource['status']
        >(claim.spec.storageClassRef) as StorageClassResource | null;
      const volumeBindingActor = {
        id: 'controller/volume-claim-binding',
        kind: 'controller' as const,
      };
      const volumeBinding = await createControllerRunner(
        controlStore,
        createVolumeClaimBindingController({
          getStorageClass,
          listDrivers: options.workloadExecution?.listStorageDriverEndpoints ?? (async () => [{
            nodeId: syncNodeId,
            healthy: (await localStorageDriver.getHealth()).healthy,
            trust: workerTrustClass,
            capabilities: [storageCapabilities],
          }]),
        }),
        {
          actor: volumeBindingActor,
          leaseName: 'volume-claim-binding',
          watchKind: VOLUME_CLAIM_KIND,
          leaseTtlMs: 5000,
          resourceFilter: (resource) => {
            const claim = resource as AgentVolumeClaimResource;
            return !claim.status?.phase || claim.status.phase === 'Pending';
          },
        },
      );
      const volumeProvisionActor = {
        id: `controller/volume-claim-provision-${syncNodeId}`,
        kind: 'controller' as const,
      };
      const volumeProvisioning = await createControllerRunner(
        controlStore,
        createVolumeClaimExecutionController({
          nodeId: syncNodeId,
          getStorageClass,
          getDriver: async (name) =>
            name === LOCAL_DIRECTORY_STORAGE_DRIVER_NAME
              ? localStorageDriver
              : undefined,
          managed: {
            getDriver: async (name) =>
              name === LOCAL_DIRECTORY_STORAGE_DRIVER_NAME
                ? managedStorageDriver
                : undefined,
            createProvisionRequest: async ({ claim, storageClass, actor, leaseEpoch }) =>
              createManagedStorageRequest({
                method: 'storage.provision',
                resource: claim,
                actor,
                leaseEpoch,
                idempotencyKey: `provision:${claim.metadata.uid}`,
                fields: [
                  'capacityBytes',
                  'accessMode',
                  'storageClass',
                  'replicaCount',
                ],
                payload: {
                  capacityBytes: claim.spec.sizeBytes ?? 1,
                  accessMode: claim.spec.accessMode,
                  storageClass: storageClass.metadata.name,
                  replicaCount: 1,
                },
              }),
          },
          async ensureVolume(claim, storageClass, provisioned) {
            const name = `${claim.metadata.name}-volume`;
            const reference = {
              apiVersion: 'storage.memeloop.io/v1alpha1',
              kind: VOLUME_KIND,
              name,
              namespace: claim.metadata.namespace,
            };
            const existing = await controlStore.get<
              AgentVolumeResource['spec'],
              AgentVolumeResource['status']
            >(reference) as AgentVolumeResource | null;
            if (existing) {
              if (
                existing.spec.claimRef?.uid !== claim.metadata.uid ||
                existing.spec.driverHandle !== provisioned.driverHandle
              ) {
                throw new OrchestrationError({
                  code: 'CONFLICT',
                  message: `existing volume '${name}' does not belong to claim '${claim.metadata.name}'`,
                  retryable: false,
                });
              }
              return existing;
            }
            const manifest = createVolumeManifest(name, {
              storageClassRef: {
                apiVersion: storageClass.apiVersion,
                kind: storageClass.kind,
                name: storageClass.metadata.name,
              },
              claimRef: {
                apiVersion: claim.apiVersion,
                kind: claim.kind,
                name: claim.metadata.name,
                uid: claim.metadata.uid,
              },
              driverHandle: provisioned.driverHandle,
              capacityBytes: provisioned.capacityBytes,
              topology: provisioned.topology,
              accessModes: [claim.spec.accessMode],
            });
            manifest.metadata.namespace = claim.metadata.namespace;
            const created = await controlStore.create(
              volumeProvisionActor,
              manifest,
              { idempotencyKey: `volume:${claim.metadata.uid}` },
            ) as unknown as AgentVolumeResource;
            return await controlStore.updateStatus(
              volumeProvisionActor,
              reference,
              {
                phase: 'Bound',
                health: 'healthy',
                replicas: [{
                  nodeId: syncNodeId,
                  state: 'healthy',
                  updatedAt: new Date().toISOString(),
                }],
              },
              { resourceVersion: created.metadata.resourceVersion },
            ) as unknown as AgentVolumeResource;
          },
        }),
        {
          actor: volumeProvisionActor,
          leaseName: `volume-claim-provision-${syncNodeId}`,
          watchKind: VOLUME_CLAIM_KIND,
          leaseTtlMs: 5000,
          resourceFilter: (resource) => {
            const claim = resource as AgentVolumeClaimResource;
            return claim.status?.assignedNode === syncNodeId &&
              (claim.status.phase === 'Pending' || claim.status.phase === 'Provisioning');
          },
        },
      );
      const volumePublishActor = {
        id: `controller/run-volume-${syncNodeId}`,
        kind: 'controller' as const,
      };
      const updatePublishedTo = async (
        volume: AgentVolumeResource,
        workload: AgentWorkloadResource,
        published: boolean,
      ) => {
        const reference = {
          apiVersion: volume.apiVersion,
          kind: volume.kind,
          name: volume.metadata.name,
          namespace: volume.metadata.namespace,
        };
        const current = await controlStore.get<
          AgentVolumeResource['spec'],
          AgentVolumeResource['status']
        >(reference) as AgentVolumeResource | null;
        if (!current) return;
        const others = (current.status?.publishedTo ?? []).filter(
          (item) => item.workloadRef?.uid !== workload.metadata.uid,
        );
        await controlStore.updateStatus(
          volumePublishActor,
          reference,
          {
            ...current.status,
            phase: published ? 'Published' : 'Bound',
            publishedTo: published
              ? [...others, {
                nodeId: syncNodeId,
                workloadRef: {
                  apiVersion: workload.apiVersion,
                  kind: workload.kind,
                  name: workload.metadata.name,
                  uid: workload.metadata.uid,
                },
              }]
              : others,
          },
          { resourceVersion: current.metadata.resourceVersion },
        );
      };
      const runVolume = await createControllerRunner(
        controlStore,
        createRunVolumeController({
          nodeId: syncNodeId,
          async getWorkload(run) {
            const reference = run.spec.workloadRef;
            const resource = await controlStore.get<
              AgentWorkloadResource['spec'],
              AgentWorkloadResource['status']
            >({
              apiVersion: reference.apiVersion,
              kind: reference.kind,
              name: reference.name,
              namespace: run.metadata.namespace,
            }) as AgentWorkloadResource | null;
            return resource && (!reference.uid || resource.metadata.uid === reference.uid)
              ? resource
              : null;
          },
          async getClaim(name, namespace) {
            return await controlStore.get<
              AgentVolumeClaimResource['spec'],
              AgentVolumeClaimResource['status']
            >({
              apiVersion: 'storage.memeloop.io/v1alpha1',
              kind: VOLUME_CLAIM_KIND,
              name,
              namespace,
            }) as AgentVolumeClaimResource | null;
          },
          async getVolume(claim) {
            const reference = claim.status?.volumeRef;
            if (!reference) return null;
            return await controlStore.get<
              AgentVolumeResource['spec'],
              AgentVolumeResource['status']
            >({
              apiVersion: reference.apiVersion,
              kind: reference.kind,
              name: reference.name,
              namespace: claim.metadata.namespace,
            }) as AgentVolumeResource | null;
          },
          getDriver: async (name) =>
            name === LOCAL_DIRECTORY_STORAGE_DRIVER_NAME
              ? localStorageDriver
              : undefined,
          managed: {
            getDriver: async (name) =>
              name === LOCAL_DIRECTORY_STORAGE_DRIVER_NAME
                ? managedStorageDriver
                : undefined,
            createStageRequest: async ({ run, volume, nodeId, actor, leaseEpoch }) =>
              createManagedStorageRequest({
                method: 'storage.stage',
                resource: run,
                actor,
                leaseEpoch,
                idempotencyKey: `stage:${run.metadata.uid}:${volume.metadata.uid}`,
                fields: ['volumeHandle', 'nodeId'],
                payload: {
                  volumeHandle: volume.spec.driverHandle,
                  nodeId,
                },
              }),
            createPublishRequest: async ({
              run,
              stageHandle,
              workloadUid,
              readOnly,
              actor,
              leaseEpoch,
            }) =>
              createManagedStorageRequest({
                method: 'storage.publish',
                resource: run,
                actor,
                leaseEpoch,
                idempotencyKey: `publish:${run.metadata.uid}:${stageHandle}`,
                fields: ['stageHandle', 'workloadUid', 'readOnly'],
                payload: { stageHandle, workloadUid, readOnly },
              }),
            createUnpublishRequest: async ({
              run,
              publishHandle,
              actor,
              leaseEpoch,
            }) =>
              createManagedStorageRequest({
                method: 'storage.unpublish',
                resource: run,
                actor,
                leaseEpoch,
                idempotencyKey: `unpublish:${run.metadata.uid}:${publishHandle}`,
                fields: ['publishHandle'],
                payload: { publishHandle },
              }),
            createUnstageRequest: async ({
              run,
              stageHandle,
              actor,
              leaseEpoch,
            }) =>
              createManagedStorageRequest({
                method: 'storage.unstage',
                resource: run,
                actor,
                leaseEpoch,
                idempotencyKey: `unstage:${run.metadata.uid}:${stageHandle}`,
                fields: ['stageHandle'],
                payload: { stageHandle },
              }),
          },
          recordPublished: async (volume, workload) => updatePublishedTo(volume, workload, true),
          recordUnpublished: async (volume, workload) => updatePublishedTo(volume, workload, false),
        }),
        {
          actor: volumePublishActor,
          leaseName: `run-volume-${syncNodeId}`,
          watchKind: AGENT_RUN_KIND,
          leaseTtlMs: 5000,
          resourceFilter: (resource) => {
            const run = resource as AgentRunResource;
            return run.status?.volumePhase !== 'Released' &&
              run.status?.volumePhase !== 'Failed';
          },
        },
      );
      volumeControllers = {
        binding: volumeBinding,
        provisioning: volumeProvisioning,
        publishing: runVolume,
        async stop() {
          await Promise.all([
            volumeBinding.stop(),
            volumeProvisioning.stop(),
            runVolume.stop(),
          ]);
        },
      };
    }

    const resolveModelProvider = options.workloadExecution?.resolveModelProvider ??
      (modelGateway
        ? async (
          endpoint: ModelEndpointResource,
          request: import('memeloop').LoopRunStartRequest,
        ): Promise<ILLMProvider | undefined> => {
          if (endpoint.spec.nodeId !== syncNodeId) return undefined;
          const modelClass = await controlStore.get<
            ModelClassResource['spec'],
            ModelClassResource['status']
          >(endpoint.spec.modelClassRef) as ModelClassResource | null;
          if (
            !modelClass ||
            (
              modelClass.spec.digest !== undefined &&
              endpoint.spec.modelDigest !== modelClass.spec.digest
            )
          ) {
            return undefined;
          }
          const workloadBudget = request.workload.spec.modelPolicy?.budget;
          const configuredBudget = options.modelGateway?.loopBudget;
          const maximumOutputTokens = [
            configuredBudget?.maxOutputTokens,
            workloadBudget?.maxTokens,
          ].filter((value): value is number => value !== undefined);
          const maximumCost = [
            configuredBudget?.maxCost,
            workloadBudget?.maxCost,
          ].filter((value): value is number => value !== undefined);
          const budget: ModelAccessHandleBudget = {
            ...configuredBudget,
            ...(maximumOutputTokens.length > 0
              ? { maxOutputTokens: Math.min(...maximumOutputTokens) }
              : {}),
            ...(maximumCost.length > 0 ? { maxCost: Math.min(...maximumCost) } : {}),
          };
          const policyDigest = sha256DriverValue({
            modelPolicy: request.workload.spec.modelPolicy,
            endpoint: {
              uid: endpoint.metadata.uid,
              resourceVersion: endpoint.metadata.resourceVersion,
              modelClassRef: endpoint.spec.modelClassRef,
              modelDigest: endpoint.spec.modelDigest,
              dataPolicy: endpoint.spec.dataPolicy,
            },
          });
          return createGatewayMediatedLLMProvider({
            gateway: modelGateway.gateway,
            broker: modelGateway.broker,
            modelClassRef: endpoint.spec.modelClassRef,
            ...(endpoint.spec.modelDigest !== undefined
              ? { modelDigest: endpoint.spec.modelDigest }
              : {}),
            policyDigest,
            runRef: {
              apiVersion: request.run.apiVersion,
              kind: request.run.kind,
              name: request.run.metadata.name,
              uid: request.run.metadata.uid,
            },
            attempt: 1,
            budget,
            name: llmProvider.name,
            modelId: modelClass.spec.model,
            model: llmProvider.model,
          });
        }
        : undefined);
    const inProcessDriver = createInProcessLoopRuntimeDriver(context, {
      ...(resolveModelProvider ? { resolveModelProvider } : {}),
    });
    const linuxProcessSandbox = options.workloadExecution?.processIsolation === false
      ? undefined
      : await prepareLinuxProcessSandbox();
    if (options.workloadExecution?.processIsolation !== false && !linuxProcessSandbox) {
      logger.warn?.(
        'process RuntimeClasses are unavailable: Linux cgroup/namespace/seccomp preparation failed',
      );
    }
    const processDriver = !linuxProcessSandbox
      ? undefined
      : createProcessLoopRuntimeDriver({
        osSandbox: linuxProcessSandbox,
        ...(context.runChildAgent
          ? { runChildAgent: context.runChildAgent }
          : {}),
        ...(options.workloadExecution?.modelGatewayEndpoint !== undefined
          ? { gatewayEndpoint: options.workloadExecution.modelGatewayEndpoint }
          : {}),
        ...(options.workloadExecution?.resolveModelGatewayEndpoint
          ? {
            gatewayEndpointForModelEndpoint: options.workloadExecution.resolveModelGatewayEndpoint,
          }
          : {}),
        environmentForNetworkAttachment: async (handle) => processNetworkDriver.getEnvironmentPatch(handle),
        logger: {
          warn: (...arguments_: unknown[]) => {
            const [message, ...details] = arguments_;
            if (typeof message === 'string') {
              logger.warn?.(message, ...details);
            } else {
              logger.warn?.('process loop runtime warning', message, ...details);
            }
          },
        },
      });
    const narrowLoopRuntimeDriver = createRuntimeClassRoutingDriver({
      inProcessDriver,
      ...(processDriver ? { processDriver } : {}),
    });
    const runtimeCapabilityHandle = `capability:loop-runtime:${randomBytes(32).toString('hex')}`;
    const runtimeSessionId = `node-loop-runtime:${syncNodeId}:${randomBytes(16).toString('hex')}`;
    const runtimeRoute = createManagedLoopRuntimeExecutionRoute(
      narrowLoopRuntimeDriver,
      {
        capabilities: {
          name: `node-loop-runtime/${syncNodeId}`,
          isolation: processDriver ? ['none', 'process'] : ['none'],
          supportedTrustClasses: ['trusted', 'restricted', 'quarantine'],
          supportsCheckpoint: false,
          supportsRestore: false,
          supportsAdoption: false,
          persistence: 'process',
          threatAssumptions: [
            'the Node daemon, controller envelope builder, and configured OS sandbox are trusted',
            'live runtime handles cannot be adopted after daemon restart',
          ],
        },
        authorizeRequest: (request) =>
          request.capabilityHandleRef === runtimeCapabilityHandle &&
          request.session?.id === runtimeSessionId,
        createPreparePayload(
          request: LoopRunStartRequest,
        ): LoopRuntimePreparePayload {
          const runtimeClass = request.workload.spec.runtimeClass ??
            'host-profile';
          const runtimeSpec = request.workload.spec.runtimeClass
            ? BUILTIN_RUNTIME_CLASSES[request.workload.spec.runtimeClass]
            : undefined;
          if (request.workload.spec.runtimeClass && !runtimeSpec) {
            throw new OrchestrationError({
              code: 'INVALID',
              message: `unknown RuntimeClass '${request.workload.spec.runtimeClass}'`,
              retryable: false,
            });
          }
          return {
            runtimeClass,
            runtimeDigest: sha256DriverValue({
              runtimeClass,
              runtimeSpec: runtimeSpec ?? {
                isolation: 'none',
                hostProfile: true,
              },
            }),
            ...(request.workload.spec.scriptReference
              ? { scriptDigest: request.workload.spec.scriptReference }
              : {}),
            isolation: runtimeSpec?.isolation ?? 'none',
            trustClass: request.workload.spec.trust ?? 'trusted',
          };
        },
        createRequest<T>(
          request: LoopRunStartRequest,
          method: string,
          payload: T,
        ): DriverRequestEnvelope<T> {
          const runUid = request.run.metadata.uid;
          const attempt = (request.run.spec.retry ?? 0) + 1;
          const runtimeSpec = request.workload.spec.runtimeClass
            ? BUILTIN_RUNTIME_CLASSES[request.workload.spec.runtimeClass]
            : undefined;
          const deadlineMs = Date.now() +
            (runtimeSpec?.timeLimitMs ?? 300_000) + 30_000;
          return {
            apiVersion: DRIVER_REQUEST_API_VERSION,
            method,
            resource: {
              apiVersion: request.run.apiVersion,
              kind: request.run.kind,
              name: request.run.metadata.name,
              uid: runUid,
              generation: request.run.metadata.generation,
            },
            run: { uid: runUid, attempt },
            // The durable pre-effect CAS admits one controller per immutable
            // AgentRun; attempt advances the per-resource management fence.
            fencingEpoch: attempt,
            requestId: `${method}:${randomBytes(16).toString('hex')}`,
            idempotencyKey: `${runUid}:${attempt}:${method}`,
            deadline: new Date(deadlineMs).toISOString(),
            actor: {
              id: `controller/workload-execution-${syncNodeId}`,
              kind: 'controller',
            },
            session: { id: runtimeSessionId },
            capabilityHandleRef: runtimeCapabilityHandle,
            trace: {
              traceId: randomBytes(16).toString('hex'),
              spanId: randomBytes(8).toString('hex'),
            },
            payloadSchemaDigest: sha256DriverValue({
              apiVersion: DRIVER_REQUEST_API_VERSION,
              method,
              fields: payload !== null && typeof payload === 'object'
                ? Object.keys(payload).sort()
                : [],
            }),
            payload,
          };
        },
      },
    );
    const loopRuntimeDriver = runtimeRoute.executionDriver;
    managedLoopRuntimeDriver = runtimeRoute.managementDriver;
    const advertisedModelClasses = advertisedModels.flatMap((model) => {
      const raw = model.model;
      const registered = `${model.provider}-${model.model}`
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'model';
      return raw === registered ? [raw] : [raw, registered];
    });
    const localNode: SchedulerNode = {
      faultDomain: 'local',
      healthy: true,
      roles: ['worker'],
      availableRuntimeClasses: !processDriver
        ? []
        : Object.keys(BUILTIN_RUNTIME_CLASSES),
      availableToolClasses: toolRegistry.listTools(),
      availableModelClasses: advertisedModelClasses,
      ...(options.credentialBroker && !options.workloadExecution?.localNode?.credentialCapabilities
        ? {
          credentialCapabilities: [{
            brokerClass: options.credentialBroker.brokerClass,
            audiences: options.credentialBroker.audiences,
            targets: options.credentialBroker.targets,
          }],
        }
        : {}),
      ...options.workloadExecution?.localNode,
      name: syncNodeId,
      trustClass: workerTrustClass,
    };
    const listLocalSchedulerNodes = async (): Promise<SchedulerNode[]> => {
      let networkCapabilities_ = options.workloadExecution?.localNode?.networkCapabilities;
      if (!networkCapabilities_) {
        const result = await controlStore.list<
          NetworkClassResource['spec'],
          NetworkClassResource['status']
        >({
          apiVersion: NETWORK_CLASS_API_VERSION,
          kind: NETWORK_CLASS_KIND,
        });
        networkCapabilities_ = (result.items as NetworkClassResource[])
          .filter((item) =>
            item.spec.driver === PROCESS_NETWORK_DRIVER_NAME &&
            canDriverSatisfyClass(networkCapabilities, item).satisfied
          )
          .map((item) => ({
            networkClass: item.metadata.name,
            enforcementLevel: networkCapabilities.enforcementLevel,
          }));
      }
      let availableStorageClasses = options.workloadExecution?.localNode?.availableStorageClasses;
      let availableVolumeClaims = options.workloadExecution?.localNode?.availableVolumeClaims;
      if (localStorageDriver && !availableStorageClasses) {
        const classes = await controlStore.list<
          StorageClassResource['spec'],
          StorageClassResource['status']
        >({
          apiVersion: STORAGE_CLASS_API_VERSION,
          kind: STORAGE_CLASS_KIND,
        });
        availableStorageClasses = (classes.items as StorageClassResource[])
          .filter((item) => item.spec.driver === LOCAL_DIRECTORY_STORAGE_DRIVER_NAME)
          .map((item) => item.metadata.name);
      }
      if (localStorageDriver && !availableVolumeClaims) {
        const claims = await controlStore.list<
          AgentVolumeClaimResource['spec'],
          AgentVolumeClaimResource['status']
        >({ kind: VOLUME_CLAIM_KIND });
        availableVolumeClaims = (claims.items as AgentVolumeClaimResource[])
          .filter((item) =>
            item.status?.phase === 'Bound' &&
            item.status.assignedNode === syncNodeId
          )
          .map((item) => item.metadata.name);
      }
      return [{
        ...localNode,
        networkCapabilities: networkCapabilities_,
        ...(availableStorageClasses ? { availableStorageClasses } : {}),
        ...(availableVolumeClaims ? { availableVolumeClaims } : {}),
      }];
    };
    const bindingActor = { id: `controller/binding-${syncNodeId}`, kind: 'controller' as const };
    bindingControllerRunner = await createControllerRunner(
      controlStore,
      createBindingController(controlStore, {
        actor: bindingActor,
        scheduler: createCapacityScheduler(),
        listNodes: options.workloadExecution?.listSchedulerNodes ?? listLocalSchedulerNodes,
      }),
      {
        actor: bindingActor,
        leaseName: `binding-${syncNodeId}`,
        watchKind: AGENT_WORKLOAD_KIND,
        leaseTtlMs: 5000,
      },
    );
    workloadExecutionController = createWorkloadExecutionController(controlStore, loopRuntimeDriver, {
      actor: { id: `controller/workload-execution-${syncNodeId}`, kind: 'controller' },
      nodeId: syncNodeId,
      ...(options.modelEndpointRegistration?.staleAfterMs !== undefined
        ? { modelEndpointHeartbeatTtlMs: options.modelEndpointRegistration.staleAfterMs }
        : {}),
      resolveScriptSource: async (reference) => {
        if (!scriptArtifactStore) return undefined;
        const digestHex = reference.replace(/^sha256:/, '');
        if (!/^[a-f0-9]{64}$/.test(digestHex)) return undefined;
        return scriptArtifactStore.readArtifactContent(`script-${digestHex}`);
      },
      ...(localStorageDriver
        ? {
          async resolveVolumeMounts(_workload, run) {
            const mounts = [];
            for (const binding of run.status?.volumeBindings ?? []) {
              if (
                binding.assignedNode !== syncNodeId ||
                binding.assignedDriver !== LOCAL_DIRECTORY_STORAGE_DRIVER_NAME
              ) {
                throw new OrchestrationError({
                  code: 'FORBIDDEN',
                  message: `Run volume '${binding.name}' is not bound to this node/driver`,
                  retryable: false,
                });
              }
              const published = await localStorageDriver.getPublished(binding.publishHandle);
              if (!published) {
                throw new OrchestrationError({
                  code: 'UNAVAILABLE',
                  message: `published volume '${binding.name}' cannot be resolved after restart`,
                  retryable: true,
                });
              }
              mounts.push({
                name: binding.name,
                mountPath: published.mountPath,
                readOnly: binding.readOnly,
              });
            }
            return mounts;
          },
        }
        : {}),
      onError: (error) => logger.warn?.('workload execution controller error', error),
    });
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const results = await Promise.allSettled([
      toolOperationControllers?.stop(),
      credentialGrantControllers?.stop(),
      workloadExecutionController?.stop(),
      bindingControllerRunner?.stop(),
      modelEndpointBindingControllerRunner?.stop(),
      networkAttachmentControllers?.stop(),
      volumeControllers?.stop(),
      externalOrchestrationController?.stop(),
      modelEndpointRegistrar?.stop(),
    ]);
    await ownedControlStore?.close();
    ownedStorage?.close();
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'one or more MemeLoop runtime components failed to stop',
      );
    }
  };

  return {
    stop,
    runtime,
    storage,
    controlStore,
    providerRegistry,
    toolRegistry,
    context,
    wikiManager,
    agentDefinitions,
    fileBaseDirResolved: fileBaseResolved,
    syncEngine: undefined,
    refreshWikiAgentDefinitions,
    workerTrustClass,
    modelEndpointRegistrar,
    modelGateway,
    managedLoopRuntimeDriver,
    managedCredentialDriver,
    managedStorageDriver,
    managedToolDriver,
    managedArtifactDriver,
    workerGateway,
    externalDrivers,
    externalOrchestrationController,
    toolOperationControllers,
    credentialGrantControllers,
    bindingControllerRunner,
    modelEndpointBindingControllerRunner,
    networkAttachmentControllers,
    volumeControllers,
    workloadExecutionController,
    scriptArtifactStore,
  };
}
