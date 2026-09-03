import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  AGENT_RUN_KIND,
  type AgentDefinition,
  type AgentFrameworkContext,
  AgentProfileRegistry,
  type AgentRunResource,
  type AgentRunStateStore,
  type AgentWorkloadResource,
  type ArtifactInspector,
  type ArtifactManagementDriver,
  type ArtifactManagementStateSnapshot,
  assertPortableLlmRequest,
  type AuditTelemetryManagementDriver,
  type BuiltinToolContext,
  type ControllerRunnerHandle,
  type ControlStore,
  type ControlStoreActor,
  createAgentToolLoopRunner,
  createAuditRecordAuthorizer,
  createControllerRunner,
  createControlStoreAuditTelemetryAdapter,
  createControlStoreLoopCheckpointStore,
  createControlStoreOrchestrationClient,
  createCredentialGrantBindingController,
  createCredentialGrantExecutionController,
  createCredentialGrantLifecycleController,
  createExternalOrchestrationController,
  createFakeArtifactManagementState,
  createGatewayMediatedLLMProvider,
  createManagedArtifactDriverAdapter,
  createManagedCredentialBrokerAdapter,
  createMemeLoopRuntime,
  createModelEndpointRegistrar,
  createModelProviderDriverFromLLMProvider,
  createPolicyDecisionAuthorizer,
  createScriptLoadGate,
  createWorkerEnrollmentManifest,
  CREDENTIAL_GRANT_KIND,
  type CredentialBrokerDriver,
  type CredentialBrokerEndpoint,
  type CredentialGrantResource,
  type CredentialHandleVault,
  type CredentialIssuePayload,
  type CredentialManagementDriver,
  defaultAdmissionPolicyForTrustClass,
  defaultRequestedInterfacesForTrustClass,
  type DriverRequestEnvelope,
  type ExternalOrchestrationControllerHandle,
  type FullAgentStorage,
  getBuiltinLoopProfiles,
  HookRegistry,
  type IdentityAttestationManagementDriver,
  type ILLMProvider,
  type INetworkService,
  isAgentRun,
  isAgentWorkload,
  isCredentialGrant,
  isWorkerSession,
  type IToolRegistry,
  type LoadedPlugin,
  LoopRegistryImpl,
  type LoopRuntimeManagementDriver,
  type ManagedModelDescriptor,
  type ManagedToolPolicyDecision,
  type MemeLoopRuntime,
  MODEL_CLASS_API_VERSION,
  MODEL_CLASS_KIND,
  type ModelAccessHandleBudget,
  modelClassNameForSpec,
  type ModelClassSpec,
  type ModelEndpointRegistrarHandle,
  type ModelEndpointResource,
  type NetworkAttachmentNode,
  OrchestrationError,
  PluginLoader,
  PluginRegistryManager,
  type PluginToolRegistry,
  type PolicyApprovalManagementDriver,
  type PromptConcatTool,
  type ProviderRegistration,
  ProviderRegistry,
  type ProviderRegistryResolver,
  registerBuiltinTools,
  type ReplicationNode,
  type ReplicationTransport,
  restoreArtifactManagementState,
  type SchedulerNode,
  type ScriptTrustClass,
  type StorageDriverEndpoint,
  type StorageManagementDriver,
  type ToolAdmissionPolicy,
  type ToolManagementDriver,
  type ToolOperationResource,
  ToolSchemaRegistry,
  WORKER_PROTOCOL_VERSION,
  WORKER_SESSION_API_VERSION,
  WORKER_SESSION_KIND,
  type WorkerProtocolMethod,
  type WorkerSessionResource,
  type WorkloadExecutionControllerHandle,
} from 'memeloop';
import { getApiKey } from '../auth/authStore.js';
import type { NodeConfig } from '../config.js';
import { normalizeAgentDefinition } from '../config.js';
import { type IWikiManager, TiddlyWikiWikiManager } from '../knowledge/wikiManager.js';
import {
  createAdmittedExternalDriverRegistry,
  type DiscoveredExternalDriver,
  discoverExternalDrivers,
  type ExternalDriverConformanceVerifier,
  registerExternalDriverManifests,
} from '../orchestration/externalDriverDiscovery.js';
import { createIsolatedArtifactInspector } from '../orchestration/isolatedArtifactInspector.js';
import { createFileManagedDriverStateStore, createFileManagedStorageStateStore } from '../orchestration/localDirectoryStorageDriver.js';
import { createManagedScriptArtifactStore, SCRIPT_ARTIFACT_POLICY_DIGEST } from '../orchestration/managedScriptArtifactStore.js';
import { createNodeModelGateway, type NodeModelGateway } from '../orchestration/nodeModelGateway.js';
import { hashWorkerBootstrapToken, type NodeWorkerGatewayKeyPair } from '../orchestration/nodeWorkerSecurity.js';
import type { ScriptArtifactStoreReader } from '../orchestration/scriptArtifactStore.js';
import { SQLiteControlStore } from '../orchestration/sqliteControlStore.js';
import { type WorkerArtifactUploadStore, type WorkerArtifactUploadStoreOptions } from '../orchestration/workerArtifactUploadStore.js';
import { normalizeWorkerGatewaySessionTtlMs, type WorkerGatewayHttpHandler, type WorkerGatewayHttpHandlerOptions } from '../orchestration/workerGatewayHttpHandler.js';
import { loadAllPlugins } from '../plugin/filePluginLoader.js';
import { createConfiguredProvider, resolveConfiguredModels } from '../providers/configuredProvider.js';
import { FileCheckpointStore } from '../storage/fileCheckpointStore.js';
import { SQLiteAgentStorage } from '../storage/sqliteStorage.js';
import type { ITerminalSessionManager } from '../terminal/index.js';
import { registerNodeEnvironmentTools } from '../tools/registerNodeEnvironmentTools.js';
import { createDriverRequestBuilder, sha256DriverValue } from './envelopeBuilders.js';
import { createProviderPreflight, providerCredentialMetadata } from './providerPreflight.js';
import { createRuntimeLifecycle } from './runtimeLifecycle.js';
import { createToolOperationRuntime, type ManagedPolicyRequestFactory } from './toolOperationRuntime.js';
import { ToolRegistry } from './toolRegistry.js';
import { createWorkerGatewayRuntime } from './workerGatewayRuntime.js';
import { createWorkloadRuntime } from './workloadRuntime.js';

type RuntimeChildAgent = NonNullable<AgentFrameworkContext['runChildAgent']>;

function assertRuntimeChildAgent(
  runtime: MemeLoopRuntime,
): asserts runtime is MemeLoopRuntime & { runChildAgent: RuntimeChildAgent } {
  const capability: unknown = Reflect.get(runtime, 'runChildAgent');
  if (typeof capability !== 'function') {
    throw new Error('createNodeRuntime requires the runtime-scoped child-agent capability');
  }
}

function routeProvidersThrough(
  registry: ProviderRegistryResolver,
  provider: ILLMProvider,
): ProviderRegistryResolver {
  return Object.freeze({
    get(name: string) {
      return registry.get(name) === undefined ? undefined : provider;
    },
    getConfig: (name: string) => registry.getConfig(name),
    list: () => registry.list(),
    listConfigs: () => registry.listConfigs(),
    resolve(providerId: string, modelId: string) {
      return { ...registry.resolve(providerId, modelId), provider };
    },
  });
}

