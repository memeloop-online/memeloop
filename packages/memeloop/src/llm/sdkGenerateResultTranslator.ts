import { assertPortableLlmStreamPart, type PortableLlmStreamPart } from './response.js';

interface SdkGenerateResult {
  reasoningText?: string;
  text: string;
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
  output: unknown;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails: { cacheReadTokens?: number };
    outputTokenDetails: { reasoningTokens?: number };
  };
  finishReason: string;
  files: readonly unknown[];
  sources: readonly unknown[];
  toolResults: readonly unknown[];
}

/** Internal complete-result projection used when `stream:false`. */
export function toPortableGenerateResultParts(
  result: SdkGenerateResult,
  outputRequested: boolean,
): PortableLlmStreamPart[] {
  if (result.files.length > 0 || result.sources.length > 0 || result.toolResults.length > 0) {
    throw new Error(
      'The non-stream model result contains unsupported files, sources, or executed tool results',
    );
  }
  const parts: PortableLlmStreamPart[] = [];
  if (result.reasoningText !== undefined && result.reasoningText.length > 0) {
    parts.push({ type: 'reasoning-delta', id: 'reasoning-final', text: result.reasoningText });
  }
  if (result.text.length > 0) {
    parts.push({ type: 'text-delta', id: 'text-final', text: result.text });
  }
  for (const call of result.toolCalls) {
    parts.push({
      type: 'tool-call',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input as never,
    });
  }
  if (outputRequested) parts.push({ type: 'structured-output', output: result.output as never });
  parts.push({
    type: 'usage',
    ...(result.usage.inputTokens === undefined
      ? {}
      : { inputTokens: result.usage.inputTokens }),
    ...(result.usage.outputTokens === undefined
      ? {}
      : { outputTokens: result.usage.outputTokens }),
    ...(result.usage.totalTokens === undefined
      ? {}
      : { totalTokens: result.usage.totalTokens }),
    ...(result.usage.inputTokenDetails.cacheReadTokens === undefined
      ? {}
      : { cachedInputTokens: result.usage.inputTokenDetails.cacheReadTokens }),
    ...(result.usage.outputTokenDetails.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: result.usage.outputTokenDetails.reasoningTokens }),
  });
  parts.push({ type: 'finish', finishReason: result.finishReason });
  for (const part of parts) assertPortableLlmStreamPart(part);
  return parts;
}
