import type { IToolRegistry } from "../../types.js";
import { registerBuiltinPromptPlugins } from "../../prompt/builtinPromptPlugins.js";
import { pluginRegistry } from "../pluginRegistry.js";
import { registerToolParameterSchema } from "../schemaRegistry.js";

import type { BuiltinToolContext } from "./types.js";
import { getMcpClientToolId, mcpClientConfigSchema, mcpClientImpl } from "./mcpClient.js";
import { getMcpForwardToolId, mcpForwardConfigSchema, mcpForwardImpl } from "./mcpForward.js";
import { getRemoteAgentToolId, remoteAgentConfigSchema, remoteAgentImpl } from "./remoteAgent.js";
import { getSpawnAgentToolId, spawnAgentConfigSchema, spawnAgentImpl } from "./spawnAgent.js";
import { ASK_QUESTION_TOOL_ID, askQuestionConfigSchema, askQuestionImpl } from "./askQuestion.js";
import { TODO_WRITE_TOOL_ID, todoWriteConfigSchema, todoWriteImpl } from "./todoWrite.js";
import {
  ASK_USER_QUESTION_TOOL_ID,
  askUserQuestionConfigSchema,
  askUserQuestionImpl,
} from "./askUserQuestion.js";
import { getTaskToolId, taskToolConfigSchema, taskToolImpl } from "./task.js";

export { mcpClientImpl, mcpClientConfigSchema, getMcpClientToolId } from "./mcpClient.js";
export { mcpForwardImpl, mcpForwardConfigSchema, getMcpForwardToolId } from "./mcpForward.js";
export {
  remoteAgentImpl,
  remoteAgentConfigSchema,
  remoteAgentListImpl,
  getRemoteAgentToolId,
} from "./remoteAgent.js";
export { spawnAgentImpl, spawnAgentConfigSchema, getSpawnAgentToolId } from "./spawnAgent.js";
export { askQuestionImpl, askQuestionConfigSchema, ASK_QUESTION_TOOL_ID } from "./askQuestion.js";
export { todoWriteImpl, todoWriteConfigSchema, TODO_WRITE_TOOL_ID, __clearTodoStore } from "./todoWrite.js";
export {
  askUserQuestionImpl,
  askUserQuestionConfigSchema,
  ASK_USER_QUESTION_TOOL_ID,
} from "./askUserQuestion.js";
export { taskToolImpl, taskToolConfigSchema, getTaskToolId } from "./task.js";
export { resolveQuestionAnswer } from "./questionWaitRegistry.js";
export type { BuiltinToolContext, BuiltinToolImpl } from "./types.js";
export {
  IM_SESSION_TOOL_IDS,
  registerImSessionBuiltinTools,
  type ImSessionBuiltinRegistration,
} from "./imBuiltinTools.js";

/**
 * Register framework-level builtin tools (agent orchestration, user interaction, MCP).
 *
 * Environment-specific tools (bash, file*, grep, glob, git, webFetch, webSearch, lsp)
 * must be registered by the host environment (e.g. memeloop-cli via registerNodeEnvironmentTools).
 */
export function registerBuiltinTools(registry: IToolRegistry, context: BuiltinToolContext): void {
  const promptDest = registry.getPromptPlugins?.();
  if (promptDest) {
    for (const [id, tool] of pluginRegistry) {
      promptDest.set(id, tool);
    }
    registerBuiltinPromptPlugins(promptDest);
  } else {
    registerBuiltinPromptPlugins();
  }

  registry.registerTool(getMcpClientToolId(), (args: Record<string, unknown>) =>
    mcpClientImpl(args, context),
  );
  registry.registerTool(getMcpForwardToolId(), (args: Record<string, unknown>) =>
    mcpForwardImpl(args, context),
  );
  registry.registerTool(getSpawnAgentToolId(), (args: Record<string, unknown>) =>
    spawnAgentImpl(args, context),
  );
  registry.registerTool(getRemoteAgentToolId(), (args: Record<string, unknown>) =>
    remoteAgentImpl(args, context),
  );
  registry.registerTool(ASK_QUESTION_TOOL_ID, (args: Record<string, unknown>) =>
    askQuestionImpl(args, context),
  );
  registry.registerTool(TODO_WRITE_TOOL_ID, (args: Record<string, unknown>) =>
    todoWriteImpl(args, context),
  );
  registry.registerTool(ASK_USER_QUESTION_TOOL_ID, (args: Record<string, unknown>) =>
    askUserQuestionImpl(args, context),
  );
  registry.registerTool(getTaskToolId(), (args: Record<string, unknown>) =>
    taskToolImpl(args, context),
  );

  registerToolParameterSchema(getMcpClientToolId(), mcpClientConfigSchema, {
    displayName: "MCP Client",
    description:
      "Call a tool on a remote MCP server (transparent proxy). Requires nodeId, serverName, toolName, and optional args.",
  });
  registerToolParameterSchema(getMcpForwardToolId(), mcpForwardConfigSchema, {
    displayName: "MCP Forward",
    description:
      "Discover MCP servers and tools on connected nodes. Use action='list' for nodes with servers, action='listTools' for all available tools.",
  });
  registerToolParameterSchema(getSpawnAgentToolId(), spawnAgentConfigSchema, {
    displayName: "Spawn Agent",
    description: "Run a local sub-agent with the given definition and message. Returns summary.",
  });
  registerToolParameterSchema(getRemoteAgentToolId(), remoteAgentConfigSchema, {
    displayName: "Remote Agent",
    description:
      "Create and run a sub-agent on a remote node. Requires nodeId, definitionId, message. List nodes with no args.",
  });
  registerToolParameterSchema(ASK_QUESTION_TOOL_ID, askQuestionConfigSchema, {
    displayName: "Ask Question",
    description:
      "Block until the user answers (via memeloop.agent.resolveQuestion RPC). Args: question, conversationId, optional timeoutMs.",
  });
  registerToolParameterSchema(TODO_WRITE_TOOL_ID, todoWriteConfigSchema, {
    displayName: "Todo Write",
    description:
      "Manage structured todo lists: create, update, complete, list, remove. Todos scoped per conversation.",
  });
  registerToolParameterSchema(ASK_USER_QUESTION_TOOL_ID, askUserQuestionConfigSchema, {
    displayName: "Ask User Question",
    description:
      "Pause agent and ask user a question. Supports text, single-select, and multi-select input types. Blocks until answered.",
  });
  registerToolParameterSchema(getTaskToolId(), taskToolConfigSchema, {
    displayName: "Task Delegation",
    description:
      "Delegate a task to a specialized sub-agent (build, plan, explore, oracle, librarian). Supports sync (default) and background modes.",
  });
}
