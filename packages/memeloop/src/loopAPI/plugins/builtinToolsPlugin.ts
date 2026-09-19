/**
 * Builtin tool plugins — registers core tools as LoopPlugin entries.
 *
 * Each tool is a separate LoopPlugin that can be overridden by user/host plugins
 * with the same id. The plugin.install callback calls the tool registry to
 * register the tool implementation.
 *
 * These are registered in the loop registry at startup and loaded by
 * `registerBuiltinTools` via plugin discovery.
 */

import type { ToolOperationEffect } from '../../orchestration/resources.js';
import type { AgentFrameworkContext, IToolRegistry, ToolInvocationContext } from '../../types.js';
import type { LoopRegistry } from '../registry.js';
import type { LoopPlugin } from '../types.js';

// ─── Import tool implementations ─────────────────────────────────────

import { ASK_QUESTION_TOOL_ID, askQuestionConfigSchema, askQuestionImpl } from '../../tools/builtins/askQuestion.js';
import { ASK_USER_QUESTION_TOOL_ID, askUserQuestionConfigSchema, askUserQuestionImpl } from '../../tools/builtins/askUserQuestion.js';
import { getMcpClientToolId, mcpClientConfigSchema, mcpClientImpl } from '../../tools/builtins/mcpClient.js';
import { getMcpForwardToolId, mcpForwardConfigSchema, mcpForwardImpl } from '../../tools/builtins/mcpForward.js';
import { ORCHESTRATION_TOOL_ID, orchestrationConfigSchema, orchestrationImpl } from '../../tools/builtins/orchestration.js';
import { getRemoteAgentToolId, remoteAgentConfigSchema, remoteAgentImpl } from '../../tools/builtins/remoteAgent.js';
import { getSpawnAgentToolId, spawnAgentConfigSchema, spawnAgentImpl } from '../../tools/builtins/spawnAgent.js';
import { getTaskToolId, taskToolConfigSchema, taskToolImpl } from '../../tools/builtins/task.js';
import { TODO_WRITE_TOOL_ID, todoWriteConfigSchema, todoWriteImpl } from '../../tools/builtins/todoWrite.js';
import type { BuiltinToolContext, BuiltinToolImpl } from '../../tools/builtins/types.js';

// ─── Plugin id constants ───────────────────────────────────────────

export const PLUGIN_MCP_CLIENT = 'builtin:mcp-client';
export const PLUGIN_MCP_FORWARD = 'builtin:mcp-forward';
export const PLUGIN_ORCHESTRATION = 'builtin:orchestration';
export const PLUGIN_SPAWN_AGENT = 'builtin:spawn-agent';
export const PLUGIN_REMOTE_AGENT = 'builtin:remote-agent';
export const PLUGIN_ASK_QUESTION = 'builtin:ask-question';
export const PLUGIN_TODO_WRITE = 'builtin:todo-write';
export const PLUGIN_ASK_USER_QUESTION = 'builtin:ask-user-question';
export const PLUGIN_TASK = 'builtin:task';

export const BUILTIN_TOOL_PLUGIN_IDS = [
  PLUGIN_MCP_CLIENT,
  PLUGIN_MCP_FORWARD,
  PLUGIN_ORCHESTRATION,
  PLUGIN_SPAWN_AGENT,
  PLUGIN_REMOTE_AGENT,
  PLUGIN_ASK_QUESTION,
  PLUGIN_TODO_WRITE,
  PLUGIN_ASK_USER_QUESTION,
  PLUGIN_TASK,
] as const;

interface BuiltinToolPluginOptions {
  id: string;
  toolId: string;
  schema: unknown;
  metadata: { displayName: string; description: string };
  implementation: BuiltinToolImpl;
  effect?: ToolOperationEffect;
}

type RegisterOwnedTool = (
  id: string,
  impl: unknown,
  schema?: unknown,
  effect?: ToolOperationEffect,
) => () => boolean;

interface BuiltinToolRegistry extends Pick<IToolRegistry, 'registerTool' | 'getTool' | 'listTools'> {
  unregisterTool?: IToolRegistry['unregisterTool'];
  registerOwnedTool?: RegisterOwnedTool;
}

