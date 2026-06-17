type LegacyLlmContext = {
  llmProvider: {
    chat?: unknown;
  };
};

type LegacyChatFunction = (request: unknown) => unknown;

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

export function chunkToText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk != null && typeof chunk === "object" && "content" in chunk) {
    const content = (chunk as { content?: unknown }).content;
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  return JSON.stringify(chunk);
}

export async function* streamLlm(
  context: LegacyLlmContext,
  request: unknown,
): AsyncGenerator<unknown, void, unknown> {
  const chatFunction = context.llmProvider.chat;

  if (typeof chatFunction !== "function") {
    throw new Error(
      "LLM provider does not support legacy chat() method. Use AI SDK's streamText instead.",
    );
  }
  const raw = (chatFunction as LegacyChatFunction)(request);
  let resolved: unknown = raw;
  if (resolved != null && typeof (resolved as Promise<unknown>).then === "function") {
    resolved = await (resolved as Promise<unknown>);
  }
  if (isAsyncIterable(resolved)) {
    for await (const chunk of resolved) {
      yield chunk;
    }
    return;
  }
  yield resolved;
}
