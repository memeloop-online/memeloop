import { assertPortableLlmJsonValue } from './request.js';
import { assertPortableLlmStreamPart, type PortableLlmStreamPart } from './response.js';
import { toPortableToolErrorPart, toPortableToolResultOutput, unsupportedSdkPart } from './sdkStreamTranslator.js';

interface SdkGenerateResult {
  reasoningText?: string;
  reasoning?: readonly unknown[];
  text: string;
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
  content?: readonly unknown[];
  output: unknown;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails: { cacheReadTokens?: number };
    outputTokenDetails: { reasoningTokens?: number };
  };
  finishReason: string;
  files?: readonly unknown[];
  sources?: readonly unknown[];
  toolResults?: readonly unknown[];
}

/** Internal complete-result projection used when `stream:false`. */
export function toPortableGenerateResultParts(
  result: SdkGenerateResult,
  outputRequested: boolean,
): PortableLlmStreamPart[] {
  assertSupportedCompleteResult(result);
  const parts: PortableLlmStreamPart[] = [];
  const reasoningText = result.reasoningText ?? result.reasoning
    ?.filter(isReasoningTextPart)
    .map(part => part.text)
    .join('');
  if (reasoningText !== undefined && reasoningText.length > 0) {
    parts.push({ type: 'reasoning-delta', id: 'reasoning-final', text: reasoningText });
  }
  if (result.text.length > 0) {
    parts.push({ type: 'text-delta', id: 'text-final', text: result.text });
  }
  for (const call of result.toolCalls) {
    assertPortableLlmJsonValue(call.input);
    parts.push({
      type: 'tool-call',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    });
  }
  const contentToolResults = result.content?.filter(isToolOutputPart) ?? [];
  const toolResults = contentToolResults.length > 0
    ? contentToolResults
    : result.toolResults ?? [];
  for (const toolResult of toolResults) {
    parts.push(toPortableCompleteToolResult(toolResult));
  }
  if (outputRequested) {
    assertPortableLlmJsonValue(result.output);
    parts.push({ type: 'structured-output', output: result.output });
  }
  const inputTokenDetails = result.usage.inputTokenDetails ?? {};
  const outputTokenDetails = result.usage.outputTokenDetails ?? {};
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
    ...(inputTokenDetails.cacheReadTokens === undefined
      ? {}
      : { cachedInputTokens: inputTokenDetails.cacheReadTokens }),
    ...(outputTokenDetails.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: outputTokenDetails.reasoningTokens }),
  });
  parts.push({ type: 'finish', finishReason: result.finishReason });
  for (const part of parts) assertPortableLlmStreamPart(part);
  return parts;
}

function assertSupportedCompleteResult(result: SdkGenerateResult): void {
  if ((result.files?.length ?? 0) > 0) {
    throw unsupportedSdkPart('file', 'unsupported files');
  }
  if ((result.sources?.length ?? 0) > 0) {
    throw unsupportedSdkPart('source', 'unsupported sources');
  }
  for (const reasoning of result.reasoning ?? []) {
    if (isPlainRecord(reasoning) && reasoning.type === 'reasoning-file') {
      throw unsupportedSdkPart('reasoning-file');
    }
  }
  for (const part of result.content ?? []) {
    if (!isPlainRecord(part)) throw new TypeError('invalid AI SDK complete-result content part');
    switch (part.type) {
      case 'text':
      case 'reasoning':
      case 'tool-call':
      case 'tool-result':
      case 'tool-error':
        break;
      case 'source':
      case 'file':
      case 'reasoning-file':
      case 'tool-output-denied':
      case 'tool-approval-request':
      case 'tool-approval-response':
      case 'custom':
        throw unsupportedSdkPart(part.type);
      default:
        throw unsupportedSdkPart(typeof part.type === 'string' ? part.type : 'unknown');
    }
  }
}

function isToolOutputPart(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && (value.type === 'tool-result' || value.type === 'tool-error');
}

function isReasoningTextPart(value: unknown): value is { type: 'reasoning'; text: string } {
  return isPlainRecord(value) && value.type === 'reasoning' && typeof value.text === 'string';
}

function toPortableCompleteToolResult(
  value: unknown,
): Extract<PortableLlmStreamPart, { type: 'tool-result' }> {
  if (!isPlainRecord(value)) throw unsupportedSdkPart('tool-result');
  const type = value.type;
  const toolCallId = value.toolCallId;
  const toolName = value.toolName;
  if (typeof toolCallId !== 'string' || typeof toolName !== 'string') {
    throw new TypeError('invalid AI SDK tool result identity');
  }
  if (type === 'tool-error') {
    return toPortableToolErrorPart(value);
  }
  if (type !== 'tool-result') throw unsupportedSdkPart(`tool-result:${String(type)}`);
  return {
    type: 'tool-result',
    toolCallId,
    toolName,
    output: toPortableToolResultOutput(readDataProperty(value, 'output')),
  };
}

function readDataProperty(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined || !descriptor.enumerable ||
    'get' in descriptor || 'set' in descriptor
  ) throw new TypeError(`invalid AI SDK complete-result field '${key}'`);
  return descriptor.value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
