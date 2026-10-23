import type { ConversationMessageDetailRange, ConversationMessageListProjection, ConversationMessageReasoningProjection } from 'memeloop';

export const MEMELOOP_REASONING_PAGE_MAX_BYTES = 64 * 1_024;

export interface MemeLoopMessageReasoningRequest {
  offset: number;
  maxBytes: number;
  signal: AbortSignal;
}

/** Shared Core byte-range result; reasoning does not introduce a host DTO. */
export type MemeLoopMessageReasoningPage = ConversationMessageDetailRange;

export type MemeLoopMessageReasoningLoader = (
  message: ConversationMessageListProjection,
  request: MemeLoopMessageReasoningRequest,
) => Promise<MemeLoopMessageReasoningPage>;

export function messageReasoningProjection(
  message: ConversationMessageListProjection,
): ConversationMessageReasoningProjection | undefined {
  return message.reasoning;
}

export function validateMessageReasoningPage(
  value: MemeLoopMessageReasoningPage,
  request: Pick<MemeLoopMessageReasoningRequest, 'offset' | 'maxBytes'>,
): MemeLoopMessageReasoningPage {
  if (!value || typeof value !== 'object') throw new TypeError('invalid message reasoning page');
  if (!value.found) {
    if (Reflect.ownKeys(value).length !== 1) throw new TypeError('invalid message reasoning page');
    return value;
  }
  if (
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['found', 'offset', 'totalBytes', 'bytes'].includes(key)) ||
    value.offset !== request.offset || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < value.offset ||
    // `instanceof` rejects otherwise-valid IPC values from another JavaScript
    // realm (and also made the browser test environment disagree with Node).
    // The brand plus ArrayBuffer view check accepts Uint8Array/Buffer values
    // without accepting wider typed arrays or DataView.
    !(ArrayBuffer.isView(value.bytes) && Object.prototype.toString.call(value.bytes) === '[object Uint8Array]') ||
    value.bytes.byteLength > request.maxBytes ||
    value.offset + value.bytes.byteLength > value.totalBytes ||
    (value.offset < value.totalBytes && value.bytes.byteLength === 0)
  ) throw new TypeError('invalid message reasoning page');
  // A host must return UTF-8-aligned ranges so every page can be rendered and
  // retried independently without retaining decoder state.
  new TextDecoder('utf-8', { fatal: true }).decode(value.bytes);
  return value;
}
