import {
  BUILTIN_TOOL_PLUGIN_IDS,
  registerBuiltinToolPlugins,
} from "../../agentLoops/plugins/builtinToolsPlugin.js";
import { getLoopRegistry } from "../../agentLoops/registry.js";
import { registerBuiltinPromptPlugins } from "../../promptUtilities/builtinPromptPlugins.js";
import type { IToolRegistry } from "../../types.js";
import { pluginRegistry } from "../pluginRegistry.js";
import type { BuiltinToolContext } from "./types.js";

export { ASK_QUESTION_TOOL_ID, askQuestionConfigSchema, askQuestionImpl } from "./askQuestion.js";
export {
  ASK_USER_QUESTION_TOOL_ID,
  askUserQuestionConfigSchema,
  askUserQuestionImpl,
} from "./askUserQuestion.js";
export {
  IM_SESSION_TOOL_IDS,
  type ImSessionBuiltinRegistration,
  registerImSessionBuiltinTools,
} from "./imBuiltinTools.js";
export { getMcpClientToolId, mcpClientConfigSchema, mcpClientImpl } from "./mcpClient.js";
export { getMcpForwardToolId, mcpForwardConfigSchema, mcpForwardImpl } from "./mcpForward.js";
export { resolveQuestionAnswer } from "./questionWaitRegistry.js";
export {
  getRemoteAgentToolId,
  remoteAgentConfigSchema,
  remoteAgentImpl,
  remoteAgentListImpl,
} from "./remoteAgent.js";
export { getSpawnAgentToolId, spawnAgentConfigSchema, spawnAgentImpl } from "./spawnAgent.js";
export { getTaskToolId, taskToolConfigSchema, taskToolImpl } from "./task.js";
export {
  __clearTodoStore,
  TODO_WRITE_TOOL_ID,
  todoWriteConfigSchema,
  todoWriteImpl,
} from "./todoWrite.js";
export type { BuiltinToolContext, BuiltinToolImpl } from "./types.js";

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

  registerBuiltinToolPlugins();
  getLoopRegistry().installPluginsForLoop("*", { ...context, toolRegistry: registry }, [
    ...BUILTIN_TOOL_PLUGIN_IDS,
  ]);
}