async function registerProvidersFromConfig(
  providerRegistry: ProviderRegistry,
  providers: readonly import('memeloop').ProviderAccountConfig[],
): Promise<ProviderRegistration[]> {
  const registrations: ProviderRegistration[] = [];
  for (const entry of providers) {
    const provider = await createConfiguredProvider(entry);
    const configuredModels = resolveConfiguredModels(entry);
    const hasCredential = entry.secretRef !== undefined &&
      typeof getApiKey(entry.secretRef) === 'string' &&
      getApiKey(entry.secretRef)!.length > 0;
    registrations.push(providerRegistry.register(
      { ownerId: `host/config:${entry.providerId}`, kind: 'host' },
      provider,
      {
        ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
        ...(entry.secretRef === undefined ? {} : { secretRef: entry.secretRef }),
        ...providerCredentialMetadata(entry, hasCredential),
        models: configuredModels.length > 0
          ? configuredModels.map(model => ({
            modelId: model.id,
            wireModelId: model.modelName,
            apiMode: model.apiMode,
            ...(model.requestDefaults === undefined
              ? {}
              : { requestDefaults: model.requestDefaults }),
          }))
          : [{
            modelId: provider.modelId ?? 'default',
            wireModelId: provider.modelId ?? 'default',
            apiMode: 'chat-completions',
          }],
      },
    ));
  }
  return registrations;
}

function createRegistryRoutedProvider(registry: ProviderRegistry): ILLMProvider {
  return {
    name: 'registry-router',
    chat(request) {
      assertPortableLlmRequest(request);
      const route = registry.resolve(request.providerId, request.logicalModelId);
      if (
        request.wireModelId !== route.wireModelId ||
        request.apiMode !== route.apiMode
      ) throw new Error('request does not match the exact provider registry route');
      return route.provider.chat(request);
    },
  };
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
  storage?: FullAgentStorage;
  /** Durable/idempotent MemeLoop run state. Defaults to storage when it implements the port. */
  runStateStore?: AgentRunStateStore;
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
  /** Optional trusted file-plugin discovery. Disabled for embedders unless explicitly enabled. */
  plugins?: {
    enabled?: boolean;
    projectRoot?: string;
    /** Exact plugin directories admitted by the host's worker-mode policy. */
    allowedPluginPaths?: readonly string[];
  };
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
     * false only for explicit direct-local execution; the same canonical
     * ProviderRegistry route and request preparation are still required.
     */
    routeLoops?: boolean;
    /** Budget stamped into every loop-call handle (enforced at the gateway). */
    loopBudget?: ModelAccessHandleBudget;
  };
  /** Durable metadata-only audit stream. Enabled with ControlStore by default. */
  auditTelemetry?: {
    enabled?: boolean;
    maxRecordsPerResource?: number;
    maxAttributes?: number;
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
    /** Trusted lock-integrity resolver required for bare npm package names. */
    resolvePackageDigest?: (
      specifier: string,
      options: { maxBytes: number; signal?: AbortSignal },
    ) => Promise<string>;
    /** Host conformance harness plus cryptographic attestation verifier. */
    conformance?: ExternalDriverConformanceVerifier;
    /** Raw diagnostics stay local and are never persisted in DriverManifest. */
    onDiagnostic?: (file: string, error: unknown) => void;
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
    /** Ordinary control-plane request quota; artifact uploads use their own bucket. */
    maxRequestsPerMinute?: number;
    /** Optional method-specific quotas; artifact.upload defaults to 1000/minute. */
    methodRequestsPerMinute?: Partial<Record<WorkerProtocolMethod, number>>;
    /** Host disk quota, TTL, waterline and statfs boundary for worker artifacts. */
    artifacts?: WorkerArtifactUploadStoreOptions;
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
     * Host-owned replicated-storage data plane. The transport must durably
     * commit a primary epoch before accepting transfers. Fence transitions
     * and immutable primary-snapshot transfers must be idempotent for
     * controller retry after a status-CAS race. Omitting this port prevents
     * replicated StorageClasses from binding.
     */
    storageReplication?: {
      listNodes(): Promise<ReplicationNode[]>;
      transport: ReplicationTransport;
    };
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
  replication?: ControllerRunnerHandle;
  stop(): Promise<void>;
}

export interface NodeRuntimeResult {
  /**
   * Stop every controller/registrar started by this runtime and close stores
   * it created. Injected stores remain owned by the embedding host.
   */
  stop(): Promise<void>;
  runtime: MemeLoopRuntime;
  storage: FullAgentStorage;
  controlStore?: ControlStore;
  providerRegistry: ProviderRegistry;
  toolRegistry: IToolRegistry;
  /** Plugins owned by this runtime and automatically unloaded by `stop()`. */
  loadedPlugins: LoadedPlugin[];
  context: AgentFrameworkContext;
  wikiManager?: IWikiManager;
  /** 供 RPC `memeloop.agent.getDefinitions` 使用 */
  agentDefinitions: AgentDefinition[];
  /** 与 `file.*` RPC 一致的根目录 */
  fileBaseDirResolved: string;
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
   * Managed credential route. With `dataDir`, non-secret fences/replay state
   * are host-persistent alongside the injected CredentialHandleVault; raw
   * signed tokens are never returned through this API.
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
    /** Trusted host reader for run-scoped content-addressed CI artifacts. */
    artifacts: Pick<
      WorkerArtifactUploadStore,
      'resolveManifest' | 'openArtifact' | 'readArtifact' | 'deleteArtifact' | 'deleteArtifactsForRun'
    >;
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
  scriptArtifactStore?: ScriptArtifactStoreReader;
  /** Host-persistent Artifact lifecycle with process-isolated inspection. */
  managedArtifactDriver?: ArtifactManagementDriver;
  /** Process-lifecycle Ed25519 bootstrap route backed by durable WorkerSessions. */
  managedIdentityDriver?: IdentityAttestationManagementDriver;
  /** ControlStore-durable default-deny policy and authenticated approval route. */
  managedPolicyDriver?: PolicyApprovalManagementDriver;
  /** ControlStore-durable append-only audit/telemetry route. */
  managedAuditTelemetryDriver?: AuditTelemetryManagementDriver;
}

const noopNetwork: INetworkService = {
  async start() {},
  async stop() {},
};

function isPluginToolRegistry(registry: IToolRegistry): registry is IToolRegistry & PluginToolRegistry {
  return typeof registry.hasTool === 'function' &&
    typeof registry.unregisterTool === 'function' &&
    typeof (registry as Partial<PluginToolRegistry>).registerOwnedTool === 'function';
}

function isAgentRunStateStore(value: unknown): value is AgentRunStateStore {
  if (!value || typeof value !== 'object') return false;
  const store = value as Partial<AgentRunStateStore>;
  return (
    typeof store.createOrGet === 'function' &&
    typeof store.get === 'function' &&
    typeof (store as { getByRequest?: unknown }).getByRequest === 'function' &&
    typeof store.getByTurn === 'function' &&
    typeof store.transition === 'function' &&
    typeof store.listActive === 'function' &&
    typeof store.prune === 'function'
  );
}

const defaultLogger: NonNullable<AgentFrameworkContext['logger']> = {
  warn: (...arguments_: unknown[]) => {
    console.warn('[memeloop-cli]', ...arguments_);
  },
  error: (...arguments_: unknown[]) => {
    console.error('[memeloop-cli]', ...arguments_);
  },
};

