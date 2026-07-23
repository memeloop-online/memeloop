import fs from 'node:fs';
import path from 'node:path';

import {
  AGENT_RUN_API_VERSION,
  AGENT_RUN_KIND,
  AGENT_WORKLOAD_KIND,
  type AgentDefinition,
  type AgentFrameworkContext,
  type AgentRunResource,
  type AgentWorkloadResource,
  BUILTIN_RUNTIME_CLASSES,
  type BuiltinToolContext,
  type ControllerRunnerHandle,
  type ControlStore,
  createAgentToolLoopRunner,
  createBindingController,
  createCapacityScheduler,
  createControllerRunner,
  createControlStoreLoopCheckpointStore,
  createControlStoreOrchestrationClient,
  createExternalOrchestrationController,
  createGatewayMediatedLLMProvider,
  createInProcessLoopRuntimeDriver,
  createInProcessToolExecutionDriver,
  createMemeLoopRuntime,
  createModelEndpointBindingController,
  createModelEndpointRegistrar,
  createModelProviderDriverFromLLMProvider,
  createRuntimeClassRoutingDriver,
  createScriptLoadGate,
  createToolExecutorManifest,
  createToolOperationBindingController,
  createToolOperationExecutionController,
  createWorkloadExecutionController,
  defaultAdmissionPolicyForTrustClass,
  defaultRequestedInterfacesForTrustClass,
  type ExternalOrchestrationControllerHandle,
  getAgentProfileRegistry,
  getBuiltinLoopProfiles,
  type IAgentStorage,
  type ILLMProvider,
  type INetworkService,
  type IToolRegistry,
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
  OrchestrationError,
  ProviderRegistry,
  registerBuiltinTools,
  type SchedulerNode,
  type ScriptTrustClass,
  TOOL_EXECUTOR_API_VERSION,
  TOOL_EXECUTOR_KIND,
  TOOL_OPERATION_KIND,
  type ToolAdmissionPolicy,
  type ToolExecutorResource,
  type ToolOperationResource,
  type WorkloadExecutionControllerHandle,
} from 'memeloop';
import { createProviderFromEntry, resolveProviderModelId } from 'memeloop/llm-providers';
import type { NodeConfig } from '../config';
import { normalizeAgentDefinition } from '../config';
import { type IWikiManager, TiddlyWikiWikiManager } from '../knowledge/wikiManager';
import { type DiscoveredExternalDriver, discoverExternalDrivers, registerExternalDriverManifests } from '../orchestration/externalDriverDiscovery.js';
import { createNodeModelGateway, type NodeModelGateway } from '../orchestration/nodeModelGateway.js';
import { createProcessLoopRuntimeDriver } from '../orchestration/processLoopRuntimeDriver.js';
import { createFileScriptArtifactStore, type FileScriptArtifactStore } from '../orchestration/scriptArtifactStore.js';
import { SQLiteControlStore } from '../orchestration/sqliteControlStore.js';
import { FileCheckpointStore } from '../storage/fileCheckpointStore';
import { SQLiteAgentStorage } from '../storage/sqliteStorage';
import type { ITerminalSessionManager } from '../terminal';
import { registerNodeEnvironmentTools } from '../tools/registerNodeEnvironmentTools';
import { ToolRegistry } from './toolRegistry';

async function registerProvidersFromConfig(
  providerRegistry: ProviderRegistry,
  providers: import('../config').ProviderEntry[],
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
  };
}

export interface NodeToolOperationControllers {
  binding: ControllerRunnerHandle;
  execution: ControllerRunnerHandle;
  stop(): Promise<void>;
}

export interface NodeRuntimeResult {
  /** Stop every controller/registrar started by this runtime; does not close injected stores. */
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
  /** Workload execution controller; stop on shutdown (cancels active loops). */
  workloadExecutionController?: WorkloadExecutionControllerHandle;
  /**
   * Production script artifact store (plan 24.15): content-addressed,
   * hash-verified persistence for generated-script ArtifactRecords.
   * Present when `dataDir` is provided. Pass to `deployGeneratedScript`
   * as `{ artifactStore }`.
   */
  scriptArtifactStore?: FileScriptArtifactStore;
}

const noopNetwork: INetworkService = {
  async start() {},
  async stop() {},
};

