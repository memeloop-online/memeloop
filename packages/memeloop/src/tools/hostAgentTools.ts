/**
 * Host agent tool configuration → prompt plugin mapping.
 * Every host (Desktop, CLI, Cloud) that defines agent tools needs this merge logic.
 * Defined once in memeloop so each host doesn't reimplement it.
 */

import type { AgentDefinitionToolConfig } from '../agent/types.js';
import type { AgentFrameworkConfig, PromptPluginConfig } from '../promptUtilities/types.js';

function isPluginConfig(value: unknown): value is Record<string, unknown> & { toolId?: string } {
  return typeof value === 'object' && value !== null;
}

export function mergeAgentToolsIntoFrameworkConfig(
  frameworkConfig: AgentFrameworkConfig | undefined,
  agentTools: AgentDefinitionToolConfig[] | undefined,
): AgentFrameworkConfig {
  const baseConfig = { ...(frameworkConfig ?? {}) };
  const rawPlugins = Array.isArray(baseConfig.plugins) ? baseConfig.plugins : [];
  const pluginByToolId = new Map<string, Record<string, unknown>>();
  const pluginWithoutToolId: unknown[] = [];

  for (const plugin of rawPlugins) {
    if (isPluginConfig(plugin) && typeof plugin.toolId === 'string' && plugin.toolId.length > 0) {
      pluginByToolId.set(plugin.toolId, plugin);
    } else {
      pluginWithoutToolId.push(plugin);
    }
  }

  for (const tool of agentTools ?? []) {
    if (!tool.toolId) continue;
    pluginByToolId.set(tool.toolId, {
      id: `${tool.toolId}-agent-tool`,
      toolId: tool.toolId,
      enabled: tool.enabled ?? true,
      ...(tool.parameters ?? {}),
    });
  }

  return {
    ...baseConfig,
    prompts: Array.isArray(baseConfig.prompts) ? baseConfig.prompts : [],
    response: Array.isArray(baseConfig.response) ? baseConfig.response : undefined,
    plugins: [...pluginWithoutToolId, ...pluginByToolId.values()] as PromptPluginConfig[],
  };
}
