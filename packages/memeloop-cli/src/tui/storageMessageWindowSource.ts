import {
  assertConversationMessageWindowResult,
  type ConversationEventStore,
  type ConversationMessageCursor,
  type ConversationMessageDetailRange,
  readConversationMessagePage,
} from 'memeloop';

import { conversationMessageProjectionsToTUIMessages, projectDisplayText, projectTUIMessageForDisplay } from './messageAdapter.js';
import type { TUIMessagePage, TUIMessagePageRequest, TUIMessageWindowSource } from './messageWindow.js';

type TUIStoragePageReader =
  & Pick<ConversationEventStore, 'getMessagePage'>
  & Partial<Pick<ConversationEventStore, 'getMessageWindowAround' | 'readMessageDetailRange'>>;

const TUI_DETAIL_RANGE_MAX_BYTES = 256 * 1024;

interface StoredCursor {
  readonly conversationId: string;
  readonly revision: string;
  readonly direction: 'backward' | 'forward';
  readonly cursor: Readonly<ConversationMessageCursor>;
}

/**
 * Adapt Core's structured local-storage keysets to opaque TUI cursors. Cursor
 * values stay inside this bounded adapter and are never decoded by the UI.
 */
export function createStorageTUIMessageWindowSource(
  storage: TUIStoragePageReader,
): TUIMessageWindowSource {
  const cursors = new Map<string, StoredCursor>();
  let cursorSequence = 0;

  const issueCursor = (record: StoredCursor): string => {
    cursorSequence += 1;
    const token = `tui-keyset-${cursorSequence.toString(36)}`;
    cursors.set(
      token,
      Object.freeze({
        ...record,
        cursor: Object.freeze({ ...record.cursor }),
      }),
    );
    // A TUI window can expose at most two current cursors. Retain a small
    // navigation frontier without allowing a long session to grow this map.
    if (cursors.size > 256) {
      const oldest = cursors.keys().next().value;
      if (oldest !== undefined) cursors.delete(oldest);
    }
    return token;
  };

  const readCurrentRevision = async (
    conversationId: string,
    request: TUIMessagePageRequest,
    signal: AbortSignal,
  ): Promise<string> => {
    const latest = await readConversationMessagePage(
      storage as ConversationEventStore,
      conversationId,
      { limit: 1, maxBytes: request.maxBytes },
      { signal },
    );
    return latest.revision;
  };

  const source: TUIMessageWindowSource = {
    async getMessagePage(conversationId, request, options): Promise<TUIMessagePage> {
      options.signal.throwIfAborted();
      let storedCursor: StoredCursor | undefined;
      if (request.cursor !== undefined) {
        storedCursor = cursors.get(request.cursor);
        if (
          storedCursor === undefined ||
          storedCursor.conversationId !== conversationId ||
          storedCursor.direction !== request.direction ||
          storedCursor.revision !== request.expectedRevision
        ) {
          return {
            reset: true,
            conversationId,
            revision: await readCurrentRevision(conversationId, request, options.signal),
          };
        }
      }
      const result = await readConversationMessagePage(
        storage as ConversationEventStore,
        conversationId,
        {
          limit: request.limit,
          maxBytes: request.maxBytes,
          ...(storedCursor?.direction === 'backward' ? { before: storedCursor.cursor } : {}),
          ...(storedCursor?.direction === 'forward' ? { after: storedCursor.cursor } : {}),
          ...(request.expectedRevision === undefined
            ? {}
            : { expectedRevision: request.expectedRevision }),
        },
        { signal: options.signal },
      );
      options.signal.throwIfAborted();
      if (result.reset) return result;
      const previousCursor = result.hasMoreBefore && result.startCursor
        ? issueCursor({
          conversationId,
          revision: result.revision,
          direction: 'backward',
          cursor: result.startCursor,
        })
        : undefined;
      const nextCursor = result.hasMoreAfter && result.endCursor
        ? issueCursor({
          conversationId,
          revision: result.revision,
          direction: 'forward',
          cursor: result.endCursor,
        })
        : undefined;
      return {
        reset: false,
        conversationId,
        revision: result.revision,
        items: conversationMessageProjectionsToTUIMessages(result.items),
        hasMoreBefore: result.hasMoreBefore,
        hasMoreAfter: result.hasMoreAfter,
        ...(previousCursor === undefined ? {} : { previousCursor }),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    },
    ...(typeof storage.getMessageWindowAround !== 'function'
      ? {}
      : {
        async getMessageWindowAround(conversationId, request, options) {
          options.signal.throwIfAborted();
          const focus = request.focus.kind === 'turn'
            ? {
              kind: 'message' as const,
              messageId: request.focus.turnId,
              turnId: request.focus.turnId,
              ...(request.focus.cursor === undefined ? {} : { cursor: request.focus.cursor }),
            }
            : request.focus;
          const result = await storage.getMessageWindowAround!(conversationId, {
            focus,
            expectedRevision: request.expectedRevision,
            maxMessages: request.maxMessages,
            maxBytes: request.maxBytes,
          }, { signal: options.signal });
          options.signal.throwIfAborted();
          assertConversationMessageWindowResult(result, conversationId, {
            focus,
            expectedRevision: request.expectedRevision,
            maxMessages: request.maxMessages,
            maxBytes: request.maxBytes,
          });
          if (result.reset) return result;
          const previousCursor = result.hasMoreBefore && result.startCursor
            ? issueCursor({
              conversationId,
              revision: result.revision,
              direction: 'backward',
              cursor: result.startCursor,
            })
            : undefined;
          const nextCursor = result.hasMoreAfter && result.endCursor
            ? issueCursor({
              conversationId,
              revision: result.revision,
              direction: 'forward',
              cursor: result.endCursor,
            })
            : undefined;
          const semanticAnchor = result.focus.kind === 'compaction'
            ? projectTUIMessageForDisplay({
              kind: 'compaction',
              messageId: result.focus.entry.entryId,
              role: 'system',
              content: '',
              timestamp: new Date(result.focus.entry.timestamp),
              compaction: {
                entryId: result.focus.entry.entryId,
                summaryPreview: result.focus.entry.summaryPreview,
                compactedMessageCount: result.focus.entry.compactedMessageCount,
                compactedTurnCount: result.focus.entry.compactedTurnCount,
              },
            })
            : undefined;
          return {
            reset: false as const,
            conversationId,
            revision: result.revision,
            items: conversationMessageProjectionsToTUIMessages(result.items),
            hasMoreBefore: result.hasMoreBefore,
            hasMoreAfter: result.hasMoreAfter,
            ...(previousCursor === undefined ? {} : { previousCursor }),
            ...(nextCursor === undefined ? {} : { nextCursor }),
            ...(semanticAnchor === undefined ? {} : { semanticAnchor }),
          };
        },
      }),
    ...(typeof storage.readMessageDetailRange !== 'function'
      ? {}
      : {
        async getMessageDetail(conversationId, messageId, options) {
          options.signal.throwIfAborted();
          const range = await storage.readMessageDetailRange!(
            conversationId,
            messageId,
            0,
            Math.min(TUI_DETAIL_RANGE_MAX_BYTES, options.maxBytes),
            { signal: options.signal },
          );
          options.signal.throwIfAborted();
          return projectMessageDetailRange(range, options.maxBytes);
        },
      }),
  };
  return source;
}

function projectMessageDetailRange(
  range: ConversationMessageDetailRange,
  maximumBytes: number,
): string {
  if (!range.found) return '';
  const content = extractCanonicalContent(range.bytes);
  const projection = projectDisplayText(content.text, maximumBytes);
  if (content.complete || projection.truncated) return projection.text;
  // The canonical range ended before the content string closed. Preserve a
  // visible omission marker even when the available prefix fits the display
  // budget; callers can use a larger range/export for complete content.
  return projectDisplayText(`${content.text}\n… [detail omitted]`, maximumBytes).text;
}

function extractCanonicalContent(bytes: Uint8Array): { text: string; complete: boolean } {
  let decoded = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = bytes.byteLength; end >= Math.max(0, bytes.byteLength - 3); end -= 1) {
    try {
      decoded = decoder.decode(bytes.subarray(0, end));
      break;
    } catch {
      continue;
    }
  }
  const marker = '"content":';
  const markerIndex = decoded.indexOf(marker);
  if (markerIndex < 0) return { text: '', complete: false };
  const valueStart = markerIndex + marker.length;
  if (decoded[valueStart] !== '"') return { text: '', complete: false };
  let escaped = false;
  for (let index = valueStart + 1; index < decoded.length; index += 1) {
    const character = decoded[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    try {
      return { text: JSON.parse(decoded.slice(valueStart, index + 1)) as string, complete: true };
    } catch {
      return { text: '', complete: false };
    }
  }
  // Decode an incomplete JSON string by trimming a partial escape sequence
  // from the range tail. This never reads beyond the bounded byte window.
  for (let end = decoded.length; end > valueStart + 1 && end >= decoded.length - 8; end -= 1) {
    try {
      return {
        text: JSON.parse(`${decoded.slice(valueStart, end)}"`) as string,
        complete: false,
      };
    } catch {
      continue;
    }
  }
  return { text: '', complete: false };
}
