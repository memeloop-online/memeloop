import { getActivePluginRegistry } from '../tools/pluginRegistry.js';
import type { PromptConcatHooks, PromptConcatTool } from '../tools/types.js';

import type { PromptNode } from './types.js';

export const FULL_REPLACEMENT_PLUGIN_TOOL_ID = 'fullReplacement';
export const DYNAMIC_POSITION_PLUGIN_TOOL_ID = 'dynamicPosition';

function registerFullReplacement(reg: Map<string, PromptConcatTool>): void {
  if (reg.has(FULL_REPLACEMENT_PLUGIN_TOOL_ID)) return;
  reg.set(FULL_REPLACEMENT_PLUGIN_TOOL_ID, (hooks: PromptConcatHooks) => {
    hooks.processPrompts.tapAsync(
      'fullReplacementLite',
      (context: { messages: unknown[] }, callback) => {
        const msgs = context.messages;
        if (!Array.isArray(msgs)) {
          callback();
          return;
        }
        const maxChars = Number(process.env.MEMELOOP_FULL_REPLACEMENT_MAX_CHARS ?? 48_000);
        if (!Number.isFinite(maxChars) || maxChars <= 0) {
          callback();
          return;
        }
        let total = 0;
        const kept: unknown[] = [];
        for (let index = msgs.length - 1; index >= 0; index--) {
          const m = msgs[index] as { content?: unknown };
          const c = typeof m?.content === 'string'
            ? m.content
            : m?.content != null
            ? JSON.stringify(m.content)
            : '';
          total += c.length;
          if (total > maxChars) break;
          kept.push(m);
        }
        kept.reverse();
        context.messages = kept;
        callback();
      },
    );
  });
}

/**
 * TidGi `dynamicPosition` 极简版：根级 `prompt` 若带 `dynamicPosition: "deferToEnd"`，
 * 在用户轮次 ≥2 时将该节点移到同级列表末尾（多轮后再强调尾部 system/user 块）。
 */
function registerDynamicPosition(reg: Map<string, PromptConcatTool>): void {
  if (reg.has(DYNAMIC_POSITION_PLUGIN_TOOL_ID)) return;
  reg.set(DYNAMIC_POSITION_PLUGIN_TOOL_ID, (hooks: PromptConcatHooks) => {
    hooks.processPrompts.tapAsync(
      'dynamicPositionLite',
      (context: { messages: unknown[]; prompts?: PromptNode[] }, callback) => {
        const prompts = context.prompts;
        const messages = context.messages;
        if (!Array.isArray(prompts) || prompts.length < 2 || !Array.isArray(messages)) {
          callback();
          return;
        }
        const userTurns = messages.filter((m) => (m as { role?: string })?.role === 'user').length;
        if (userTurns < 2) {
          callback();
          return;
        }
        const deferred: PromptNode[] = [];
        const rest: PromptNode[] = [];
        for (const n of prompts) {
          if (n?.dynamicPosition === 'deferToEnd') deferred.push(n);
          else rest.push(n);
        }
        if (deferred.length === 0) {
          callback();
          return;
        }
        context.prompts = [...rest, ...deferred] as typeof context.prompts;
        callback();
      },
    );
  });
}

/**
 * 注册内置 prompt 插件（fullReplacement、dynamicPosition）。
 * @param target 若传入（如节点 `ToolRegistry` 上的 Map），只写入该表；否则写入活动注册表（全局或 ALS）。
 */
export function registerBuiltinPromptPlugins(target?: Map<string, PromptConcatTool>): void {
  const reg = target ?? getActivePluginRegistry();
  registerFullReplacement(reg);
  registerDynamicPosition(reg);
}
