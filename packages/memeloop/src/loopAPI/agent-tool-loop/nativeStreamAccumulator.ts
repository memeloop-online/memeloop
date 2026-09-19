import type { PortableLlmJsonValue } from '../../llm/request.js';
import { assertPortableLlmStreamPart, PORTABLE_LLM_STREAM_LIMITS, type PortableLlmStreamPart, PortableLlmStreamProtocolError } from '../../llm/response.js';

export interface NativeModelToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, PortableLlmJsonValue>;
}

export interface NativeModelStreamResult {
  assistantText: string;
  assistantReasoning: string;
  nativeCalls: NativeModelToolCall[];
  usage?: Readonly<NativeModelUsage>;
}

export interface NativeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface NativeModelTransientToolInput {
  toolCallId: string;
  toolName: string;
  inputBytes: number;
  ended: boolean;
}

export interface NativeModelTransientStreamSnapshot {
  assistantText: string;
  assistantReasoning: string;
  nativeCalls: NativeModelToolCall[];
  activeToolInputs: NativeModelTransientToolInput[];
  textTruncated: boolean;
  reasoningTruncated: boolean;
  toolCallsTruncated: boolean;
}

/**
 * UI-only stream projections are intentionally much smaller than the durable
 * provider result. This keeps IPC/render updates bounded even when the model
 * produces the full 16 MiB portable stream allowance.
 */
export const NATIVE_MODEL_TRANSIENT_STREAM_LIMITS = Object.freeze(
  {
    textBytes: 160 * 1_024,
    reasoningBytes: 64 * 1_024,
    toolCallBytes: 16 * 1_024,
    toolCalls: 16,
    activeToolInputs: 16,
  } as const,
);

interface ToolInputBuffer {
  toolName: string;
  chunks: string[];
  bytes: number;
  ended: boolean;
  parsed?: PortableLlmJsonValue;
}

const textEncoder = new TextEncoder();

class BoundedUtf8Chunks {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private cached = '';
  private dirty = false;
  public truncated = false;

  public constructor(private readonly maximumBytes: number) {}

  /** Returns true only when the bounded UI projection changed. */
  public append(value: string): boolean {
    const remaining = this.maximumBytes - this.bytes;
    if (remaining <= 0) {
      if (value.length === 0 || this.truncated) return false;
      this.truncated = true;
      return true;
    }
    const encoded = textEncoder.encode(value);
    if (encoded.byteLength <= remaining) {
      if (value.length === 0) return false;
      this.chunks.push(value);
      this.bytes += encoded.byteLength;
      this.dirty = true;
      return true;
    }

    // Only the one boundary delta is searched. All later deltas are discarded,
    // so clipping remains linear in the retained projection rather than output.
    let low = 0;
    let high = Math.min(value.length, remaining);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (textEncoder.encode(value.slice(0, middle)).byteLength <= remaining) low = middle;
      else high = middle - 1;
    }
    // Do not retain half of a UTF-16 surrogate pair. TextEncoder would replace
    // it and make the partial differ from the corresponding durable prefix.
    if (
      low > 0 && low < value.length &&
      isHighSurrogate(value.charCodeAt(low - 1)) && isLowSurrogate(value.charCodeAt(low))
    ) low -= 1;
    const prefix = value.slice(0, low);
    if (prefix.length > 0) {
      this.chunks.push(prefix);
      this.bytes += textEncoder.encode(prefix).byteLength;
      this.dirty = true;
    }
    this.truncated = true;
    return true;
  }

  public value(): string {
    if (this.dirty) {
      this.cached = this.chunks.join('');
      this.dirty = false;
    }
    return this.cached;
  }
}

/**
 * Bounded, linear-time assembler for one provider full stream.
 *
 * It deliberately keeps split tool input and final tool-call input independent
 * until both have been validated and compared. A provider cannot change the
 * arguments between the partial and final representations.
 */
export class NativeModelStreamAccumulator {
  private readonly textChunks: string[] = [];
  private readonly reasoningChunks: string[] = [];
  private readonly toolInputs = new Map<string, ToolInputBuffer>();
  private readonly calls: NativeModelToolCall[] = [];
  private readonly callIds = new Set<string>();
  private aggregateBytes = 0;
  private partCount = 0;
  private finished = false;
  private usage?: Readonly<NativeModelUsage>;
  private readonly transientText = new BoundedUtf8Chunks(
    NATIVE_MODEL_TRANSIENT_STREAM_LIMITS.textBytes,
  );
  private readonly transientReasoning = new BoundedUtf8Chunks(
    NATIVE_MODEL_TRANSIENT_STREAM_LIMITS.reasoningBytes,
  );
  private readonly transientCalls: NativeModelToolCall[] = [];
  private transientCallBytes = 0;
  private transientCallsTruncated = false;
  private transientVersionValue = 0;