interface NodeRuntimeStartupRollbackOptions<TPromptPlugin> {
  runtime: MemeLoopRuntime;
  workerGatewayStop?: () => Promise<void>;
  toolOperationControllers?: NodeToolOperationControllers;
  credentialGrantControllers?: NodeCredentialGrantControllers;
  workloadExecutionController?: WorkloadExecutionControllerHandle;
  bindingControllerRunner?: ControllerRunnerHandle;
  modelEndpointBindingControllerRunner?: ControllerRunnerHandle;
  networkAttachmentControllers?: NodeNetworkAttachmentControllers;
  volumeControllers?: NodeVolumeControllers;
  externalOrchestrationController?: ExternalOrchestrationControllerHandle;
  modelEndpointRegistrar?: ModelEndpointRegistrarHandle;
  pluginLoader?: PluginLoader;
  disposeNodeEnvironmentTools?: () => void;
  loopRegistry: LoopRegistryImpl;
  hookRegistry: HookRegistry;
  schemaRegistry: ToolSchemaRegistry;
  agentProfileRegistry: AgentProfileRegistry;
  promptPlugins: Map<string, TPromptPlugin>;
  ownedPromptPluginEntries: Map<string, TPromptPlugin>;
  ownedProviderRegistrations: ProviderRegistration[];
  ownedControlStore?: Pick<ControlStore, 'close'>;
  ownedStorage?: Pick<SQLiteAgentStorage, 'close'>;
}

/**
 * Close resources that were initialized before a later startup step failed.
 * Every action is attempted once and cleanup errors never replace the startup
 * error; this is the same ordering used by the normal runtime lifecycle.
 */
async function rollbackNodeRuntimeStartup<TPromptPlugin>(
  options: NodeRuntimeStartupRollbackOptions<TPromptPlugin>,
): Promise<void> {
  const {
    toolOperationControllers,
    credentialGrantControllers,
    workloadExecutionController,
    bindingControllerRunner,
    modelEndpointBindingControllerRunner,
    networkAttachmentControllers,
    volumeControllers,
    externalOrchestrationController,
    modelEndpointRegistrar,
  } = options;
  const controllerStops = [
    options.workerGatewayStop,
    toolOperationControllers && (() => {
      return toolOperationControllers.stop();
    }),
    credentialGrantControllers && (() => {
      return credentialGrantControllers.stop();
    }),
    workloadExecutionController && (() => {
      return workloadExecutionController.stop();
    }),
    bindingControllerRunner && (() => {
      return bindingControllerRunner.stop();
    }),
    modelEndpointBindingControllerRunner && (() => {
      return modelEndpointBindingControllerRunner.stop();
    }),
    networkAttachmentControllers && (() => {
      return networkAttachmentControllers.stop();
    }),
    volumeControllers && (() => {
      return volumeControllers.stop();
    }),
    externalOrchestrationController && (() => {
      return externalOrchestrationController.stop();
    }),
    modelEndpointRegistrar && (() => {
      return modelEndpointRegistrar.stop();
    }),
  ].filter((stop): stop is () => Promise<void> => stop !== undefined);
  await Promise.allSettled(controllerStops.map((stop) => stop()));

  await Promise.allSettled([
    options.runtime.dispose(),
    options.pluginLoader?.unloadAllPlugins(),
  ]);

  const componentDisposals: Array<() => void> = [
    options.disposeNodeEnvironmentTools,
    () => {
      options.loopRegistry.reset();
    },
    () => {
      options.hookRegistry.clearHooks();
    },
    () => {
      options.schemaRegistry.clear();
    },
    () => {
      options.agentProfileRegistry.reset();
    },
    () => {
      for (const [key, value] of options.ownedPromptPluginEntries) {
        if (options.promptPlugins.get(key) === value) options.promptPlugins.delete(key);
      }
    },
    () => {
      for (const registration of options.ownedProviderRegistrations) registration.dispose();
    },
  ].filter((dispose): dispose is () => void => dispose !== undefined);
  await Promise.allSettled(componentDisposals.map((dispose) => Promise.resolve().then(dispose)));

  await Promise.allSettled([
    options.ownedControlStore && options.ownedControlStore.close(),
    options.ownedStorage && Promise.resolve().then(() => options.ownedStorage?.close()),
  ]);
}

/**
 * Build MemeLoopRuntime + storage + LLM + IToolRegistry with optional injection for embedders (SDK).
 *
 * **CLI default:** pass `config` + `dataDir` → SQLite + `config.providers` + `ToolRegistry(config.tools)`.
 *
 * **Embed (e.g. TidGi-Desktop):** pass `storage` + `llmProvider` + optional `toolRegistry` / `configureTools` /
 * `builtinToolContext` / `wikiManager`; `config` and `dataDir` may be omitted.
 */
