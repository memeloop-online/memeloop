import { BUILTIN_TOOL_PLUGIN_IDS, registerBuiltinToolPlugins } from '../../loopAPI/plugins/builtinToolsPlugin.js';
import { registerBuiltinPromptPlugins } from '../../promptUtilities/builtinPromptPlugins.js';
import type { IToolRegistry } from '../../types.js';
import type { BuiltinToolContext } from './types.js';

export { ASK_QUESTION_TOOL_ID, askQuestionConfigSchema, askQuestionImpl } from './askQuestion.js';
export { ASK_USER_QUESTION_TOOL_ID, askUserQuestionConfigSchema, askUserQuestionImpl } from './askUserQuestion.js';
export { IM_SESSION_TOOL_IDS, type ImSessionBuiltinRegistration, registerImSessionBuiltinTools } from './imBuiltinTools.js';
export { getMcpClientToolId, mcpClientConfigSchema, mcpClientImpl } from './mcpClient.js';
export { getMcpForwardToolId, mcpForwardConfigSchema, mcpForwardImpl } from './mcpForward.js';
export { ORCHESTRATION_TOOL_ID, orchestrationConfigSchema, orchestrationImpl } from './orchestration.js';
export { QUESTION_WAIT_LIMITS, QuestionWaitBroker } from './questionWaitRegistry.js';
export { getRemoteAgentToolId, remoteAgentConfigSchema, remoteAgentImpl, remoteAgentListImpl } from './remoteAgent.js';
export { getSpawnAgentToolId, spawnAgentConfigSchema, spawnAgentImpl } from './spawnAgent.js';
export { getTaskToolId, taskToolConfigSchema, taskToolImpl } from './task.js';
export { InMemoryTodoStateStore, TODO_WRITE_TOOL_ID, type TodoItem, type TodoStateStore, todoWriteConfigSchema, todoWriteImpl } from './todoWrite.js';
export type { BuiltinToolContext, BuiltinToolImpl } from './types.js';

/**
 * Register framework-level builtin tools (agent orchestration, user interaction, MCP).
 *
 * Environment-specific tools (bash, file*, grep, glob, git, webFetch, webSearch, lsp)
 * must be registered by the host environment (e.g. memeloop-cli via registerNodeEnvironmentTools).
 */
export function registerBuiltinTools(registry: IToolRegistry, context: BuiltinToolContext): void {
  if (!context.loopRegistry) {
    throw new Error('registerBuiltinTools requires a runtime-scoped LoopRegistry');
  }
  const promptDestination = context.promptPlugins ?? registry.getPromptPlugins?.();
  if (!promptDestination) {
    throw new Error('registerBuiltinTools requires a runtime-scoped prompt plugin registry');
  }
  registerBuiltinPromptPlugins(promptDestination);

  registerBuiltinToolPlugins(context.loopRegistry);
  context.loopRegistry.installPluginsForLoop('*', { ...context, toolRegistry: registry }, [
    ...BUILTIN_TOOL_PLUGIN_IDS,
  ]);
}