  /** Monotonic UI projection revision; non-presentational usage/finish parts do not advance it. */
  public get transientVersion(): number {
    return this.transientVersionValue;
  }

  public apply(part: PortableLlmStreamPart): void {
    assertPortableLlmStreamPart(part);
    if (this.finished) throw new Error('model stream emitted data after finish');
    this.partCount += 1;
    if (this.partCount > PORTABLE_LLM_STREAM_LIMITS.parts) {
      throw new Error('model stream exceeds part count limit');
    }

    switch (part.type) {
      case 'text-delta':
        this.consumeBytes(utf8Bytes(part.id) + utf8Bytes(part.text));
        this.textChunks.push(part.text);
        if (this.transientText.append(part.text)) this.transientVersionValue += 1;
        return;
      case 'reasoning-delta':
        this.consumeBytes(utf8Bytes(part.id) + utf8Bytes(part.text));
        this.reasoningChunks.push(part.text);
        if (this.transientReasoning.append(part.text)) this.transientVersionValue += 1;
        return;
      case 'tool-input-start':
        this.consumeBytes(utf8Bytes(part.toolCallId) + utf8Bytes(part.toolName));
        if (this.toolInputs.has(part.toolCallId) || this.callIds.has(part.toolCallId)) {
          throw new Error('duplicate tool input start');
        }
        if (this.toolInputs.size >= PORTABLE_LLM_STREAM_LIMITS.openToolInputs) {
          throw new Error('model stream exceeds open tool input limit');
        }
        this.toolInputs.set(part.toolCallId, {
          toolName: part.toolName,
          chunks: [],
          bytes: 0,
          ended: false,
        });
        this.transientVersionValue += 1;
        return;
      case 'tool-input-delta': {
        const buffer = this.toolInputs.get(part.toolCallId);
        if (!buffer || buffer.ended) throw new Error('tool input delta arrived outside input stream');
        const bytes = utf8Bytes(part.delta);
        buffer.bytes += bytes;
        if (buffer.bytes > PORTABLE_LLM_STREAM_LIMITS.toolInputBytes) {
          throw new Error('tool input stream exceeds bounded JSON size');
        }
        this.consumeBytes(utf8Bytes(part.toolCallId) + bytes);
        buffer.chunks.push(part.delta);
        this.transientVersionValue += 1;
        return;
      }
      case 'tool-input-end': {
        const buffer = this.toolInputs.get(part.toolCallId);
        if (!buffer || buffer.ended) throw new Error('tool input end arrived outside input stream');
        this.consumeBytes(utf8Bytes(part.toolCallId));
        try {
          buffer.parsed = JSON.parse(buffer.chunks.join('')) as PortableLlmJsonValue;
        } catch (error) {
          throw new Error('native tool input is not valid JSON', { cause: error });
        }
        buffer.chunks = [];
        buffer.ended = true;
        this.transientVersionValue += 1;
        return;
      }
      case 'tool-call': {
        if (this.callIds.has(part.toolCallId)) throw new Error('duplicate native toolCallId');
        if (this.calls.length >= PORTABLE_LLM_STREAM_LIMITS.toolCalls) {
          throw new Error('model stream exceeds tool call limit');
        }
        if (part.input === null || typeof part.input !== 'object' || Array.isArray(part.input)) {
          throw new Error('native tool input must be a JSON object');
        }
        const buffer = this.toolInputs.get(part.toolCallId);
        if (buffer) {
          if (
            !buffer.ended || buffer.toolName !== part.toolName ||
            !semanticJsonEqual(buffer.parsed, part.input)
          ) {
            throw new Error('native tool call does not match its streamed input');
          }
          this.toolInputs.delete(part.toolCallId);
        }
        this.consumeBytes(
          utf8Bytes(part.toolCallId) + utf8Bytes(part.toolName) + jsonByteLength(part.input),
        );
        this.callIds.add(part.toolCallId);
        this.calls.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
        const transientBytes = utf8Bytes(part.toolCallId) + utf8Bytes(part.toolName) +
          jsonByteLength(part.input);
        if (
          this.transientCalls.length < NATIVE_MODEL_TRANSIENT_STREAM_LIMITS.toolCalls &&
          this.transientCallBytes + transientBytes <=
            NATIVE_MODEL_TRANSIENT_STREAM_LIMITS.toolCallBytes
        ) {
          this.transientCallBytes += transientBytes;
          this.transientCalls.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: structuredClone(part.input),
          });
        } else {
          this.transientCallsTruncated = true;
        }
        this.transientVersionValue += 1;
        return;
      }
      case 'finish':
        this.consumeBytes(utf8Bytes(part.finishReason));
        this.assertNoDanglingToolInputs();
        this.finished = true;
        return;
      case 'usage':
        if (this.usage !== undefined) {
          throw new PortableLlmStreamProtocolError('LLM_STREAM_DUPLICATE_USAGE');
        }
        this.consumeBytes(128);
        this.usage = Object.freeze({
          ...(part.inputTokens === undefined ? {} : { inputTokens: part.inputTokens }),
          ...(part.outputTokens === undefined ? {} : { outputTokens: part.outputTokens }),
          ...(part.totalTokens === undefined ? {} : { totalTokens: part.totalTokens }),
          ...(part.cachedInputTokens === undefined
            ? {}
            : { cachedInputTokens: part.cachedInputTokens }),
          ...(part.reasoningTokens === undefined
            ? {}
            : { reasoningTokens: part.reasoningTokens }),
        });
        return;
      case 'structured-output':
        throw new Error('text model stream cannot inject structured output');
      case 'tool-result':
        throw new Error('model stream cannot inject tool results');
    }
  }

  public finalize(): NativeModelStreamResult {
    this.assertNoDanglingToolInputs();
    if (!this.finished) throw new PortableLlmStreamProtocolError('LLM_STREAM_TRUNCATED');
    return {
      assistantText: this.textChunks.join(''),
      assistantReasoning: this.reasoningChunks.join(''),
      nativeCalls: this.calls.map(call => ({ ...call, input: { ...call.input } })),
      ...(this.usage === undefined ? {} : { usage: { ...this.usage } }),
    };
  }

  /**
   * Build the current bounded UI projection. It never joins the full durable
   * stream and clones tool inputs so a subscriber cannot mutate final output.
   */
  public transientSnapshot(): NativeModelTransientStreamSnapshot {
    const activeToolInputs: NativeModelTransientToolInput[] = [];
    for (const [toolCallId, buffer] of this.toolInputs) {
      if (activeToolInputs.length >= NATIVE_MODEL_TRANSIENT_STREAM_LIMITS.activeToolInputs) break;
      activeToolInputs.push({
        toolCallId,
        toolName: buffer.toolName,
        inputBytes: buffer.bytes,
        ended: buffer.ended,
      });
    }
    return {
      assistantText: this.transientText.value(),
      assistantReasoning: this.transientReasoning.value(),
      nativeCalls: this.transientCalls.map(call => ({
        ...call,
        input: structuredClone(call.input),
      })),
      activeToolInputs,
      textTruncated: this.transientText.truncated,
      reasoningTruncated: this.transientReasoning.truncated,
      toolCallsTruncated: this.transientCallsTruncated ||
        this.calls.length > this.transientCalls.length ||
        this.toolInputs.size > activeToolInputs.length,
    };
  }

  private consumeBytes(bytes: number): void {
    this.aggregateBytes += bytes;
    if (this.aggregateBytes > PORTABLE_LLM_STREAM_LIMITS.aggregateBytes) {
      throw new Error('model stream exceeds aggregate byte limit');
    }
  }

  private assertNoDanglingToolInputs(): void {
    if (this.toolInputs.size > 0) throw new Error('model stream ended with dangling tool input');
  }
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function jsonByteLength(value: PortableLlmJsonValue): number {
  return utf8Bytes(JSON.stringify(value));
}

function semanticJsonEqual(
  left: PortableLlmJsonValue | undefined,
  right: PortableLlmJsonValue,
): boolean {
  if (typeof left === 'number' && typeof right === 'number') return left === right;
  if (left === null || right === null || typeof left !== typeof right) return left === right;
  if (typeof left !== 'object' || typeof right !== 'object') return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => semanticJsonEqual(item, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] &&
      semanticJsonEqual(left[key], right[key])
    );
}
