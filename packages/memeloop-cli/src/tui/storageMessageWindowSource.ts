import { type ConversationEventStore, type ConversationMessageCursor, readConversationMessagePage } from 'memeloop';

import { chatMessagesToTUIMessages, projectDisplayText, projectTUIMessageForDisplay } from './messageAdapter.js';
import type { TUIMessagePage, TUIMessagePageRequest, TUIMessageWindowSource } from './messageWindow.js';

type TUIStoragePageReader =
  & Pick<ConversationEventStore, 'getMessagePage'>
  & Partial<Pick<ConversationEventStore, 'getMessageById' | 'getMessageWindowAround'>>;

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
      { limit: 1, maxBytes: request.maxBytes, mode: 'on-demand' },
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
          mode: 'on-demand',
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
        items: chatMessagesToTUIMessages(result.items),
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
          const result = await storage.getMessageWindowAround!(conversationId, {
            focus: request.focus,
            expectedRevision: request.expectedRevision,
            maxMessages: request.maxMessages,
            maxBytes: request.maxBytes,
          }, { signal: options.signal });
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
          const semanticAnchor = result.focus.kind === 'compaction'
            ? projectTUIMessageForDisplay({
              kind: 'compaction',
              id: result.focus.entry.entryId,
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
            items: chatMessagesToTUIMessages(result.items),
            hasMoreBefore: result.hasMoreBefore,
            hasMoreAfter: result.hasMoreAfter,
            ...(previousCursor === undefined ? {} : { previousCursor }),
            ...(nextCursor === undefined ? {} : { nextCursor }),
            ...(semanticAnchor === undefined ? {} : { semanticAnchor }),
          };
        },
      }),
    ...(typeof storage.getMessageById !== 'function'
      ? {}
      : {
        async getMessageDetail(conversationId, messageId, options) {
          options.signal.throwIfAborted();
          const message = await storage.getMessageById!(conversationId, messageId, {
            signal: options.signal,
          });
          options.signal.throwIfAborted();
          if (!message) return '';
          return projectDisplayText(message.content, options.maxBytes).text;
        },
      }),
  };
  return source;
}
