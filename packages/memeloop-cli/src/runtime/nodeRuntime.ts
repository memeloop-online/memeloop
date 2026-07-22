import fs from 'node:fs';
import path from 'node:path';

import {
  AGENT_WORKLOAD_KIND,
  type AgentDefinition,
  type AgentFrameworkContext,
  type BuiltinToolContext,
  type ControllerRunnerHandle,
  type ControlStore,
  createAgentToolLoopRunner,
  createBindingController,
  createCapacityScheduler,
  createControllerRunner,
  createControlStoreLoopCheckpointStore,
  createControlStoreOrchestrationClient,
  createGatewayMediatedLLMProvider,
  createInProcessLoopRuntimeDriver,
  createMemeLoopRuntime,
  createModelEndpointRegistrar,
  createModelProviderDriverFromLLMProvider,
  createRuntimeClassRoutingDriver,
  createScriptLoadGate,
  createWorkloadExecutionController,
  defaultRequestedInterfacesForTrustClass,
  getAgentProfileRegistry,
  getBuiltinLoopProfiles,
  type IAgentStorage,
  type ILLMProvider,
  type INetworkService,
  type IToolRegistry,
  type MemeLoopRuntime,
  MODEL_CLASS_API_VERSION,
  MODEL_CLASS_KIND,
  type ModelAccessHandleBudget,
  type ModelClassSpec,
  type ModelEndpointRegistrarHandle,
  OrchestrationError,
  ProviderRegistry,
  registerBuiltinTools,
  type ScriptTrustClass,
  type WorkloadExecutionControllerHandle,
} from 'memeloop';
import { createProviderFromEntry, resolveProviderModelId } from 'memeloop/llm-providers';
import type { NodeConfig } from '../config';
import { normalizeAgentDefinition } from '../config';
import { type IWikiManager, TiddlyWikiWikiManager } from '../knowledge/wikiManager';
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
     * Set false to run everything in-process (e.g. embedders without a
     * spawnable Node binary).
     */
    processIsolation?: boolean;
    /** Model gateway endpoint exposed to isolated workers as MEMELOOP_MODEL_GATEWAY. */
    modelGatewayEndpoint?: string;
  };
}

export interface NodeRuntimeResult {
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
  /** Binding (scheduler) controller runner; stop on shutdown. */
  bindingControllerRunner?: ControllerRunnerHandle;
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

  const context: AgentFrameworkContext = {
    storage,
    llmProvider,
    tools: toolRegistry,
    syncAdapters: [],
    network,
    controlStore,
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
      orchestration: controlStore
        ? createControlStoreOrchestrationClient(controlStore, {
          id: `controller/script-deployment-${syncNodeId}`,
          kind: 'controller',
        })
        : undefined,
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

  registerBuiltinTools(toolRegistry, {
    ...context,
    localNodeId: embedBuiltin.localNodeId ?? syncNodeId,
    runLocalAgent,
    getPeers: embedBuiltin.getPeers,
    sendRpcToNode: embedBuiltin.sendRpcToNode,
    mcpCallRemote: embedBuiltin.mcpCallRemote,
    remoteAgentStreamTimeoutMs: streamTimeout,
    notifyAskQuestion: embedBuiltin.notifyAskQuestion,
  });

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
  const advertisedModels = configuredModels.length > 0
    ? configuredModels
    : [{ provider: llmProvider.name, model: llmProvider.model }];
  let modelEndpointRegistrar: ModelEndpointRegistrarHandle | undefined;
  if (controlStore && options.modelEndpointRegistration?.enabled !== false) {
    const driver = createModelProviderDriverFromLLMProvider(llmProvider, { models: advertisedModels });
    modelEndpointRegistrar = createModelEndpointRegistrar(controlStore, driver, {
      actor: { id: `controller/model-registrar-${syncNodeId}`, kind: 'controller' },
      advertisement: { nodeId: syncNodeId, trust: workerTrustClass },
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
    const rawModelName = llmProvider.model ?? advertisedModels[0]?.model;
    const modelClassName = typeof rawModelName === 'string' ? rawModelName : 'default';
    context.llmProvider = createGatewayMediatedLLMProvider({
      gateway: modelGateway.gateway,
      broker: modelGateway.broker,
      modelClassRef: { apiVersion: MODEL_CLASS_API_VERSION, kind: MODEL_CLASS_KIND, name: modelClassName },
      name: llmProvider.name,
      model: llmProvider.model,
      ...(options.modelGateway?.loopBudget !== undefined ? { budget: options.modelGateway.loopBudget } : {}),
    });
  }

  // Plan 24.14 / Phase 4.2: schedule and execute AgentWorkloads. The
  // binding controller assigns this node; the execution controller runs
  // bound workloads through the LoopRuntimeDriver. Script workloads whose
  // RuntimeClass declares process isolation run in a sanitized child process
  // by default (24.18 isolation made real; 24.35 env sanitization point).
  let bindingControllerRunner: ControllerRunnerHandle | undefined;
  let workloadExecutionController: WorkloadExecutionControllerHandle | undefined;
  if (controlStore && options.workloadExecution?.enabled !== false) {
    const bindingActor = { id: `controller/binding-${syncNodeId}`, kind: 'controller' as const };
    bindingControllerRunner = await createControllerRunner(
      controlStore,
      createBindingController(controlStore, {
        actor: bindingActor,
        scheduler: createCapacityScheduler(),
        listNodes: async () => [{ name: syncNodeId, trustClass: workerTrustClass, faultDomain: 'local' }],
      }),
      {
        actor: bindingActor,
        leaseName: `binding-${syncNodeId}`,
        watchKind: AGENT_WORKLOAD_KIND,
        leaseTtlMs: 5000,
      },
    );
    const inProcessDriver = createInProcessLoopRuntimeDriver(context);
    const loopRuntimeDriver = options.workloadExecution?.processIsolation === false
      ? inProcessDriver
      : createRuntimeClassRoutingDriver({
        inProcessDriver,
        processDriver: createProcessLoopRuntimeDriver({
          ...(options.workloadExecution?.modelGatewayEndpoint !== undefined
            ? { gatewayEndpoint: options.workloadExecution.modelGatewayEndpoint }
            : {}),
          logger,
        }),
      });
    workloadExecutionController = createWorkloadExecutionController(controlStore, loopRuntimeDriver, {
      actor: { id: `controller/workload-execution-${syncNodeId}`, kind: 'controller' },
      nodeId: syncNodeId,
      resolveScriptSource: async (reference) => {
        if (!scriptArtifactStore) return undefined;
        const digestHex = reference.replace(/^sha256:/, '');
        if (!/^[a-f0-9]{64}$/.test(digestHex)) return undefined;
        return scriptArtifactStore.readArtifactContent(`script-${digestHex}`);
      },
      onError: (error) => logger.warn?.('workload execution controller error', error),
    });
  }

  return {
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
    bindingControllerRunner,
    workloadExecutionController,
    scriptArtifactStore,
  };
}