interface BuiltinToolPluginContext extends AgentFrameworkContext {
  toolRegistry: BuiltinToolRegistry;
}

const MISSING_PLUGIN_PROPERTY = Symbol('missing-plugin-property');

function readPluginProperty(value: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return MISSING_PLUGIN_PROPERTY;
  }
}

function isObjectRecord(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasMethod(value: unknown, key: PropertyKey): boolean {
  return isObjectRecord(value) && typeof readPluginProperty(value, key) === 'function';
}

function isBuiltinToolRegistry(value: unknown): value is BuiltinToolRegistry {
  if (!isObjectRecord(value)) return false;
  if (!hasMethod(value, 'registerTool') || !hasMethod(value, 'getTool') || !hasMethod(value, 'listTools')) {
    return false;
  }
  for (const key of ['unregisterTool', 'registerOwnedTool'] as const) {
    const candidate = readPluginProperty(value, key);
    if (candidate === MISSING_PLUGIN_PROPERTY || (candidate !== undefined && typeof candidate !== 'function')) {
      return false;
    }
  }
  return true;
}

function isBuiltinToolPluginContext(value: unknown): value is BuiltinToolPluginContext {
  try {
    if (!isObjectRecord(value)) return false;
    const storage = readPluginProperty(value, 'storage');
    const llmProvider = readPluginProperty(value, 'llmProvider');
    const tools = readPluginProperty(value, 'tools');
    const syncAdapters = readPluginProperty(value, 'syncAdapters');
    const network = readPluginProperty(value, 'network');
    const toolRegistry = readPluginProperty(value, 'toolRegistry');
    if (
      !isObjectRecord(storage) ||
      !isObjectRecord(llmProvider) ||
      typeof readPluginProperty(llmProvider, 'name') !== 'string' ||
      !hasMethod(llmProvider, 'chat') ||
      !isBuiltinToolRegistry(tools) ||
      !Array.isArray(syncAdapters) ||
      !isObjectRecord(network) ||
      !hasMethod(network, 'start') ||
      !hasMethod(network, 'stop') ||
      !isBuiltinToolRegistry(toolRegistry)
    ) return false;
    for (const adapter of syncAdapters) {
      if (!isObjectRecord(adapter) || !hasMethod(adapter, 'start') || !hasMethod(adapter, 'stop')) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function getToolRegistry(context: { [key: string]: unknown }): BuiltinToolRegistry | undefined {
  const candidate = readPluginProperty(context, 'toolRegistry');
  return isBuiltinToolRegistry(candidate) ? candidate : undefined;
}

function createBuiltinToolPlugin(options: BuiltinToolPluginOptions): LoopPlugin {
  return {
    id: options.id,
    targetLoopId: '*',
    activationScope: 'runtime',
    providedToolIds: [options.toolId],
    install: (context) => {
      if (!isBuiltinToolPluginContext(context)) return undefined;
      const registry = getToolRegistry(context);
      if (!registry) return undefined;

      const builtinContext: BuiltinToolContext = context;
      const implementation = (
        arguments_: Record<string, unknown>,
        invocation?: ToolInvocationContext,
      ) =>
        options.implementation(arguments_, {
          ...builtinContext,
          operationSignal: invocation?.signal,
          activeToolConversationId: invocation?.conversationId ??
            builtinContext.activeToolConversationId,
        });
      const unregisterTool = registry.registerOwnedTool
        ? registry.registerOwnedTool(
          options.toolId,
          implementation,
          options.schema,
          options.effect,
        )
        : (() => {
          registry.registerTool(options.toolId, implementation, options.schema, options.effect);
          return () =>
            registry.getTool(options.toolId) === implementation &&
            registry.unregisterTool?.(options.toolId) === true;
        })();
      let unregisterSchema: (() => boolean) | undefined;
      try {
        if (builtinContext.toolSchemas?.getToolParameterSchema(options.toolId) === undefined) {
          unregisterSchema = builtinContext.toolSchemas?.registerOwnedToolParameterSchema(
            options.toolId,
            options.schema,
            options.metadata,
          );
        }
      } catch (error) {
        unregisterTool();
        throw error;
      }
      return () => {
        unregisterSchema?.();
        unregisterTool();
      };
    },
  };
}

const builtinToolPlugins: LoopPlugin[] = [
  createBuiltinToolPlugin({
    id: PLUGIN_MCP_CLIENT,
    toolId: getMcpClientToolId(),
    schema: mcpClientConfigSchema,
    metadata: {
      displayName: 'MCP Client',
      description: 'Call a tool on a remote MCP server (transparent proxy). Requires nodeId, serverName, toolName, and optional args.',
    },
    implementation: mcpClientImpl,
  }),
  createBuiltinToolPlugin({
    id: PLUGIN_MCP_FORWARD,
    toolId: getMcpForwardToolId(),
    schema: mcpForwardConfigSchema,
    metadata: {
      displayName: 'MCP Forward',
      description: "Discover MCP servers and tools on connected nodes. Use action='list' for nodes with servers, action='listTools' for all available tools.",
    },
    implementation: mcpForwardImpl,
  }),
  createBuiltinToolPlugin({
    id: PLUGIN_ORCHESTRATION,
    toolId: ORCHESTRATION_TOOL_ID,
    schema: orchestrationConfigSchema,
    metadata: {
      displayName: 'Orchestration',
      description: 'Discover and manage declarative resources through the policy-scoped orchestration manager.',
    },
    implementation: orchestrationImpl,
  }),
  createBuiltinToolPlugin({
    id: PLUGIN_SPAWN_AGENT,
    toolId: getSpawnAgentToolId(),
    schema: spawnAgentConfigSchema,
    metadata: {
      displayName: 'Spawn Agent',
      description: 'Run a local agent-agent-loop with the given definition and message. Returns summary.',
    },
    implementation: spawnAgentImpl,
  }),
  createBuiltinToolPlugin({
    id: PLUGIN_REMOTE_AGENT,
    toolId: getRemoteAgentToolId(),
    schema: remoteAgentConfigSchema,
    metadata: {
      displayName: 'Remote Agent',
      description: 'Create and run a agent-agent-loop on a remote node. Requires nodeId, definitionId, message. List nodes with no args.',
    },
    implementation: remoteAgentImpl,
  }),
  createBuiltinToolPlugin({
    id: PLUGIN_ASK_QUESTION,
    toolId: ASK_QUESTION_TOOL_ID,
    schema: askQuestionConfigSchema,
    metadata: {
      displayName: 'Ask Question',
      description: 'Block until the user answers (via memeloop.agent.resolveQuestion RPC). Args: question, conversationId, optional timeoutMs.',
    },
    implementation: askQuestionImpl,
  }),
  createBuiltinToolPlugin({
    id: PLUGIN_TODO_WRITE,
    toolId: TODO_WRITE_TOOL_ID,
    effect: 'update',
    schema: todoWriteConfigSchema,
    metadata: {
      displayName: 'Todo Write',
      description: 'Manage structured todo lists: create, update, complete, list, remove. Todos scoped per conversation.',
    },
    implementation: todoWriteImpl,
  }),
  createBuiltinToolPlugin({
    id: PLUGIN_ASK_USER_QUESTION,
    toolId: ASK_USER_QUESTION_TOOL_ID,
    schema: askUserQuestionConfigSchema,
    metadata: {
      displayName: 'Ask User Question',
      description: 'Pause agent and ask user a question. Supports text, single-select, and multi-select input types. Blocks until answered.',
    },
    implementation: askUserQuestionImpl,
  }),
  createBuiltinToolPlugin({
    id: PLUGIN_TASK,
    toolId: getTaskToolId(),
    schema: taskToolConfigSchema,
    metadata: {
      displayName: 'Task Delegation',
      description: 'Delegate a task to a specialized agent-agent-loop (build, plan, explore, oracle, librarian). Supports sync (default) and background modes.',
    },
    implementation: taskToolImpl,
  }),
];

export function getBuiltinToolPlugins(): LoopPlugin[] {
  return builtinToolPlugins;
}

/** Register all builtin tool plugins with the loop registry. */
export function registerBuiltinToolPlugins(loopRegistry: LoopRegistry): void {
  for (const plugin of builtinToolPlugins) {
    if (loopRegistry.getPlugin(plugin.id)) continue;
    loopRegistry.registerPlugin(plugin);
  }
}
