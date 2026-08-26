import type { ChatMessage } from 'memeloop';

import {
  DEFAULT_RESIDENT_CONTENT_BYTE_LIMIT,
  DEFAULT_RESIDENT_RENDER_ROW_LIMIT,
  estimateMessageDisplayBytes,
  estimateMessageRenderRows,
  MAX_RESIDENT_CONTENT_BYTE_LIMIT,
  MAX_RESIDENT_RENDER_ROW_LIMIT,
} from './displayBounds.js';

/** Opening a thread should request exactly one bounded page with these limits. */
export const MEMELOOP_INITIAL_MESSAGE_PAGE_LIMIT = 50;
export const MEMELOOP_MESSAGE_PAGE_MAX_BYTES = 256 * 1024;
export const DEFAULT_RESIDENT_MESSAGE_LIMIT = 50;
/** UI hard ceiling. Core storage may use a larger internal page, the DOM may not. */
export const MAX_RESIDENT_MESSAGE_LIMIT = DEFAULT_RESIDENT_MESSAGE_LIMIT;

export function boundedResidentMessages(
  messages: readonly ChatMessage[],
  requestedLimit = DEFAULT_RESIDENT_MESSAGE_LIMIT,
  anchorMessageId?: string,
  requestedContentByteLimit = DEFAULT_RESIDENT_CONTENT_BYTE_LIMIT,
  requestedRenderRowLimit = DEFAULT_RESIDENT_RENDER_ROW_LIMIT,
): readonly ChatMessage[] {
  const limit = Math.max(
    20,
    Math.min(
      Number.isSafeInteger(requestedLimit) ? requestedLimit : DEFAULT_RESIDENT_MESSAGE_LIMIT,
      MAX_RESIDENT_MESSAGE_LIMIT,
    ),
  );
  const rowLimit = Math.max(
    200,
    Math.min(
      Number.isSafeInteger(requestedRenderRowLimit)
        ? requestedRenderRowLimit
        : DEFAULT_RESIDENT_RENDER_ROW_LIMIT,
      MAX_RESIDENT_RENDER_ROW_LIMIT,
    ),
  );
  const byteLimit = Math.max(
    64 * 1024,
    Math.min(
      Number.isSafeInteger(requestedContentByteLimit)
        ? requestedContentByteLimit
        : DEFAULT_RESIDENT_CONTENT_BYTE_LIMIT,
      MAX_RESIDENT_CONTENT_BYTE_LIMIT,
    ),
  );
  const anchorIndex = anchorMessageId
    ? messages.findIndex(message => message.messageId === anchorMessageId)
    : -1;
  const countBounded = anchorIndex < 0
    ? messages.slice(-limit)
    : (() => {
      const start = Math.max(
        0,
        Math.min(
          anchorIndex - Math.floor(limit / 2),
          messages.length - limit,
        ),
      );
      return messages.slice(start, start + limit);
    })();
  if (countBounded.length <= 1) return countBounded;

  const boundedAnchorIndex = anchorMessageId
    ? countBounded.findIndex(message => message.messageId === anchorMessageId)
    : -1;
  if (boundedAnchorIndex < 0) {
    let bytes = 0;
    let rows = 0;
    let start = countBounded.length - 1;
    while (start >= 0) {
      const nextBytes = bytes + estimateMessageDisplayBytes(countBounded[start]);
      const nextRows = rows + estimateMessageRenderRows(countBounded[start]);
      if (start < countBounded.length - 1 && (nextBytes > byteLimit || nextRows > rowLimit)) break;
      bytes = nextBytes;
      rows = nextRows;
      start -= 1;
    }
    return countBounded.slice(start + 1);
  }

  let start = boundedAnchorIndex;
  let end = boundedAnchorIndex + 1;
  let bytes = estimateMessageDisplayBytes(countBounded[boundedAnchorIndex]);
  let rows = estimateMessageRenderRows(countBounded[boundedAnchorIndex]);
  while (start > 0 || end < countBounded.length) {
    const takeBefore = start > 0 && (end >= countBounded.length || boundedAnchorIndex - start <= end - boundedAnchorIndex);
    const candidateIndex = takeBefore ? start - 1 : end;
    const nextBytes = bytes + estimateMessageDisplayBytes(countBounded[candidateIndex]);
    const nextRows = rows + estimateMessageRenderRows(countBounded[candidateIndex]);
    if (nextBytes > byteLimit || nextRows > rowLimit) break;
    bytes = nextBytes;
    rows = nextRows;
    if (takeBefore) start -= 1;
    else end += 1;
  }
  return countBounded.slice(start, end);
}
