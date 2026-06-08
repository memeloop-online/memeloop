import type { PromptConcatHooks } from "../../tools/types.js";

export type PromptModifier = (hooks: PromptConcatHooks) => void;

/**
 * TidGi `defineModifier` 的极简移植：注册可在 `agentFrameworkConfig.plugins` 中通过 `toolId` 引用的修饰器。
 */
export function defineModifier(
  modifierId: string,
  modifier: PromptModifier,
): { modifierId: string; modifier: PromptModifier } {
  return { modifierId, modifier };
}
