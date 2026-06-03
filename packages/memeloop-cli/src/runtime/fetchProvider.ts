import type { ILLMProvider } from "memeloop";
import { getApiKey } from "../auth/authStore.js";
import type { ProviderEntry } from "../config";

function normalizeOpenAiCompatibleChatUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("Provider baseUrl is required");
  }
  if (/\/v1\/chat\/completions$/i.test(trimmed) || /\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }
  if (/\/v1$/i.test(trimmed)) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

async function* parseOpenAiSseStream(response: Response): AsyncGenerator<unknown, void, unknown> {
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let separator: number;
      while ((separator = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, separator);
        buf = buf.slice(separator + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) {
          continue;
        }
        const payload = dataLine.slice(5).trim();
        if (payload === "[DONE]") {
          return;
        }
        try {
          yield JSON.parse(payload) as unknown;
        } catch {
          yield payload;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * OpenAI 兼容 HTTP LLM：`stream: true` 且 `text/event-stream` 时返回 AsyncIterable（SSE）；
 * 非流式时在 `choices[0].message.content` 为字符串时返回该正文（供 TaskAgent 解析 tool XML），否则返回解析后的 JSON。
 */
export function createFetchLLMProvider(entry: ProviderEntry): ILLMProvider {
  const name = entry.name;
  const baseUrl = (entry.baseUrl ?? entry.options?.baseURL) as string | undefined;
  // API key priority: entry.apiKey > entry.options.apiKey > auth.yaml
  const apiKey = entry.apiKey ?? (entry.options?.apiKey as string | undefined) ?? getApiKey(name);

  if (!baseUrl) {
    throw new Error(`Provider "${name}" is missing baseUrl (set baseUrl or options.baseURL)`);
  }

  const url = normalizeOpenAiCompatibleChatUrl(baseUrl);

  return {
    name,
    model: undefined,
    async chat(request: unknown): Promise<unknown> {
      const body =
        typeof request === "object" && request !== null ? { ...request } : { messages: [] };
      const payload = body as Record<string, unknown>;
      const modelId = typeof payload.modelId === "string" ? payload.modelId.trim() : "";
      if (modelId && typeof payload.model !== "string") {
        const slashIndex = modelId.indexOf("/");
        payload.model = slashIndex >= 0 ? modelId.slice(slashIndex + 1) : modelId;
      }
      delete payload.modelId;
      const streamRequested = Boolean((body as { stream?: boolean }).stream);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`LLM request failed: ${response.status} ${text}`);
      }
      const ct = response.headers.get("content-type") ?? "";
      if (streamRequested && ct.includes("text/event-stream")) {
        return parseOpenAiSseStream(response);
      }
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text === "string") {
        return text;
      }
      return json as unknown;
    },
  };
}
