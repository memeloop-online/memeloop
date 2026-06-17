import type { MemeLoopRuntime } from "../runtime.js";

import { imPlatformMaxMessageChars } from "./imPlatformLimits.js";
import type { TextMessageRenderer } from "./textRenderer.js";

export type ImStreamFlush = (text: string) => Promise<void>;

function stringifyImValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable value]";
  }
}

/**
 * Subscribe to `runtime` agent updates and forward assistant text + light tool summaries to IM,
 * flushing when the buffer reaches the platform limit (plan §20.6.1).
 */
export async function streamRuntimeAgentReplyToIm(options: {
  runtime: MemeLoopRuntime;
  conversationId: string;
  platform: string;
  renderer: TextMessageRenderer;
  flush: ImStreamFlush;
}): Promise<void> {
  const max = imPlatformMaxMessageChars(options.platform);
  let buf = "";

  const sendSlice = async (force: boolean): Promise<void> => {
    if (buf.length === 0) return;
    if (force) {
      while (buf.length > 0) {
        const take = Math.min(max, buf.length);
        const chunk = buf.slice(0, take);
        buf = buf.slice(take);
        if (chunk.trim().length > 0) await options.flush(chunk);
      }
      return;
    }
    while (buf.length >= max) {
      const chunk = buf.slice(0, max);
      buf = buf.slice(max);
      await options.flush(chunk);
    }
  };

  await new Promise<void>((resolve, reject) => {
    const off = options.runtime.subscribeToUpdates(options.conversationId, (u: unknown) => {
      const o = u as { type?: string; step?: { type?: string; data?: unknown } };
      if (o.type === "agent-done") {
        void sendSlice(true)
          .then(() => {
            off();
            resolve();
          })
          .catch(reject);
        return;
      }
      if (o.type === "agent-error") {
        off();
        reject(new Error((o as { error?: string }).error ?? "agent-error"));
        return;
      }
      if (o.type === "agent-step" && o.step?.type === "message") {
        const stepData = o.step.data;
        let piece = "";
        if (typeof stepData === "string") piece = stepData;
        else if (stepData != null && typeof stepData === "object" && "content" in stepData) {
          const content = (stepData as { content?: unknown }).content;
          piece = stringifyImValue(content);
        } else piece = stringifyImValue(stepData);
        buf += piece;
        void sendSlice(false);
      }
      if (o.type === "agent-step" && o.step?.type === "tool") {
        const td = o.step.data as {
          toolId?: string;
          parameters?: unknown;
          result?: unknown;
          isError?: boolean;
        };
        const id = td.toolId;
        if (!id) return;
        if (id === "ask-question") {
          const p = td.parameters as {
            question?: string;
            options?: Array<{ label: string }>;
          };
          const q = typeof p?.question === "string" ? p.question : "";
          const optLabels = p?.options
            ?.map((o) => o.label)
            .filter((x): x is string => typeof x === "string");
          const askText = options.renderer.renderAskQuestion(q, optLabels);
          buf += (buf && !buf.endsWith("\n") ? "\n" : "") + askText + "\n";
          void sendSlice(true);
          return;
        }
        if (td.isError) {
          buf +=
            (buf && !buf.endsWith("\n") ? "\n" : "") +
            options.renderer.renderError(stringifyImValue(td.result) || "tool error") +
            "\n";
          void sendSlice(false);
          return;
        }
        const callLine = options.renderer.renderToolCallSummary(id, td.parameters ?? {});
        const resultLine = options.renderer.renderToolResultSummary(id, td.result ?? null);
        buf +=
          (buf && !buf.endsWith("\n") ? "\n" : "") +
          callLine +
          (resultLine ? `\n${resultLine}` : "") +
          "\n";
        void sendSlice(false);
      }
    });
  });
}
