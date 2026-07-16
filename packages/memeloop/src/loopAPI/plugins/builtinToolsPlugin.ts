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

import { registerToolParameterSchema } from '../../tools/schemaRegistry.js';
import type { IToolRegistry } from '../../types.js';
import { getLoopRegistry } from '../registry.js';
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
}

function getToolRegistry(context: { [key: string]: unknown }): IToolRegistry | undefined {
  return context.toolRegistry as IToolRegistry | undefined;
}

function createBuiltinToolPlugin(options: BuiltinToolPluginOptions): LoopPlugin {
  return {
    id: options.id,
    targetLoopId: '*',
    install: (context) => {
      const registry = getToolRegistry(context);
      if (!registry) return;

      const builtinContext = context as unknown as BuiltinToolContext;
      registry.registerTool(options.toolId, (arguments_: Record<string, unknown>) => options.implementation(arguments_, builtinContext));
      registerToolParameterSchema(options.toolId, options.schema, options.metadata);
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
export function registerBuiltinToolPlugins(): void {
  const loopRegistry = getLoopRegistry();

  for (const plugin of builtinToolPlugins) {
    if (loopRegistry.getPlugin(plugin.id)) continue;
    loopRegistry.registerPlugin(plugin);
  }
}
