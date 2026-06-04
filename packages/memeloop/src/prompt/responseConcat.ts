/**
 * TidGi `responseConcat.ts` 迁移：postProcess 钩子链 + responses 合并。
 */
import type { ChatMessage } from '../protocol/index.js';
import { createAgentFrameworkHooks, resolvePromptPluginMap, runPostProcessHooks } from '../tools/pluginRegistry.js';
import type { AgentResponse, DefineToolAgentFrameworkContext, FrameworkPluginToolConfig } from '../tools/types.js';
import type { YieldNextRoundTarget } from '../tools/types.js';
import type { ToolCallingMatch } from './responsePatternUtility.js';
import type { IPrompt } from './types.js';

function cloneResponses(responses: AgentResponse[]): AgentResponse[] {
  return structuredClone(responses);
}

export async function responseConcat(
  agentFrameworkConfig: { response?: AgentResponse[]; plugins?: FrameworkPluginToolConfig[] },
  llmResponse: string,
  agentFrameworkContext: DefineToolAgentFrameworkContext,
  messages: ChatMessage[],
): Promise<{
  processedResponse: string;
  yieldNextRoundTo?: YieldNextRoundTarget;
  toolCallInfo?: ToolCallingMatch;
}> {
  const responses: AgentResponse[] = Array.isArray(agentFrameworkConfig?.response)
    ? cloneResponses(agentFrameworkConfig.response)
    : [];
  const toolConfigs = (
    Array.isArray(agentFrameworkConfig.plugins) ? agentFrameworkConfig.plugins : []
  ).filter((t) => t.enabled !== false);

  const hooks = createAgentFrameworkHooks();
  const pluginMap = resolvePromptPluginMap(agentFrameworkContext);
  for (const tool of toolConfigs) {
    const builtInTool = pluginMap.get(tool.toolId);
    if (builtInTool) {
      builtInTool(hooks);
    }
  }

  let yieldNextRoundTo: YieldNextRoundTarget | undefined;
  let toolCallInfo: ToolCallingMatch | undefined;

  for (const tool of toolConfigs) {
    const responseContext = {
      agentFrameworkContext,
      messages,
      prompts: [] as IPrompt[],
      toolConfig: tool,
      llmResponse,
      responses,
      metadata: {},
      actions: {} as { yieldNextRoundTo?: YieldNextRoundTarget; toolCalling?: ToolCallingMatch },
    };

    await runPostProcessHooks(hooks, responseContext);

    if (responseContext.actions?.yieldNextRoundTo) {
      yieldNextRoundTo = responseContext.actions.yieldNextRoundTo;
      if (responseContext.actions.toolCalling) {
        toolCallInfo = responseContext.actions.toolCalling;
      }
    }
  }

  const processedResponse = flattenResponses(responses);

  return {
    processedResponse: processedResponse || llmResponse,
    yieldNextRoundTo,
    toolCallInfo,
  };
}

function flattenResponses(responses: AgentResponse[]): string {
  if (responses.length === 0) {
    return '';
  }
  return responses
    .filter((response) => response.enabled !== false)
    .map((response) => response.text || '')
    .join('\n\n')
    .trim();
}
