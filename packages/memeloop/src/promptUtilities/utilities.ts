import type { ChatMessage } from "../conversation/index.js";

export function normalizeRoleForLlm(role: string): "user" | "assistant" | "system" | "tool" {
  if (role === "assistant" || role === "system" || role === "tool") return role;
  return "user";
}

/**
 * 丢弃早于 `now - maxAgeMs` 的历史消息（按 `ChatMessage.timestamp`，毫秒）。
 * `maxAgeMs <= 0` 时不裁剪。
 */
export function filterOldMessagesByDuration(
  messages: ChatMessage[],
  maxAgeMs: number,
  now: number = Date.now(),
): ChatMessage[] {
  if (maxAgeMs <= 0) return messages;
  const cutoff = now - maxAgeMs;
  return messages.filter((m) => typeof m.timestamp === "number" && m.timestamp >= cutoff);
}

export function getFinalPromptResult(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n");
}
