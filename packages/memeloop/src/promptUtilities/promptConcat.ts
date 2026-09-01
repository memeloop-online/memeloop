import type { ChatMessage } from '../conversation/index.js';
import { safeErrorMessageFromUnknown } from '../safeError.js';

import { createAgentFrameworkHooks, resolvePromptPluginMap, runProcessPromptsHooks } from '../tools/pluginRegistry.js';
import type { AgentFrameworkContext } from '../types.js';
import type { AgentPromptDescription, PromptNode, PromptPluginConfig } from './types.js';

/** 将 prompt 节点 `id` 映射到 agentFrameworkConfig.prompts 树中的索引路径（供 UI / schema 注解）。 */
export function collectPromptSourcePaths(
  prompts: PromptNode[],
  basePath = 'agentFrameworkConfig.prompts',
): Record<string, string> {
  const out: Record<string, string> = {};
  function walk(nodes: PromptNode[], prefix: string): void {
    nodes.forEach((n, index) => {
      const p = `${prefix}.${index}`;
      if (n.id) {
        out[n.id] = p;
      }
      if (n.children?.length) {
        walk(n.children, `${p}.children`);
      }
    });
  }
  walk(prompts, basePath);
  return out;
}

const logger = {
  debug: (..._arguments: unknown[]) => {},
  info: (..._arguments: unknown[]) => {},
  warn: (..._arguments: unknown[]) => {},
  error: (..._arguments: unknown[]) => {},
};

export interface PromptConcatContext {
  messages: ChatMessage[];
}

/** 扁平化后的 LLM 消息（不依赖 peer `ai` 包导出，避免 d.ts 与 SDK 主版本不一致） */
export type PromptFlatModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
};

export function findPromptById(
  prompts: PromptNode[],
  id: string,
): { prompt: PromptNode; parent: PromptNode[]; index: number } | undefined {
  for (let index = 0; index < prompts.length; index++) {
    const prompt = prompts[index];
    if (prompt.id === id) {
      return { prompt, parent: prompts, index };
    }
    if (prompt.children) {
      const found = findPromptById(prompt.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function flattenPrompts(prompts: PromptNode[]): PromptFlatModelMessage[] {
  const result: PromptFlatModelMessage[] = [];

  function processPrompt(prompt: PromptNode): string {
    let text = prompt.text ?? '';
    if (prompt.children) {
      for (const child of prompt.children) {
        if (!child.role) {
          text += processPrompt(child);
        }
      }
    }
    return text;
  }

  function collectRolePrompts(nodes: PromptNode[]): void {
    for (const prompt of nodes) {
      if (prompt.enabled === false) continue;

      const content = processPrompt(prompt);
      if (content.trim() || prompt.role) {
        result.push({
          role: prompt.role ?? 'system',
          content: content.trim(),
        });
      }

      if (prompt.children) {
        collectRolePrompts(prompt.children);
      }
    }
  }

  collectRolePrompts(prompts);
  return result;
}

export interface PromptConcatPluginPreview {
  id: string;
  toolId?: string;
  caption?: string;
}

export interface PromptConcatStreamState {
  processedPrompts: PromptNode[];
  flatPrompts: PromptFlatModelMessage[];
  step: 'flatten' | 'complete' | 'plugin' | 'finalize';
  isComplete: boolean;
  /** prompt 节点 id → JSON 路径（如 agentFrameworkConfig.prompts.0） */
  sourcePaths?: Record<string, string>;
  /** Desktop UI: plugin currently being processed. */
  currentPlugin?: PromptConcatPluginPreview;
  /** Desktop UI: progress value between 0 and 1. */
  progress?: number;
}

export interface PromptConcatOptions {
  readAttachmentFile?: (path: string) => Promise<Uint8Array>;
}

export async function* promptConcatStream(
  agentConfig: Pick<AgentPromptDescription, 'agentFrameworkConfig'>,
  messages: ChatMessage[],
  agentFrameworkContext: AgentFrameworkContext,
  options?: PromptConcatOptions,
): AsyncGenerator<PromptConcatStreamState, PromptConcatStreamState, unknown> {
  const frameworkConfig = agentConfig.agentFrameworkConfig;
  const promptConfigs: PromptNode[] = frameworkConfig?.prompts ?? [];
  const plugins: PromptPluginConfig[] = frameworkConfig?.plugins ?? [];

  const hooks = createAgentFrameworkHooks();
  const pluginMap = resolvePromptPluginMap(agentFrameworkContext);
  for (const plugin of plugins) {
    const entry = pluginMap.get(plugin.toolId);
    if (entry) entry(hooks);
  }

  // Run processPrompts hooks once per plugin so each handler sees its own toolConfig.
  // Desktop defineTool handlers check toolConfig.toolId and skip non-matching plugins.
  let processedContext = { prompts: promptConfigs };
  for (let index = 0; index < plugins.length; index++) {
    const plugin = plugins[index];
    processedContext = await runProcessPromptsHooks(hooks, {
      prompts: processedContext.prompts,
      messages,
      toolConfig: plugin,
      pluginIndex: index,
      agentFrameworkContext,
    });
  }

  const processed = processedContext.prompts;
  const flat = flattenPrompts(processed);

  // 如果最后一条消息是 user，把其内容追加到 prompts
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    const content = last.content;
    const fileMeta = (last as ChatMessage & { metadata?: { file?: { path?: string } } }).metadata
      ?.file;
    if (fileMeta?.path && options?.readAttachmentFile) {
      try {
        const buf = await options.readAttachmentFile(fileMeta.path);
        flat.push({
          role: 'user',
          content: [
            { type: 'image', image: buf },
            { type: 'text', text: content },
          ],
        });
      } catch (error) {
        logger.error('failed to read attached file', {
          error: safeErrorMessageFromUnknown(error, { fallback: 'Attachment read failed' }),
          path: fileMeta.path,
        });
      }
    } else if (fileMeta?.path && !options?.readAttachmentFile) {
      flat.push({
        role: 'user',
        content: `[attached path: ${fileMeta.path}]\n${content}`,
      });
    } else {
      flat.push({ role: 'user', content });
    }
  }

  const state: PromptConcatStreamState = {
    processedPrompts: processed,
    flatPrompts: flat,
    step: 'complete',
    isComplete: true,
    sourcePaths: collectPromptSourcePaths(processed),
  };

  yield state;
  return state;
}
