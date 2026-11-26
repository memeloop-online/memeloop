import type { ChatMessage } from '../../conversation/index.js';
import { prepareModelRequest, type ResolvedAgentModelRoute } from '../../llm/prepareModelRequest.js';
import { BOUNDED_MODEL_CONTEXT_LIMITS } from './boundedModelContext.js';
import { streamLlm } from './llmStream.js';
import { NativeModelStreamAccumulator } from './nativeStreamAccumulator.js';
import { buildSemanticModelContextSummaryPrompt } from './semanticModelContextProjection.js';

const summaryTextEncoder = new TextEncoder();

/** Exact-route bounded summarizer shared by execution and preview context loading. */
export async function summarizeModelContext(
  route: ResolvedAgentModelRoute,
  messages: readonly ChatMessage[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const linked = createLinkedAbortController(signal);
  const prompt = buildSemanticModelContextSummaryPrompt(messages);
  const prepared = prepareModelRequest({
    route,
    messages: [{
      role: 'user',
      content: prompt,
    }],
    stream: true,
    toolChoice: 'none',
    signal: linked.controller.signal,
  });
  let summaryBytes = 0;
  const accumulator = new NativeModelStreamAccumulator();
  try {
    for await (const part of streamLlm(prepared.route.provider, prepared.request)) {
      signal.throwIfAborted();
      accumulator.apply(part);
      if (part.type === 'text-delta') {
        summaryBytes += summaryTextEncoder.encode(part.text).byteLength;
        if (summaryBytes > BOUNDED_MODEL_CONTEXT_LIMITS.maximumSummaryBytes) {
          linked.controller.abort(new Error('context summary exceeded its byte budget'));
          throw new Error('context summary exceeded its byte budget');
        }
      }
    }
  } finally {
    linked.dispose();
  }
  signal.throwIfAborted();
  const result = accumulator.finalize();
  if (result.nativeCalls.length > 0) throw new Error('context summarizer returned a tool call');
  const summary = result.assistantText;
  if (summary.trim().length < 10) throw new Error('context summarizer returned no usable summary');
  return summary;
}

function createLinkedAbortController(parent: AbortSignal): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromParent = () => {
    controller.abort(parent.reason);
  };
  if (parent.aborted) abortFromParent();
  else parent.addEventListener('abort', abortFromParent, { once: true });
  return {
    controller,
    dispose: () => {
      parent.removeEventListener('abort', abortFromParent);
    },
  };
}
