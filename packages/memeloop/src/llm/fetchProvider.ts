/**
 * Fetch-based LLM provider — OpenAI-compatible HTTP API.
 *
 * Zero Node.js dependencies — works in browsers, React Native, Deno, Bun.
 * Satisfies `ILLMProvider` from the core loop contract.
 *
 * Based on the same implementation used by memeloop-cli.
 */

import type { ILLMProvider } from '../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface FetchLLMProviderConfig {
  /** Display name, e.g. "cloud-proxy" or "openai". */
  name: string;
  /** Base URL of the OpenAI-compatible API (e.g. "https://api.openai.com/v1"). */
  baseUrl: string;
  /** Bearer token. Omit for unauthenticated endpoints. */
  apiKey?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function normalizeUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('Provider baseUrl is required');
  }
  if (/\/v1\/chat\/completions$/i.test(trimmed) || /\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }
  if (/\/v1$/i.test(trimmed)) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

async function* parseSSEStream(response: Response): AsyncGenerator<unknown, void, unknown> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let separator: number;
      while ((separator = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, separator);
        buf = buf.slice(separator + 2);
        const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (payload === '[DONE]') return;
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

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an `ILLMProvider` that calls an OpenAI-compatible chat completions API.
 *
 * - Streaming (`stream: true`): returns an `AsyncGenerator` yielding SSE chunks.
 * - Non-streaming: returns `choices[0].message.content` as a plain string.
 *
 * @example
 * ```ts
 * const provider = createFetchLLMProvider({
 *   name: 'cloud-proxy',
 *   baseUrl: 'https://cloud.example.com/v1',
 *   apiKey: 'sk-...',
 * });
 * ```
 */
export function createFetchLLMProvider(config: FetchLLMProviderConfig): ILLMProvider {
  const url = normalizeUrl(config.baseUrl);

  return {
    name: config.name,
    model: undefined,
    async chat(request: unknown): Promise<unknown> {
      const body = typeof request === 'object' && request !== null
        ? { ...request }
        : { messages: [] };
      const payload = body as Record<string, unknown>;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      }

      const streamRequested = Boolean((body as { stream?: boolean }).stream);
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`LLM request failed: ${response.status} ${text}`);
      }

      const ct = response.headers.get('content-type') ?? '';
      if (streamRequested && ct.includes('text/event-stream')) {
        return parseSSEStream(response);
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = json?.choices?.[0]?.message?.content;
      return typeof text === 'string' ? text : (json as unknown);
    },
  };
}