const defaultLogger: AgentFrameworkContext['logger'] = {
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
  const config = options.config ?? {};

  let storage: IAgentStorage;
  if (options.storage) {
    storage = options.storage;
  } else {
    if (!options.dataDir) {
      throw new Error(
        'createNodeRuntime: provide `dataDir` for SQLite storage, or inject `storage`',
      );
    }
    const databasePath = path.join(options.dataDir, 'memeloop.db');
    storage = new SQLiteAgentStorage({ filename: databasePath });
  }

  const controlStore = options.controlStore ?? (options.dataDir
    ? new SQLiteControlStore({
      filename: path.join(options.dataDir, 'control.db'),
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
    : undefined);

  // Script deployment security chain (plan 24.15): generated scripts are
  // admitted by the load gate under this node's trust class, and admitted
  // artifacts persist through the content-addressed file store.
  const workerTrustClass: ScriptTrustClass = options.trustClass ?? 'trusted';
  const scriptArtifactStore = options.dataDir
    ? createFileScriptArtifactStore({ dataDir: options.dataDir })
    : undefined;
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
    definitionById.set(d.id, d);
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
      onError: (error) => logger.warn?.('external orchestration controller error', error),
    });
  }

  // Phase 4.5 / 7.3: ToolOperations are independently bound to a declared
  // ToolExecutor and claimed under a fencing epoch before any local effect.
  // This is separate from AgentWorkload placement and external drivers.
  let toolOperationControllers: NodeToolOperationControllers | undefined;
  if (controlStore && options.toolExecution?.enabled !== false) {
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
        schemaDigest: `builtin:${toolId}:v1`,
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
    let executor = await controlStore.get(executorReference);
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
        executor = await controlStore.get(executorReference);
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
      driver: createInProcessToolExecutionDriver(toolRegistry, {
        context: builtinToolContext,
        admission: options.toolExecution?.admission ??
          defaultAdmissionPolicyForTrustClass(workerTrustClass),
        ...(options.toolExecution?.maxOutputLength !== undefined
          ? { maxOutputLength: options.toolExecution.maxOutputLength }
          : {}),
      }),
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

  // Plan 24.14 / Phase 4.2: schedule and execute AgentWorkloads. The
  // binding controller assigns this node; the execution controller runs
  // bound workloads through the LoopRuntimeDriver. Script workloads whose
  // RuntimeClass declares process isolation run in a sanitized child process
  // by default (24.18 isolation made real; 24.35 env sanitization point).
  let bindingControllerRunner: ControllerRunnerHandle | undefined;
  let modelEndpointBindingControllerRunner: ControllerRunnerHandle | undefined;
  let workloadExecutionController: WorkloadExecutionControllerHandle | undefined;
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

    const inProcessDriver = createInProcessLoopRuntimeDriver(context, {
      ...(options.workloadExecution?.resolveModelProvider
        ? { resolveModelProvider: options.workloadExecution.resolveModelProvider }
        : {}),
    });
    const processDriver = options.workloadExecution?.processIsolation === false
      ? undefined
      : createProcessLoopRuntimeDriver({
        ...(options.workloadExecution?.modelGatewayEndpoint !== undefined
          ? { gatewayEndpoint: options.workloadExecution.modelGatewayEndpoint }
          : {}),
        ...(options.workloadExecution?.resolveModelGatewayEndpoint
          ? {
            gatewayEndpointForModelEndpoint: options.workloadExecution.resolveModelGatewayEndpoint,
          }
          : {}),
        logger,
      });
    const loopRuntimeDriver = createRuntimeClassRoutingDriver({
      inProcessDriver,
      ...(processDriver ? { processDriver } : {}),
    });
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
      availableRuntimeClasses: options.workloadExecution?.processIsolation === false
        ? []
        : Object.keys(BUILTIN_RUNTIME_CLASSES),
      availableToolClasses: toolRegistry.listTools(),
      availableModelClasses: advertisedModelClasses,
      ...options.workloadExecution?.localNode,
      name: syncNodeId,
      trustClass: workerTrustClass,
    };
    const bindingActor = { id: `controller/binding-${syncNodeId}`, kind: 'controller' as const };
    bindingControllerRunner = await createControllerRunner(
      controlStore,
      createBindingController(controlStore, {
        actor: bindingActor,
        scheduler: createCapacityScheduler(),
        listNodes: options.workloadExecution?.listSchedulerNodes ?? (async () => [localNode]),
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
      onError: (error) => logger.warn?.('workload execution controller error', error),
    });
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await Promise.all([
      toolOperationControllers?.stop(),
      workloadExecutionController?.stop(),
      bindingControllerRunner?.stop(),
      modelEndpointBindingControllerRunner?.stop(),
      externalOrchestrationController?.stop(),
      modelEndpointRegistrar?.stop(),
    ]);
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
    externalDrivers,
    externalOrchestrationController,
    toolOperationControllers,
    bindingControllerRunner,
    modelEndpointBindingControllerRunner,
    workloadExecutionController,
    scriptArtifactStore,
  };
}
