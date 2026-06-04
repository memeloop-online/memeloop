import { registerBuiltinPromptPlugins } from '../../prompt/builtinPromptPlugins.js';
import type { IToolRegistry } from '../../types.js';
import { pluginRegistry } from '../pluginRegistry.js';
import { registerToolParameterSchema } from '../schemaRegistry.js';

import { ASK_QUESTION_TOOL_ID, askQuestionConfigSchema, askQuestionImpl } from './askQuestion.js';
import { ASK_USER_QUESTION_TOOL_ID, askUserQuestionConfigSchema, askUserQuestionImpl } from './askUserQuestion.js';
import { getMcpClientToolId, mcpClientConfigSchema, mcpClientImpl } from './mcpClient.js';
import { getMcpForwardToolId, mcpForwardConfigSchema, mcpForwardImpl } from './mcpForward.js';
import { getRemoteAgentToolId, remoteAgentConfigSchema, remoteAgentImpl } from './remoteAgent.js';
import { getSpawnAgentToolId, spawnAgentConfigSchema, spawnAgentImpl } from './spawnAgent.js';
import { getTaskToolId, taskToolConfigSchema, taskToolImpl } from './task.js';
import { TODO_WRITE_TOOL_ID, todoWriteConfigSchema, todoWriteImpl } from './todoWrite.js';
import type { BuiltinToolContext } from './types.js';

export { ASK_QUESTION_TOOL_ID, askQuestionConfigSchema, askQuestionImpl } from './askQuestion.js';
export { ASK_USER_QUESTION_TOOL_ID, askUserQuestionConfigSchema, askUserQuestionImpl } from './askUserQuestion.js';
export { IM_SESSION_TOOL_IDS, type ImSessionBuiltinRegistration, registerImSessionBuiltinTools } from './imBuiltinTools.js';
export { getMcpClientToolId, mcpClientConfigSchema, mcpClientImpl } from './mcpClient.js';
export { getMcpForwardToolId, mcpForwardConfigSchema, mcpForwardImpl } from './mcpForward.js';
export { resolveQuestionAnswer } from './questionWaitRegistry.js';
export { getRemoteAgentToolId, remoteAgentConfigSchema, remoteAgentImpl, remoteAgentListImpl } from './remoteAgent.js';
export { getSpawnAgentToolId, spawnAgentConfigSchema, spawnAgentImpl } from './spawnAgent.js';
export { getTaskToolId, taskToolConfigSchema, taskToolImpl } from './task.js';
export { __clearTodoStore, TODO_WRITE_TOOL_ID, todoWriteConfigSchema, todoWriteImpl } from './todoWrite.js';
export type { BuiltinToolContext, BuiltinToolImpl } from './types.js';

/**
 * Register framework-level builtin tools (agent orchestration, user interaction, MCP).
 *
 * Environment-specific tools (bash, file*, grep, glob, git, webFetch, webSearch, lsp)
 * must be registered by the host environment (e.g. memeloop-cli via registerNodeEnvironmentTools).
 */
export function registerBuiltinTools(registry: IToolRegistry, context: BuiltinToolContext): void {
  const promptDestination = registry.getPromptPlugins?.();
  if (promptDestination) {
    for (const [id, tool] of pluginRegistry) {
      promptDestination.set(id, tool);
    }
    registerBuiltinPromptPlugins(promptDestination);
  } else {
    registerBuiltinPromptPlugins();
  }

  registry.registerTool(getMcpClientToolId(), (arguments_: Record<string, unknown>) => mcpClientImpl(arguments_, context));
  registry.registerTool(getMcpForwardToolId(), (arguments_: Record<string, unknown>) => mcpForwardImpl(arguments_, context));
  registry.registerTool(getSpawnAgentToolId(), (arguments_: Record<string, unknown>) => spawnAgentImpl(arguments_, context));
  registry.registerTool(getRemoteAgentToolId(), (arguments_: Record<string, unknown>) => remoteAgentImpl(arguments_, context));
  registry.registerTool(ASK_QUESTION_TOOL_ID, (arguments_: Record<string, unknown>) => askQuestionImpl(arguments_, context));
  registry.registerTool(TODO_WRITE_TOOL_ID, (arguments_: Record<string, unknown>) => todoWriteImpl(arguments_, context));
  registry.registerTool(ASK_USER_QUESTION_TOOL_ID, (arguments_: Record<string, unknown>) => askUserQuestionImpl(arguments_, context));
  registry.registerTool(getTaskToolId(), (arguments_: Record<string, unknown>) => taskToolImpl(arguments_, context));

  registerToolParameterSchema(getMcpClientToolId(), mcpClientConfigSchema, {
    displayName: 'MCP Client',
    description: 'Call a tool on a remote MCP server (transparent proxy). Requires nodeId, serverName, toolName, and optional args.',
  });
  registerToolParameterSchema(getMcpForwardToolId(), mcpForwardConfigSchema, {
    displayName: 'MCP Forward',
    description: "Discover MCP servers and tools on connected nodes. Use action='list' for nodes with servers, action='listTools' for all available tools.",
  });
  registerToolParameterSchema(getSpawnAgentToolId(), spawnAgentConfigSchema, {
    displayName: 'Spawn Agent',
    description: 'Run a local sub-agent with the given definition and message. Returns summary.',
  });
  registerToolParameterSchema(getRemoteAgentToolId(), remoteAgentConfigSchema, {
    displayName: 'Remote Agent',
    description: 'Create and run a sub-agent on a remote node. Requires nodeId, definitionId, message. List nodes with no args.',
  });
  registerToolParameterSchema(ASK_QUESTION_TOOL_ID, askQuestionConfigSchema, {
    displayName: 'Ask Question',
    description: 'Block until the user answers (via memeloop.agent.resolveQuestion RPC). Args: question, conversationId, optional timeoutMs.',
  });
  registerToolParameterSchema(TODO_WRITE_TOOL_ID, todoWriteConfigSchema, {
    displayName: 'Todo Write',
    description: 'Manage structured todo lists: create, update, complete, list, remove. Todos scoped per conversation.',
  });
  registerToolParameterSchema(ASK_USER_QUESTION_TOOL_ID, askUserQuestionConfigSchema, {
    displayName: 'Ask User Question',
    description: 'Pause agent and ask user a question. Supports text, single-select, and multi-select input types. Blocks until answered.',
  });
  registerToolParameterSchema(getTaskToolId(), taskToolConfigSchema, {
    displayName: 'Task Delegation',
    description: 'Delegate a task to a specialized sub-agent (build, plan, explore, oracle, librarian). Supports sync (default) and background modes.',
  });
}
