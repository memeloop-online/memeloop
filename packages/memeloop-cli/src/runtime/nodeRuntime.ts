import fs from 'node:fs';
import path from 'node:path';

import {
  type AgentDefinition,
  type AgentFrameworkContext,
  type BuiltinToolContext,
  createMemeLoopRuntime,
  createTaskAgent,
  getAgentProfileRegistry,
  getBuiltinLoopProfiles,
  type IAgentStorage,
  type ILLMProvider,
  type INetworkService,
  type IToolRegistry,
  type MemeLoopRuntime,
  ProviderRegistry,
  registerBuiltinTools,
} from 'memeloop';

import type { NodeConfig } from '../config';
import { normalizeAgentDefinition } from '../config';
import { type IWikiManager, TiddlyWikiWikiManager } from '../knowledge/wikiManager';
import { FileCheckpointStore } from '../storage/fileCheckpointStore';
import { SQLiteAgentStorage } from '../storage/sqliteStorage';
import type { ITerminalSessionManager } from '../terminal';
import { registerNodeEnvironmentTools } from '../tools/registerNodeEnvironmentTools';
import { createAiSdkProvider, resolveProviderModelId } from './aiSdkProvider';
import { createFetchLLMProvider } from './fetchProvider';
import { ToolRegistry } from './toolRegistry';

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

type CoreTaskAgentOptions = NonNullable<AgentFrameworkContext['taskAgent']>;
type NodeTaskAgentSessionCheckpoint = NonNullable<CoreTaskAgentOptions['sessionCheckpoint']> & {
  directory?: string;
};

export type NodeTaskAgentOptions = Omit<CoreTaskAgentOptions, 'sessionCheckpoint'> & {
  sessionCheckpoint?: NodeTaskAgentSessionCheckpoint;
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
  taskAgent?: Partial<NodeTaskAgentOptions>;
  /** Share cancellation set with the host (e.g. worker `cancelAgent`). */
  conversationCancellation?: Set<string>;
}

export interface NodeRuntimeResult {
  runtime: MemeLoopRuntime;
  storage: IAgentStorage;
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
export function createNodeRuntime(options: NodeRuntimeOptions): NodeRuntimeResult {
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
    for (const entry of config.providers ?? []) {
      const model = createAiSdkProvider(entry);
      const provider = createFetchLLMProvider(entry);
      provider.model = model;
      providerRegistry.register(provider);
    }
    const defaultModelId = config.providers?.[0]
      ? resolveProviderModelId(config.providers[0])
      : 'default';
    const { provider } = providerRegistry.resolve(defaultModelId);
    llmProvider = { name: 'registry', model: provider.model };
  }

  const toolRegistry: IToolRegistry = options.toolRegistry ?? new ToolRegistry(config.tools);

  if (options.configureTools) {
    options.configureTools(toolRegistry);
  }

  const conversationCancellation = options.conversationCancellation ?? new Set<string>();
  const network = options.network ?? noopNetwork;
  const logger = options.logger ?? defaultLogger;
  const terminalManager = options.terminalManager;

  const { sessionCheckpoint, ...taskAgentOverrides } = options.taskAgent ?? {};
  const checkpointDirectory = sessionCheckpoint?.directory ??
    (sessionCheckpoint?.enabled && options.dataDir
      ? path.join(options.dataDir, 'sessions')
      : undefined);
  const checkpointStore = sessionCheckpoint?.store ??
    (checkpointDirectory ? new FileCheckpointStore({ directory: checkpointDirectory }) : undefined);

  const taskAgentConfig: CoreTaskAgentOptions = {
    ...taskAgentOverrides,
    maxIterations: options.taskAgent?.maxIterations ?? 32,
    isCancelled: options.taskAgent?.isCancelled ?? ((cid: string) => conversationCancellation.has(cid)),
    waitForTerminalSession: options.taskAgent?.waitForTerminalSession ??
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
    taskAgentConfig.sessionCheckpoint = {
      enabled: sessionCheckpoint.enabled,
      store: checkpointStore,
    };
  }

  // Seed per-agent tool permissions from registered task delegation profiles.
  const agentProfileRegistry = getAgentProfileRegistry();
  const perAgent: NonNullable<
    NonNullable<AgentFrameworkContext['taskAgent']>['toolPermissions']
  >['perAgent'] = {};
  for (const profile of agentProfileRegistry.listAgentProfiles()) {
    perAgent[profile.id] = {
      default: profile.permissions.default,
      rules: profile.permissions.rules,
    };
  }
  taskAgentConfig.toolPermissions = {
    default: 'allow',
    rules: [],
    perAgent,
  };

  const context: AgentFrameworkContext = {
    storage,
    llmProvider,
    tools: toolRegistry,
    syncAdapters: [],
    network,
    logger,
    loopScriptPolicy: options.loopScriptPolicy,
    taskAgent: taskAgentConfig,
    conversationCancellation,
    resolveAgentDefinition: async (definitionId) => {
      const hit = definitionById.get(definitionId);
      if (hit) return hit;
      return storage.getAgentDefinition(definitionId);
    },
  };

  const runLocalAgent = createTaskAgent(context);

  const syncNodeId = (options.localNodeId ?? 'memeloop-local').trim() || 'memeloop-local';

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

  return {
    runtime,
    storage,
    providerRegistry,
    toolRegistry,
    context,
    wikiManager,
    agentDefinitions,
    fileBaseDirResolved: fileBaseResolved,
    syncEngine: undefined,
    refreshWikiAgentDefinitions,
  };
}