export async function createNodeRuntime(options: NodeRuntimeOptions): Promise<NodeRuntimeResult> {
  const workerGatewaySessionTtlMs = normalizeWorkerGatewaySessionTtlMs(
    options.workerGateway?.sessionTtlMs,
  );
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
  const logger = options.logger ?? defaultLogger;

  let storage: FullAgentStorage;
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

  const policyDecisionAuthorizer = createPolicyDecisionAuthorizer();
  const auditRecordAuthorizer = createAuditRecordAuthorizer();
  const ownedControlStore = !options.controlStore && options.dataDir
    ? new SQLiteControlStore({
      filename: path.join(options.dataDir, 'control.db'),
      nativeBinding: options.sqliteNativeBinding,
      authorizer: {
        authorize(request) {
          if (
            request.actor.kind !== 'admin' &&
            request.actor.kind !== 'controller' &&
            request.actor.kind !== 'verifier'
          ) {
            throw new OrchestrationError({
              code: 'FORBIDDEN',
              message: `actor '${request.actor.id}' cannot ${request.verb} ControlStore resources`,
              retryable: false,
            });
          }
          policyDecisionAuthorizer(request);
          auditRecordAuthorizer(request);
        },
      },
    })
    : undefined;
  const controlStore = options.controlStore ?? ownedControlStore;

  // Script deployment security chain (plan 24.15): generated scripts are
  // admitted by the load gate under this node's trust class, and admitted
  // artifacts persist through the managed content-addressed driver.
  const workerTrustClass: ScriptTrustClass = options.trustClass ?? 'trusted';
  let managedArtifactDriver: ArtifactManagementDriver | undefined;
  let scriptArtifactStore: ScriptArtifactStoreReader | undefined;
  if (options.dataDir) {
    const maxArtifactBytes = options.artifactManagement?.maxArtifactBytes ??
      1024 * 1024;
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
      capabilityHandleRef: artifactCapability,
      sessionId: artifactSession,
      actorId: `controller/artifact-${(options.localNodeId ?? 'memeloop-local').trim() || 'memeloop-local'}`,
      maxArtifactBytes,
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
    const memoryPath = path.join(process.cwd(), 'memeloop.md');
    try {
      projectMemory = fs.readFileSync(memoryPath, 'utf-8').trim();
    } catch (error: unknown) {
      // A missing project-memory file is expected for a fresh workspace. Any
      // other read failure is actionable and must remain visible to hosts.
      const code = error !== null && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
      if (code !== 'ENOENT') {
        logger.warn?.(`failed to load project memory from '${memoryPath}'`, error);
      }
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
  let defaultModelConfig = config.defaultModelConfig;
  const ownedProviderRegistrations: ProviderRegistration[] = [];

  if (options.llmProvider) {
    providerRegistry = options.providerRegistry ?? new ProviderRegistry();
    llmProvider = options.llmProvider;
    if (!providerRegistry.get(llmProvider.name)) {
      const modelId = defaultModelConfig?.providerId === llmProvider.name
        ? defaultModelConfig.modelId
        : llmProvider.modelId ?? 'default';
      ownedProviderRegistrations.push(providerRegistry.register(
        { ownerId: 'host/injected-provider', kind: 'host' },
        llmProvider,
        { models: [{ modelId, wireModelId: modelId, apiMode: 'chat-completions' }] },
      ));
    }
    defaultModelConfig ??= {
      providerId: llmProvider.name,
      modelId: providerRegistry.getConfig(llmProvider.name)?.models[0]?.modelId ??
        llmProvider.modelId ?? 'default',
    };
  } else {
    providerRegistry = options.providerRegistry ?? new ProviderRegistry();
    ownedProviderRegistrations.push(
      ...await registerProvidersFromConfig(
        providerRegistry,
        config.providers ?? [],
      ),
    );
    if (providerRegistry.list().length === 0) {
      throw new Error('createNodeRuntime: at least one configured exact provider/model route is required');
    }
    if (defaultModelConfig) {
      providerRegistry.resolve(defaultModelConfig.providerId, defaultModelConfig.modelId);
    }
    llmProvider = createRegistryRoutedProvider(providerRegistry);
  }

  const toolRegistry: IToolRegistry = options.toolRegistry ?? new ToolRegistry(config.tools);
  const hookRegistry = new HookRegistry();
  const loopRegistry = new LoopRegistryImpl();
  const schemaRegistry = new ToolSchemaRegistry();
  const promptPlugins: Map<string, PromptConcatTool> = toolRegistry.getPromptPlugins?.() ??
    new Map<string, PromptConcatTool>();

  if (options.configureTools) {
    options.configureTools(toolRegistry);
  }

  const conversationCancellation = options.conversationCancellation ?? new Set<string>();
  const network = options.network ?? noopNetwork;
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
    autoCompact: options.agentToolLoop?.autoCompact ?? {
      recentTurnsToKeep: 32,
      maxTokens: 128_000,
    },
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
  const agentProfileRegistry = new AgentProfileRegistry();
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
  let managedAuditTelemetryDriver: AuditTelemetryManagementDriver | undefined;
  let createManagedAuditRequest:
    | (<T>(input: {
      method: string;
      payload: T;
      resource: {
        apiVersion: string;
        kind: string;
        metadata: {
          name: string;
          uid: string;
          generation: number;
        };
      };
      idempotencyKey: string;
      payloadFields: string[];
    }) => DriverRequestEnvelope<T>)
    | undefined;
  if (controlStore && options.auditTelemetry?.enabled !== false) {
    const auditCapability = `capability:audit:${randomBytes(32).toString('hex')}`;
    const auditSession = `node-audit:${syncNodeId}:${randomBytes(16).toString('hex')}`;
    const auditActor = {
      id: `controller/audit-${syncNodeId}`,
      kind: 'controller' as const,
    };
    const buildAuditRequest = createDriverRequestBuilder({
      actor: auditActor,
      sessionId: auditSession,
      capabilityHandleRef: auditCapability,
      controller: 'audit',
      deadlineMs: 60_000,
    });
    createManagedAuditRequest = <T>(input: {
      method: string;
      payload: T;
      resource: {
        apiVersion: string;
        kind: string;
        metadata: {
          name: string;
          uid: string;
          generation: number;
        };
      };
      idempotencyKey: string;
      payloadFields: string[];
    }): DriverRequestEnvelope<T> =>
      buildAuditRequest({
        method: input.method,
        payload: input.payload,
        resource: input.resource,
        fencingEpoch: Math.max(1, input.resource.metadata.generation),
        idempotencyKey: input.idempotencyKey,
        payloadSchema: {
          apiVersion: `drivers.memeloop.io/${input.method}/v1alpha1`,
          fields: input.payloadFields,
        },
      });
    managedAuditTelemetryDriver = createControlStoreAuditTelemetryAdapter({
      store: controlStore,
      name: `${syncNodeId}-audit`,
      persistence: 'host',
      authorizeRequest: (request) =>
        request.capabilityHandleRef === auditCapability &&
        request.session?.id === auditSession &&
        request.actor.id === auditActor.id,
      ...(options.auditTelemetry?.maxRecordsPerResource !== undefined
        ? {
          maxRecordsPerResource: options.auditTelemetry.maxRecordsPerResource,
        }
        : {}),
      ...(options.auditTelemetry?.maxAttributes !== undefined
        ? { maxAttributes: options.auditTelemetry.maxAttributes }
        : {}),
      threatAssumptions: [
        'the ControlStore, append lease, daemon capability, request factory, and host clock are trusted',
        'records contain bounded metadata and digests only; raw prompts, outputs, tool arguments, and credentials are excluded',
      ],
    });
  }

  const orchestrationClient = controlStore
    ? createControlStoreOrchestrationClient(controlStore, {
      id: `controller/runtime-manager-${syncNodeId}`,
      kind: 'controller',
    })
    : undefined;
  const context: AgentFrameworkContext = {
    storage,
    llmProvider,
    modelProviderRegistry: providerRegistry,
    defaultModelConfig,
    preflightAgentRun: createProviderPreflight(providerRegistry),
    localNodeId: syncNodeId,
    tools: toolRegistry,
    syncAdapters: [],
    network,
    hooks: hookRegistry,
    loopRegistry,
    toolSchemas: schemaRegistry,
    promptPlugins,
    agentProfiles: agentProfileRegistry,
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
  const promptPluginsBeforeBuiltinRegistration = new Set(promptPlugins.keys());
  try {
    registerBuiltinTools(toolRegistry, builtinToolContext);
  } catch (error) {
    try {
      loopRegistry.reset();
    } finally {
      for (const key of [...promptPlugins.keys()]) {
        if (!promptPluginsBeforeBuiltinRegistration.has(key)) promptPlugins.delete(key);
      }
    }
    throw error;
  }
  const ownedPromptPluginEntries = new Map(
    [...promptPlugins].filter(([key]) => !promptPluginsBeforeBuiltinRegistration.has(key)),
  );

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

  let disposeNodeEnvironmentTools: () => void;
  try {
    disposeNodeEnvironmentTools = registerNodeEnvironmentTools(toolRegistry, {
      terminalManager: options.terminalManager,
      fileBaseDir: fileBaseResolved,
      wikiManager,
      wikiDefaultId: 'default',
      includeVscodeCli: options.includeVscodeCli !== false,
      storage,
      nodeId: syncNodeId,
    });
  } catch (error) {
    try {
      loopRegistry.reset();
    } finally {
      for (const [key, value] of ownedPromptPluginEntries) {
        if (promptPlugins.get(key) === value) promptPlugins.delete(key);
      }
    }
    throw error;
  }

  let pluginLoader: PluginLoader | undefined;
  let loadedPlugins: LoadedPlugin[] = [];
  if (options.plugins?.enabled === true) {
    if (!options.plugins.allowedPluginPaths || options.plugins.allowedPluginPaths.length === 0) {
      throw new Error(
        'createNodeRuntime: plugin loading requires a non-empty exact allowedPluginPaths allowlist',
      );
    }
    if (!isPluginToolRegistry(toolRegistry)) {
      throw new Error(
        'createNodeRuntime: plugin loading requires toolRegistry.hasTool() and toolRegistry.unregisterTool()',
      );
    }
    pluginLoader = new PluginLoader({
      registryManager: new PluginRegistryManager({
        hookRegistry,
        schemaRegistry,
      }),
      apiOptions: {
        toolRegistry,
        agentProfileRegistry,
        loopRegistry,
        providerRegistry,
        logger: {
          debug: (message, ...arguments_) => logger.debug?.(message, ...arguments_),
          info: (message, ...arguments_) => logger.info?.(message, ...arguments_),
          warn: (message, ...arguments_) => logger.warn?.(message, ...arguments_),
          error: (message, ...arguments_) => logger.error?.(message, ...arguments_),
        },
      },
    });
    loadedPlugins = await loadAllPlugins(
      {
        loader: pluginLoader,
        allowedPluginPaths: options.plugins.allowedPluginPaths,
        onError: (error, source) => {
          logger.warn?.(`plugin load failed: ${source}`, error);
        },
      },
      options.plugins.projectRoot,
    );
  }

  const runStateStore = options.runStateStore ?? (isAgentRunStateStore(storage) ? storage : undefined);
  if (!runStateStore) {
    throw new Error(
      'createNodeRuntime: storage must implement AgentRunStateStore or runStateStore must be injected',
    );
  }

  // Plan 24.36: advertise this node's models as ModelClass/ModelEndpoint
  // resources and keep their health/heartbeat fresh so the scheduler can
  // place model calls. Trust and node identity stay host-bound.
  const configuredModels: ModelClassSpec[] = (config.providers ?? []).flatMap((entry) =>
    entry.models.map((route) => {
      const model = entry.catalogProvider?.models.find(candidate => candidate.id === route.modelId);
      return {
        provider: entry.providerId,
        model: route.wireModelId,
        ...(model?.limit?.context ? { contextWindow: model.limit.context } : {}),
        ...(model?.limit?.output ? { maxOutputTokens: model.limit.output } : {}),
        ...(model?.toolCall !== undefined
          ? { capabilities: { toolUse: model.toolCall } }
          : {}),
        ...(model?.modalities?.input
          ? {
            modalities: model.modalities.input.flatMap(modality =>
              modality === 'image'
                ? ['vision' as const]
                : modality === 'text' || modality === 'audio'
                ? [modality]
                : []
            ),
          }
          : {}),
      };
    })
  );
  const registryModels: ModelClassSpec[] = providerRegistry.listConfigs().flatMap(config =>
    config.models.map(route => ({ provider: config.providerId, model: route.wireModelId }))
  );
  // `ILLMProvider.model` is often an AI SDK model factory/object. It is a
  // runtime capability, not serializable orchestration metadata. Persist only
  // the explicit modelId (or a stable host/provider fallback) in ModelClass.
  const advertisedModelId = llmProvider.modelId ??
    (typeof llmProvider.model === 'string' ? llmProvider.model : undefined) ??
    (defaultModelConfig
      ? providerRegistry.resolve(
        defaultModelConfig.providerId,
        defaultModelConfig.modelId,
      ).wireModelId
      : undefined) ??
    llmProvider.name ??
    'default';
  const advertisedModels = configuredModels.length > 0
    ? configuredModels
    : registryModels.length > 0
    ? registryModels
    : [{ provider: llmProvider.name, model: advertisedModelId }];
  const advertisedRoutes = providerRegistry.listConfigs().flatMap(config =>
    config.models.map(route => ({
      modelClassName: modelClassNameForSpec({ provider: config.providerId, model: route.wireModelId }),
      providerId: config.providerId,
      logicalModelId: route.modelId,
      wireModelId: route.wireModelId,
      apiMode: route.apiMode,
    }))
  );
  let modelEndpointRegistrar: ModelEndpointRegistrarHandle | undefined;
  if (controlStore && options.modelEndpointRegistration?.enabled !== false) {
    const driver = createModelProviderDriverFromLLMProvider(llmProvider, {
      models: advertisedModels,
      routes: advertisedRoutes,
    });
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
        routes: advertisedRoutes,
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
      ...(managedAuditTelemetryDriver && createManagedAuditRequest
        ? {
          async onRecorded(record, resource) {
            const phase = record.status.phase ?? 'Failed';
            await managedAuditTelemetryDriver.appendAudit(
              createManagedAuditRequest({
                method: 'audit.append',
                payload: {
                  policyDigest: record.spec.policyDigest ??
                    sha256DriverValue({ policy: 'model-gateway' }),
                  effect: 'execute' as const,
                  provenance: {
                    source: 'gateway' as const,
                    producer: 'model-gateway',
                    subject: `model-call/${resource.metadata.uid}`,
                  },
                  attributes: {
                    modelClass: record.spec.modelClassRef.name,
                    phase,
                  },
                  action: 'model.generate',
                  outcome: phase === 'Completed'
                    ? 'success' as const
                    : phase === 'Cancelled'
                    ? 'denied' as const
                    : 'failure' as const,
                  ...(record.status.error?.code
                    ? { reasonCode: record.status.error.code }
                    : {}),
                },
                resource,
                idempotencyKey: `${resource.metadata.uid}:model-gateway:${phase}`,
                payloadFields: [
                  'policyDigest',
                  'effect',
                  'provenance',
                  'attributes',
                  'action',
                  'outcome',
                  'reasonCode',
                ],
              }),
            );
          },
        }
        : {}),
      onError: (error) => logger.warn?.('model gateway error', error),
    });
  }

  // Plan §12.1 / 24.35: route loop model calls through the gateway by
  // default. Explicit direct-local execution remains available for trusted
  // embedders, but still uses the canonical provider registry and prepared
  // request route; all execution uses the canonical request construction path.
  if (modelGateway && options.modelGateway?.routeLoops !== false) {
    const primaryAdvertisement = advertisedModels[0];
    const rawModelName = llmProvider.modelId ??
      (typeof llmProvider.model === 'string' ? llmProvider.model : undefined) ??
      primaryAdvertisement?.model;
    const modelClassName = primaryAdvertisement
      ? modelClassNameForSpec(primaryAdvertisement)
      : 'default';
    const gatewayMediatedProvider = createGatewayMediatedLLMProvider({
      gateway: modelGateway.gateway,
      broker: modelGateway.broker,
      modelClassRef: { apiVersion: MODEL_CLASS_API_VERSION, kind: MODEL_CLASS_KIND, name: modelClassName },
      name: llmProvider.name,
      modelId: typeof rawModelName === 'string' ? rawModelName : modelClassName,
      model: llmProvider.model,
      resolveModelForRequest(request) {
        const route = providerRegistry.resolve(request.providerId, request.logicalModelId);
        if (
          request.wireModelId !== route.wireModelId ||
          request.apiMode !== route.apiMode
        ) throw new Error('gateway request route does not match the exact provider registry route');
        const selected = advertisedModels.find(model => model.provider === route.providerId && model.model === route.wireModelId);
        if (!selected) {
          throw new OrchestrationError({
            code: 'INVALID',
            message: `requested model '${route.providerId}/${route.modelId}' is not advertised by this runtime`,
            retryable: false,
          });
        }
        return {
          modelClassRef: {
            apiVersion: MODEL_CLASS_API_VERSION,
            kind: MODEL_CLASS_KIND,
            name: modelClassNameForSpec(selected),
          },
          ...(selected.digest !== undefined ? { modelDigest: selected.digest } : {}),
        };
      },
      ...(options.modelGateway?.loopBudget !== undefined ? { budget: options.modelGateway.loopBudget } : {}),
    });
    context.llmProvider = gatewayMediatedProvider;
    context.modelProviderRegistry = routeProvidersThrough(
      providerRegistry,
      gatewayMediatedProvider,
    );
  }

  // Runtime construction snapshots and isolates its framework context. Finish
  // all host-side model routing first so every entry point (including worker
  // child agents) observes the same gateway-mediated provider.
  const runtime = createMemeLoopRuntime(context, { runStateStore });
  assertRuntimeChildAgent(runtime);

  // Plan §13 / 24.62: dedicated worker gateway. The gateway owns
  // enrollment, capability dispatch, checkpoint fencing, and artifact quotas;
  // createNodeRuntime only wires host-owned dependencies and exposes the
  // resulting handler/identity route.
  let workerGateway: NodeRuntimeResult['workerGateway'];
  let workerGatewayKeys: NodeWorkerGatewayKeyPair | undefined;
  let workerGatewayStop: (() => Promise<void>) | undefined;
  let managedIdentityDriver: IdentityAttestationManagementDriver | undefined;
  if (
    controlStore &&
    options.dataDir &&
    options.workerGateway?.enabled !== false
  ) {
    const audit = managedAuditTelemetryDriver && createManagedAuditRequest
      ? {
        onAudit: async (event: Parameters<NonNullable<WorkerGatewayHttpHandlerOptions['onAudit']>>[0]) => {
          const sessionResource = await controlStore.get<
            WorkerSessionResource['spec'],
            WorkerSessionResource['status']
          >({
            apiVersion: WORKER_SESSION_API_VERSION,
            kind: WORKER_SESSION_KIND,
            name: event.sessionName,
          });
          const session = sessionResource &&
              sessionResource.apiVersion === WORKER_SESSION_API_VERSION &&
              isWorkerSession(sessionResource)
            ? sessionResource
            : null;
          const rejectedSessionDigest = sha256DriverValue(event.sessionName);
          const resource = session ?? {
            apiVersion: 'audit.memeloop.io/v1alpha1',
            kind: 'WorkerGateway',
            metadata: {
              name: `rejected-${rejectedSessionDigest.slice('sha256:'.length, 46)}`,
              uid: rejectedSessionDigest,
              generation: 1,
            },
          };
          await managedAuditTelemetryDriver.appendAudit(
            createManagedAuditRequest({
              method: 'audit.append',
              payload: {
                policyDigest: session?.spec.policyDigest ??
                  sha256DriverValue({ policy: 'worker-gateway-rejection' }),
                effect: 'security' as const,
                provenance: {
                  source: 'gateway' as const,
                  producer: 'worker-protocol-gateway',
                  subject: session
                    ? `worker-session/${session.metadata.uid}`
                    : 'worker-session/rejected',
                },
                attributes: {
                  method: event.method,
                  targetDigest: sha256DriverValue(event.target),
                  accepted: String(event.accepted),
                  ...(event.code ? { resultCode: event.code } : {}),
                },
                action: 'worker.protocol-request',
                outcome: event.accepted ? 'success' as const : 'denied' as const,
                ...(event.code ? { reasonCode: event.code } : {}),
              },
              resource,
              idempotencyKey: `${resource.metadata.uid}:worker-request:${event.requestId}`,
              payloadFields: [
                'policyDigest',
                'effect',
                'provenance',
                'attributes',
                'action',
                'outcome',
                'reasonCode',
              ],
            }),
          );
        },
      }
      : undefined;
    const gateway = createWorkerGatewayRuntime({
      controlStore,
      dataDir: options.dataDir,
      nodeId: syncNodeId,
      sessionTtlMs: workerGatewaySessionTtlMs,
      config: options.workerGateway,
      runtime,
      loopCheckpoints: context.loopCheckpoints,
      getLoopCheckpoints: () => context.loopCheckpoints,
      logger,
      ...(audit ? { audit } : {}),
    });
    workerGatewayKeys = gateway.keys;
    workerGatewayStop = () => gateway.close();
    managedIdentityDriver = gateway.identityDriver;
    workerGateway = {
      handler: gateway.handler,
      publicKey: gateway.publicKey,
      publicKeyFingerprint: gateway.publicKeyFingerprint,
      artifacts: gateway.artifacts,
    };
  }

  // Plan 24.62: external orchestrator driver discovery (CNI-analogue
  // manifests in drivers.d) and ControlStore DriverManifest registration.
  let externalDrivers: DiscoveredExternalDriver[] | undefined;
  let authorizeHostToolOperation:
    | ((
      operation: ToolOperationResource,
      signal?: AbortSignal,
    ) => Promise<ManagedToolPolicyDecision>)
    | undefined;
  let authorizeHostExternalWorkload:
    | ((
      workload: AgentWorkloadResource,
      driverName: string,
    ) => Promise<{ decisionHandle: string; policyDigest: string }>)
    | undefined;
  let createManagedPolicyRequest: ManagedPolicyRequestFactory | undefined;
  let startExternalOrchestrationController:
    | (() => ExternalOrchestrationControllerHandle)
    | undefined;
  let externalOrchestrationController: ExternalOrchestrationControllerHandle | undefined;
  let toolOperationControllers: NodeToolOperationControllers | undefined;
  let managedToolDriver: ToolManagementDriver | undefined;
  let managedPolicyDriver: PolicyApprovalManagementDriver | undefined;
  let credentialGrantControllers: NodeCredentialGrantControllers | undefined;
  let managedCredentialDriver: CredentialManagementDriver | undefined;
  let bindingControllerRunner: ControllerRunnerHandle | undefined;
  let modelEndpointBindingControllerRunner: ControllerRunnerHandle | undefined;
  let networkAttachmentControllers: NodeNetworkAttachmentControllers | undefined;
  let volumeControllers: NodeVolumeControllers | undefined;
  let managedStorageDriver: StorageManagementDriver | undefined;
  let workloadExecutionController: WorkloadExecutionControllerHandle | undefined;
  let managedLoopRuntimeDriver: LoopRuntimeManagementDriver | undefined;
  try {
    if (controlStore && options.dataDir && options.externalDrivers?.enabled !== false) {
      const discoveryDirectory = options.externalDrivers?.directory ?? path.join(options.dataDir, 'drivers.d');
      const discovery = await discoverExternalDrivers({
        directory: discoveryDirectory,
        ...(options.externalDrivers?.resolvePackageDigest === undefined
          ? {}
          : { resolvePackageDigest: options.externalDrivers.resolvePackageDigest }),
        ...(options.externalDrivers?.conformance === undefined
          ? {}
          : { conformance: options.externalDrivers.conformance }),
        ...(options.externalDrivers?.onDiagnostic === undefined
          ? {}
          : { onDiagnostic: options.externalDrivers.onDiagnostic }),
      });
      for (const discoveryError of discovery.errors) {
        logger.warn?.(`external driver manifest '${discoveryError.file}' skipped: ${discoveryError.error}`);
      }
      if (discovery.drivers.length > 0) {
        const registration = await registerExternalDriverManifests(
          controlStore,
          options.externalDrivers?.conformance
            ? { id: `verifier/external-driver-${syncNodeId}`, kind: 'verifier' }
            : { id: `controller/driver-registry-${syncNodeId}`, kind: 'controller' },
          discovery.drivers,
          options.externalDrivers?.onDiagnostic,
        );
        for (const registrationError of registration.errors) {
          logger.warn?.(`external driver '${registrationError.name}' registration failed: ${registrationError.error}`);
        }
      }
      externalDrivers = discovery.drivers;
      const admittedExternalDrivers = (
        await createAdmittedExternalDriverRegistry(
          controlStore,
          discovery.drivers,
          options.externalDrivers?.conformance,
        )
      ).values();
      startExternalOrchestrationController = () =>
        createExternalOrchestrationController(controlStore, {
          actor: { id: `controller/external-orchestration-${syncNodeId}`, kind: 'controller' },
          drivers: admittedExternalDrivers,
          async authorizeToolOperation(operation, signal) {
            if (!authorizeHostToolOperation) {
              throw new OrchestrationError({
                code: 'FORBIDDEN',
                message: 'external ToolOperation has no enabled host tool policy route',
                retryable: false,
              });
            }
            return await authorizeHostToolOperation(operation, signal);
          },
          async authorizeWorkloadPlacement(workload, driver) {
            if (!authorizeHostExternalWorkload) {
              throw new OrchestrationError({
                code: 'FORBIDDEN',
                message: 'external AgentWorkload has no enabled host placement policy route',
                retryable: false,
              });
            }
            return await authorizeHostExternalWorkload(workload, driver.name);
          },
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
                const runResource = await controlStore.get<AgentRunResource['spec'], AgentRunResource['status']>(
                  runReference,
                );
                const run = runResource && isAgentRun(runResource) ? runResource : null;
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
                const ttlMs = workerGatewaySessionTtlMs;
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
                    allowedMethods: [
                      'assignment.pull',
                      'capability.request',
                      'artifact.upload',
                      'checkpoint.load',
                      'checkpoint.save',
                    ],
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

    // ToolOperation placement/binding/execution is isolated behind a typed
    // resource adapter. The runtime only wires host dependencies and keeps the
    // policy request factory for workload/external placement below.
    if (controlStore) {
      const toolAudit = managedAuditTelemetryDriver && createManagedAuditRequest
        ? async (operation: ToolOperationResource, result: import('memeloop').ToolOperationResult) => {
          const resultDigest = sha256DriverValue(result);
          const policyDigest = sha256DriverValue({
            admission: options.toolExecution?.admission ?? defaultAdmissionPolicyForTrustClass(workerTrustClass),
            operationPolicy: operation.spec.policy,
            tool: operation.spec.toolRef.name,
            effect: operation.spec.effect,
          });
          await managedAuditTelemetryDriver.appendAudit(
            createManagedAuditRequest({
              method: 'audit.append',
              payload: {
                policyDigest,
                effect: operation.spec.effect === 'unknown' ? 'execute' as const : operation.spec.effect,
                provenance: {
                  source: 'driver' as const,
                  producer: 'managed-tool-execution',
                  subject: `tool-operation/${operation.metadata.uid}`,
                },
                attributes: {
                  toolName: operation.spec.toolRef.name,
                  operationEffect: operation.spec.effect,
                  resultDigest,
                },
                action: 'tool.execute',
                outcome: result.error
                  ? result.error.code === 'FORBIDDEN' || result.error.code === 'CANCELLED'
                    ? 'denied' as const
                    : 'failure' as const
                  : 'success' as const,
                ...(result.error?.code ? { reasonCode: result.error.code } : {}),
              },
              resource: operation,
              idempotencyKey: `${operation.metadata.uid}:tool-result:${resultDigest}`,
              payloadFields: [
                'policyDigest',
                'effect',
                'provenance',
                'attributes',
                'action',
                'outcome',
                'reasonCode',
              ],
            }),
          );
        }
        : undefined;
      let toolRuntime: Awaited<ReturnType<typeof createToolOperationRuntime>>;
      try {
        toolRuntime = await createToolOperationRuntime({
          controlStore,
          nodeId: syncNodeId,
          trustClass: workerTrustClass,
          toolRegistry,
          builtinToolContext,
          logger,
          toolExecution: options.toolExecution,
          workloadNodeLabels: options.workloadExecution?.localNode?.labels,
          ...(toolAudit ? { auditToolExecution: toolAudit } : {}),
        });
      } catch (error) {
        await workerGatewayStop?.();
        workerGatewayStop = undefined;
        throw error;
      }
      toolOperationControllers = toolRuntime.toolOperationControllers;
      managedToolDriver = toolRuntime.managedToolDriver;
      managedPolicyDriver = toolRuntime.managedPolicyDriver;
      createManagedPolicyRequest = toolRuntime.createManagedPolicyRequest;
      authorizeHostToolOperation = toolRuntime.authorizeHostToolOperation;
      authorizeHostExternalWorkload = toolRuntime.authorizeHostExternalWorkload;
    }
    externalOrchestrationController = startExternalOrchestrationController?.();

    if (controlStore && options.credentialBroker) {
      const credentialConfig = options.credentialBroker;
      const credentialMaxTtlMs = credentialConfig.maxTtlMs ?? 60 * 60_000;
      const credentialCapabilityHandle = `capability:credential:${randomBytes(32).toString('hex')}`;
      const credentialSessionId = `node-credential:${syncNodeId}:${randomBytes(16).toString('hex')}`;
      const buildCredentialRequest = createDriverRequestBuilder({
        actor: { id: `controller/credential-${syncNodeId}`, kind: 'controller' },
        sessionId: credentialSessionId,
        capabilityHandleRef: credentialCapabilityHandle,
        controller: 'credential',
        deadlineMs: 30_000,
      });
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
      const stableCredentialHandle = (grantUid: string): string => `credential://${syncNodeId}/${grantUid}`;
      const createManagedCredentialRequest = <T>(input: {
        method: string;
        payload: T;
        grant: CredentialGrantResource;
        actor: ControlStoreActor;
        leaseEpoch: string;
        payloadSchemaDigest: string;
      }): DriverRequestEnvelope<T> =>
        buildCredentialRequest({
          method: input.method,
          payload: input.payload,
          resource: input.grant,
          run: {
            uid: input.grant.spec.runRef.uid,
            attempt: input.grant.spec.attempt,
          },
          fencingEpoch: input.leaseEpoch,
          idempotencyKey: `${input.grant.metadata.uid}:${input.method}`,
          sessionKeyFingerprint: input.grant.spec.workerKey,
          payloadSchemaDigest: input.payloadSchemaDigest,
          actor: input.actor,
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
          ...(options.dataDir
            ? {
              stateStore: createFileManagedDriverStateStore(
                path.join(options.dataDir, 'credentials', '.managed-state'),
              ),
            }
            : {}),
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
            const runResource = await controlStore.get<
              AgentRunResource['spec'],
              AgentRunResource['status']
            >(grant.spec.runRef);
            const run = runResource && isAgentRun(runResource) ? runResource : null;
            if (!run || run.metadata.uid !== grant.spec.runRef.uid) {
              return { denyReason: 'referenced AgentRun identity is unavailable' };
            }
            const workloadReference = run.spec.workloadRef;
            const workloadResource = await controlStore.get<
              AgentWorkloadResource['spec'],
              AgentWorkloadResource['status']
            >({
              apiVersion: workloadReference.apiVersion,
              kind: workloadReference.kind,
              name: workloadReference.name,
              namespace: run.metadata.namespace,
            });
            const workload = workloadResource && isAgentWorkload(workloadResource)
              ? workloadResource
              : null;
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
            return isCredentialGrant(resource) && (!resource.status?.phase || resource.status.phase === 'Pending');
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
            return isCredentialGrant(resource) && resource.status?.assignedNode === syncNodeId &&
              (resource.status.phase === 'Pending' || resource.status.phase === 'Issuing');
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
            const runResource = await controlStore.get<
              AgentRunResource['spec'],
              AgentRunResource['status']
            >(grant.spec.runRef);
            const run = runResource && isAgentRun(runResource) ? runResource : null;
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
            return isCredentialGrant(resource) && resource.status?.assignedNode === syncNodeId &&
              (resource.status.phase === 'Issued' || resource.status.phase === 'Renewed');
          },
        },
      );
      const cleanupAbort = new AbortController();
      const cleanupIterator = controlStore.watch<
        CredentialGrantResource['spec'],
        CredentialGrantResource['status']
      >(
        { kind: CREDENTIAL_GRANT_KIND },
        { signal: cleanupAbort.signal },
      )[Symbol.asyncIterator]();
      const runCleanupIterator = controlStore.watch<
        AgentRunResource['spec'],
        AgentRunResource['status']
      >(
        { kind: AGENT_RUN_KIND },
        { signal: cleanupAbort.signal, sendInitialEvents: true },
      )[Symbol.asyncIterator]();
      let cleanupStopped = false;
      const cleanupDone = (async () => {
        while (!cleanupStopped) {
          const event = await cleanupIterator.next();
          if (event.done || !event.value) break;
          if (event.value.type === 'DELETED' && isCredentialGrant(event.value.resource)) {
            const grant = event.value.resource;
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
      const markTerminalGrantRevoked = async (
        observedGrant: CredentialGrantResource,
      ): Promise<void> => {
        const reference = {
          apiVersion: observedGrant.apiVersion,
          kind: observedGrant.kind,
          name: observedGrant.metadata.name,
          namespace: observedGrant.metadata.namespace,
        };
        const revokedAt = new Date().toISOString();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const currentResource = await controlStore.get<
            CredentialGrantResource['spec'],
            CredentialGrantResource['status']
          >(reference);
          const current = currentResource && isCredentialGrant(currentResource)
            ? currentResource
            : null;
          if (!current || current.metadata.uid !== observedGrant.metadata.uid) return;
          if (current.status?.phase === 'Revoked') return;
          if (current.status?.phase !== 'Issued' && current.status?.phase !== 'Renewed') return;
          try {
            await controlStore.updateStatus(
              lifecycleActor,
              reference,
              {
                ...current.status,
                phase: 'Revoked',
                revokedAt,
              },
              { resourceVersion: current.metadata.resourceVersion },
            );
            return;
          } catch (error) {
            if (
              error instanceof OrchestrationError &&
              error.code === 'CONFLICT' &&
              attempt < 2
            ) continue;
            throw error;
          }
        }
      };
      const runCleanupDone = (async () => {
        while (!cleanupStopped) {
          const event = await runCleanupIterator.next();
          if (event.done || !event.value) break;
          if (event.value.type !== 'ADDED' && event.value.type !== 'MODIFIED') continue;
          if (!isAgentRun(event.value.resource)) continue;
          const run = event.value.resource;
          if (
            run.status?.phase !== 'Completed' &&
            run.status?.phase !== 'Failed' &&
            run.status?.phase !== 'Cancelled'
          ) continue;
          const grants = await controlStore.list<
            CredentialGrantResource['spec'],
            CredentialGrantResource['status']
          >({ kind: CREDENTIAL_GRANT_KIND, namespace: run.metadata.namespace });
          for (const grant of grants.items.filter(isCredentialGrant)) {
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
            await markTerminalGrantRevoked(grant).catch((error: unknown) => {
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

    // Workload/network/storage controllers are composed by a dedicated runtime.
    if (controlStore && options.workloadExecution?.enabled !== false) {
      if (!managedPolicyDriver || !createManagedPolicyRequest) {
        throw new Error('createNodeRuntime: workload execution requires the host policy route');
      }
      const workloadRuntime = await createWorkloadRuntime({
        controlStore,
        nodeId: syncNodeId,
        trustClass: workerTrustClass,
        runtime,
        context,
        toolRegistry,
        // Pass the effective advertisement (including the custom provider
        // fallback) so local scheduling can see every ModelClass advertised
        // by the registrar. Passing only config-backed routes leaves a custom
        // llmProvider endpoint healthy but unschedulable.
        advertisedModels,
        llmProvider,
        managedPolicyDriver,
        createManagedPolicyRequest,
        logger,
        ...(options.dataDir ? { dataDir: options.dataDir } : {}),
        ...(options.workloadExecution ? { workloadExecution: options.workloadExecution } : {}),
        ...(options.modelEndpointRegistration
          ? { modelEndpointRegistration: options.modelEndpointRegistration }
          : {}),
        ...(options.modelGateway?.loopBudget !== undefined
          ? { modelGatewayConfig: { loopBudget: options.modelGateway.loopBudget } }
          : {}),
        ...(options.credentialBroker
          ? {
            credentialBroker: {
              brokerClass: options.credentialBroker.brokerClass,
              audiences: options.credentialBroker.audiences,
              ...(options.credentialBroker.targets ? { targets: options.credentialBroker.targets } : {}),
            },
          }
          : {}),
        ...(modelGateway ? { modelGateway } : {}),
        ...(scriptArtifactStore ? { scriptArtifactStore } : {}),
      });
      bindingControllerRunner = workloadRuntime.bindingControllerRunner;
      modelEndpointBindingControllerRunner = workloadRuntime.modelEndpointBindingControllerRunner;
      networkAttachmentControllers = workloadRuntime.networkAttachmentControllers;
      volumeControllers = workloadRuntime.volumeControllers;
      managedStorageDriver = workloadRuntime.managedStorageDriver;
      workloadExecutionController = workloadRuntime.workloadExecutionController;
      managedLoopRuntimeDriver = workloadRuntime.managedLoopRuntimeDriver;
    }
  } catch (error) {
    await rollbackNodeRuntimeStartup({
      runtime,
      workerGatewayStop,
      toolOperationControllers,
      credentialGrantControllers,
      workloadExecutionController,
      bindingControllerRunner,
      modelEndpointBindingControllerRunner,
      networkAttachmentControllers,
      volumeControllers,
      externalOrchestrationController,
      modelEndpointRegistrar,
      pluginLoader,
      disposeNodeEnvironmentTools,
      loopRegistry,
      hookRegistry,
      schemaRegistry,
      agentProfileRegistry,
      promptPlugins,
      ownedPromptPluginEntries,
      ownedProviderRegistrations,
      ownedControlStore,
      ownedStorage,
    });
    throw error;
  }

  const lifecycle = createRuntimeLifecycle({
    // Runtime disposal is the ingress fence: it rejects new SDK/RPC work,
    // cancels active runs, and waits for their drains before capabilities
    // and stores are unloaded.
    disposeRuntime: () => runtime.dispose(),
    unloadPlugins: () => pluginLoader?.unloadAllPlugins(),
    stopControllers: [
      () => workerGatewayStop?.(),
      () => toolOperationControllers?.stop(),
      () => credentialGrantControllers?.stop(),
      () => workloadExecutionController?.stop(),
      () => bindingControllerRunner?.stop(),
      () => modelEndpointBindingControllerRunner?.stop(),
      () => networkAttachmentControllers?.stop(),
      () => volumeControllers?.stop(),
      () => externalOrchestrationController?.stop(),
      () => modelEndpointRegistrar?.stop(),
    ],
    disposeComponents: [
      () => {
        disposeNodeEnvironmentTools();
      },
      () => {
        loopRegistry.reset();
      },
      () => {
        hookRegistry.clearHooks();
      },
      () => {
        schemaRegistry.clear();
      },
      () => {
        agentProfileRegistry.reset();
      },
      () => {
        for (const [key, value] of ownedPromptPluginEntries) {
          if (promptPlugins.get(key) === value) promptPlugins.delete(key);
        }
      },
      () => {
        for (const registration of ownedProviderRegistrations) registration.dispose();
      },
    ],
    closeControlStore: () => ownedControlStore?.close(),
    closeStorage: () => ownedStorage?.close(),
  });
  const stop = (): Promise<void> => lifecycle.stop();
  return {
    stop,
    runtime,
    storage,
    controlStore,
    providerRegistry,
    toolRegistry,
    loadedPlugins,
    context,
    wikiManager,
    agentDefinitions,
    fileBaseDirResolved: fileBaseResolved,
    refreshWikiAgentDefinitions,
    workerTrustClass,
    modelEndpointRegistrar,
    modelGateway,
    managedLoopRuntimeDriver,
    managedCredentialDriver,
    managedStorageDriver,
    managedToolDriver,
    managedArtifactDriver,
    managedIdentityDriver,
    managedPolicyDriver,
    managedAuditTelemetryDriver,
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
