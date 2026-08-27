/**
 * NativeAgentChatView — React Native chat surface for MemeLoop adapters.
 *
 * Built on react-native-gifted-chat so we don't re-implement message bubbles,
 * composer, avatars, typing indicators or scroll behaviour.
 */

import type { ChatMessage } from 'memeloop';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Optional peer resolved by React Native hosts and shimmed for package builds.

import { FlatList, I18nManager, Image, Modal, Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { GiftedChat, type IMessage, type User } from 'react-native-gifted-chat';
import { useTheme } from 'react-native-paper';

import { type MemeLoopAttachmentPolicy, MemeLoopAttachmentValidationError, type MemeLoopFileAttachment, validateWebFileAttachment } from '../chat/attachmentValidation.js';
import { normalizeMemeLoopChatError } from '../chat/coreTypes.js';
import type {
  ConversationTimelineLabels,
  MemeLoopAttachmentSelectionContext,
  MemeLoopChatAdapter,
  MemeLoopChatErrorPresentation,
  MemeLoopChatOperation,
  MemeLoopSendMessageInput,
} from '../chat/coreTypes.js';
import { boundMessageForDisplay, getDisplayTruncation, resolveDisplayTruncationAction } from '../chat/displayBounds.js';
import { formatMessageDetailPage, MEMELOOP_MESSAGE_DETAIL_LIMIT, MEMELOOP_MESSAGE_DETAIL_MAX_BYTES, validateMessageDetailPage } from '../chat/messageDetail.js';
import { boundedResidentMessages } from '../chat/residentWindow.js';
import { boundedTimelinePageItems } from '../chat/timelineSampling.js';
import {
  imageAttachmentReferences,
  MEMELOOP_VISIBLE_ATTACHMENT_MAX_BYTES,
  MEMELOOP_VISIBLE_ATTACHMENT_MAX_COUNT,
  messageHydrationIdentity,
  messageHydrationRevision,
  messageNeedsVisibleAttachmentHydration,
} from '../chat/visibleAttachmentHydration.js';
import type { MemeLoopVisibleAttachmentHydrationResult } from '../chat/visibleAttachmentHydration.js';
import { subscribeVisibleAttachmentHydration } from '../chat/visibleAttachmentHydrationStore.js';
import { type NativeAgentChatLabels, resolveNativeAgentChatLabels, resolveNativeTimelineLabels } from './agentChatLabels.js';
import { invertedMessageIndex } from './chatNavigation.js';

export interface NativeAgentChatViewProps {
  adapter: NativeMemeLoopChatAdapter;
  title?: string;
  placeholder?: string;
  emptyMessage?: string;
  loadingMessage?: string;
  disabled?: boolean;
  renderMessageContent?: (message: ChatMessage, isUser: boolean) => React.ReactNode;
  labels?: Partial<NativeAgentChatLabels>;
  timelineLabels?: Partial<ConversationTimelineLabels>;
  resolveErrorPresentation: (value: Error | ChatMessage) => MemeLoopChatErrorPresentation | null;
  genericErrorPresentation: MemeLoopChatErrorPresentation;
  onErrorAction?: (presentation: MemeLoopChatErrorPresentation) => Promise<void>;
  /** Host-owned system picker. A cancelled picker resolves to `undefined`. */
  pickAttachment?: (
    context: MemeLoopAttachmentSelectionContext,
  ) => Promise<NativeMemeLoopFileAttachment | undefined>;
  /** Releases picker-owned temporary URIs after remove, replace, send or disposal. */
  releaseAttachment?: (attachment: NativeMemeLoopFileAttachment) => Promise<void> | void;
  attachmentPolicy?: MemeLoopAttachmentPolicy;
}

/** Immutable descriptor for a Native host-owned local file/content URI. */
export interface NativeMemeLoopFileAttachment extends MemeLoopFileAttachment {
  filename: string;
  uri: string;
}

export interface NativeMemeLoopSendMessageInput extends MemeLoopSendMessageInput {
  file?: NativeMemeLoopFileAttachment;
}

export type NativeMemeLoopChatAdapter = Omit<MemeLoopChatAdapter, 'sendMessage'> & {
  sendMessage: (input: NativeMemeLoopSendMessageInput) => Promise<void>;
};

interface ActiveMessageExport {
  controller: AbortController;
  generation: number;
  token: symbol;
}

interface ActiveTimelineOperation {
  controller: AbortController;
  generation: number;
  token: symbol;
}

interface ActiveDetailRequest {
  controller: AbortController;
  messageId: string;
  token: symbol;
}

interface ActiveAttachmentPicker {
  controller: AbortController;
  generation: number;
  token: symbol;
}

function toGiftedMessage(message: ChatMessage, labels: NativeAgentChatLabels): IMessage {
  const isUser = message.role === 'user';
  const truncation = getDisplayTruncation(message);
  return {
    _id: message.messageId,
    text: truncation
      ? `${message.content}\n\n${labels.truncatedMessage(truncation.originalCharacterCount)}`
      : message.content,
    createdAt: message.timestamp,
    user: {
      _id: isUser ? 'user' : 'agent',
      name: isUser ? labels.user : labels.agent,
    } satisfies User,
  };
}

interface ActiveAttachmentHydration {
  key: string;
  release: () => void;
  token: symbol;
}

interface NativeViewToken {
  isViewable?: boolean;
  item?: IMessage;
}

function findTurnId(messages: readonly ChatMessage[], giftedId: string): string | undefined {
  return messages.find(message => message.messageId === giftedId)?.turnId;
}

export function NativeAgentChatView({
  adapter,
  title,
  placeholder = 'Type a message...',
  emptyMessage = 'Start a conversation',
  loadingMessage = 'Loading conversation',
  disabled = false,
  renderMessageContent,
  labels: labelsInput,
  timelineLabels: timelineLabelsInput,
  resolveErrorPresentation,
  genericErrorPresentation,
  onErrorAction,
  pickAttachment,
  releaseAttachment,
  attachmentPolicy,
}: NativeAgentChatViewProps): React.ReactElement {
  const [detail, setDetail] = useState<{ messageId: string; text: string } | undefined>(undefined);
  const [localError, setLocalError] = useState<Error | undefined>(undefined);
  const [selectedTimelineEntryIndex, setSelectedTimelineEntryIndex] = useState<number | undefined>(undefined);
  const [timelineSeekValue, setTimelineSeekValue] = useState('');
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [visibleMessageIds, setVisibleMessageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [attachmentHydration, setAttachmentHydration] = useState<ReadonlyMap<string, MemeLoopVisibleAttachmentHydrationResult>>(() => new Map());
  const [selectedAttachment, setSelectedAttachment] = useState<NativeMemeLoopFileAttachment | undefined>(undefined);
  const [attachmentPickerPending, setAttachmentPickerPending] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const timelineGenerationReference = useRef(0);
  const activeTimelineOperationReference = useRef<ActiveTimelineOperation | undefined>(undefined);
  const exportGenerationReference = useRef(0);
  const activeMessageExportReference = useRef<ActiveMessageExport | undefined>(undefined);
  const detailGenerationReference = useRef(0);
  const activeDetailRequestReference = useRef<ActiveDetailRequest | undefined>(undefined);
  const activeAttachmentHydrationReference = useRef(new Map<string, ActiveAttachmentHydration>());
  const attachmentSelectionGenerationReference = useRef(0);
  const activeAttachmentPickerReference = useRef<ActiveAttachmentPicker | undefined>(undefined);
  const selectedAttachmentReference = useRef<NativeMemeLoopFileAttachment | undefined>(undefined);
  const releasedAttachmentReference = useRef(new WeakSet());
  const releaseSelectedAttachmentReference = useRef<(attachment: NativeMemeLoopFileAttachment, reportFailure?: boolean) => void>(() => {});
  const messageListReference = useRef<{ scrollToIndex: (options: { animated?: boolean; index: number; viewPosition?: number }) => void }>(null);
  const { colors } = useTheme();
  const { fontScale, width } = useWindowDimensions();
  const compactLayout = width < 480 || fontScale >= 1.3;
  const largeText = fontScale >= 1.3;
  const logicalRowDirection = I18nManager.isRTL ? 'row-reverse' : 'row';
  const labels = useMemo(() => resolveNativeAgentChatLabels(labelsInput), [labelsInput]);
  const timelineLabels = useMemo(() => resolveNativeTimelineLabels(timelineLabelsInput), [timelineLabelsInput]);
  const residentMessages = useMemo(() =>
    boundedResidentMessages(
      adapter.messages,
      adapter.residentMessageLimit,
      adapter.windowAnchorMessageId,
      adapter.residentContentByteLimit,
      adapter.residentRenderRowLimit,
    ).map(message => boundMessageForDisplay(message)), [
    adapter.messages,
    adapter.residentContentByteLimit,
    adapter.residentMessageLimit,
    adapter.residentRenderRowLimit,
    adapter.windowAnchorMessageId,
  ]);
  const hydratedResidentMessages = useMemo(() =>
    residentMessages.map(message => {
      const hydrated = attachmentHydration.get(message.messageId);
      if (!hydrated || hydrated.attachments.length === 0) return message;
      const references = new Map((message.attachments ?? []).map(reference => [reference.contentHash, reference] as const));
      for (const item of hydrated.attachments) references.set(item.reference.contentHash, item.reference);
      return { ...message, attachments: [...references.values()] };
    }), [attachmentHydration, residentMessages]);
  const messages = useMemo(() => hydratedResidentMessages.map(message => toGiftedMessage(message, labels)).reverse(), [hydratedResidentMessages, labels]);
  const messageById = useMemo(() => new Map(hydratedResidentMessages.map(message => [message.messageId, message])), [hydratedResidentMessages]);
  const windowAnchorTurnId = adapter.windowAnchorTurnId ??
    residentMessages.find(message => message.messageId === adapter.windowAnchorMessageId)?.turnId;
  const timelineEntries = useMemo(() => boundedTimelinePageItems(adapter.timeline?.items ?? []), [adapter.timeline?.items]);
  const activeTimelineEntry = timelineEntries.find(entry => entry.entryIndex === selectedTimelineEntryIndex) ??
    timelineEntries.find(entry => entry.kind === 'turn' && entry.turnId === windowAnchorTurnId) ??
    timelineEntries.at(-1);

  const reportOperationError = useCallback((error: unknown, operation: MemeLoopChatOperation) => {
    const normalized = normalizeMemeLoopChatError(error);
    setLocalError(normalized);
    try {
      adapter.onError?.(normalized, operation);
    } catch {
      // An error observer must never create another unhandled UI failure.
    }
  }, [adapter]);

  const reportAttachmentError = useCallback((error: unknown) => {
    const normalized = error instanceof MemeLoopAttachmentValidationError ? error : normalizeMemeLoopChatError(error);
    setLocalError(normalized);
    try {
      adapter.onError?.(normalized, 'select-attachment');
    } catch {
      // Attachment diagnostics remain notifications, never UI failures.
    }
  }, [adapter]);

  const releaseAllAttachmentHydration = useCallback(() => {
    for (const active of activeAttachmentHydrationReference.current.values()) active.release();
    activeAttachmentHydrationReference.current.clear();
  }, []);

  useEffect(() => {
    releaseAllAttachmentHydration();
    setAttachmentHydration(new Map());
    return () => {
      releaseAllAttachmentHydration();
    };
  }, [adapter.conversationId, adapter.loadVisibleAttachments, releaseAllAttachmentHydration]);

  useEffect(() => {
    const loader = adapter.loadVisibleAttachments;
    const targets = new Map<string, ChatMessage>();
    if (loader) {
      for (const messageId of visibleMessageIds) {
        const message = residentMessages.find(candidate => candidate.messageId === messageId);
        if (message && messageNeedsVisibleAttachmentHydration(message)) targets.set(messageId, message);
      }
    }
    for (const [messageId, active] of activeAttachmentHydrationReference.current) {
      const message = targets.get(messageId);
      const key = message ? messageHydrationRevision(message, adapter.timeline?.revision) : undefined;
      if (key === active.key) continue;
      active.release();
      activeAttachmentHydrationReference.current.delete(messageId);
      setAttachmentHydration(current => {
        if (!current.has(messageId)) return current;
        const next = new Map(current);
        next.delete(messageId);
        return next;
      });
    }
    if (!loader) return;
    for (const [messageId, message] of targets) {
      const revision = messageHydrationRevision(message, adapter.timeline?.revision);
      if (activeAttachmentHydrationReference.current.has(messageId)) continue;
      const token = Symbol(messageId);
      const references = imageAttachmentReferences(message);
      const active: ActiveAttachmentHydration = { key: revision, release: () => {}, token };
      active.release = subscribeVisibleAttachmentHydration(
        loader,
        {
          message,
          identity: messageHydrationIdentity(message),
          revision,
          references,
          referencesOmitted: references.length === 0 && messageNeedsVisibleAttachmentHydration(message),
          maxCount: MEMELOOP_VISIBLE_ATTACHMENT_MAX_COUNT,
          maxBytes: MEMELOOP_VISIBLE_ATTACHMENT_MAX_BYTES,
        },
        {
          result: value => {
            if (activeAttachmentHydrationReference.current.get(messageId)?.token !== token) return;
            // React Native consumes only verified host-owned URI descriptors.
            // Byte sources remain useful to Web but are never base64 materialized.
            const uriAttachments = value?.attachments.filter(item => item.source.kind === 'uri') ?? [];
            setAttachmentHydration(current => {
              const next = new Map(current);
              if (value && uriAttachments.length > 0) next.set(messageId, { ...value, attachments: uriAttachments });
              else next.delete(messageId);
              return next;
            });
          },
          error: error => {
            if (activeAttachmentHydrationReference.current.get(messageId)?.token !== token) return;
            reportOperationError(error, 'load-visible-attachments');
          },
        },
      );
      activeAttachmentHydrationReference.current.set(messageId, active);
    }
  }, [adapter.loadVisibleAttachments, adapter.timeline?.revision, reportOperationError, residentMessages, visibleMessageIds]);

  const onViewableItemsChanged = useCallback((input: { viewableItems?: readonly NativeViewToken[] }) => {
    const next = new Set<string>();
    for (const token of input.viewableItems ?? []) {
      if (!token.isViewable || typeof token.item?._id !== 'string') continue;
      next.add(token.item._id);
    }
    setVisibleMessageIds(next);
  }, []);

  const runOperation = useCallback(async (
    operation: MemeLoopChatOperation,
    callback: () => Promise<void>,
  ): Promise<boolean> => {
    setLocalError(undefined);
    try {
      await callback();
      return true;
    } catch (error) {
      reportOperationError(error, operation);
      return false;
    }
  }, [reportOperationError]);

  const releaseSelectedAttachment = useCallback((attachment: NativeMemeLoopFileAttachment, reportFailure = true) => {
    if (!releaseAttachment || releasedAttachmentReference.current.has(attachment)) return;
    releasedAttachmentReference.current.add(attachment);
    void Promise.resolve().then(() => releaseAttachment(attachment)).catch((error: unknown) => {
      if (reportFailure) reportAttachmentError(error);
    });
  }, [releaseAttachment, reportAttachmentError]);
  releaseSelectedAttachmentReference.current = releaseSelectedAttachment;

  const replaceSelectedAttachment = useCallback((next: NativeMemeLoopFileAttachment | undefined, reportReleaseFailure = true) => {
    const previous = selectedAttachmentReference.current;
    selectedAttachmentReference.current = next;
    setSelectedAttachment(next);
    if (previous && previous !== next) releaseSelectedAttachment(previous, reportReleaseFailure);
  }, [releaseSelectedAttachment]);

  const abortActiveAttachmentPicker = useCallback(() => {
    const active = activeAttachmentPickerReference.current;
    if (!active) return;
    activeAttachmentPickerReference.current = undefined;
    if (!active.controller.signal.aborted) active.controller.abort(new Error('native attachment picker superseded'));
    setAttachmentPickerPending(false);
  }, []);

  const startAttachmentPicker = useCallback(() => {
    if (!pickAttachment || disabled || adapter.isLoading || adapter.isRunning || sendPending) return;
    abortActiveAttachmentPicker();
    const operation: ActiveAttachmentPicker = {
      controller: new AbortController(),
      generation: attachmentSelectionGenerationReference.current,
      token: Symbol('native-attachment-picker'),
    };
    activeAttachmentPickerReference.current = operation;
    setAttachmentPickerPending(true);
    void Promise.resolve()
      .then(() => pickAttachment(Object.freeze({ conversationId: adapter.conversationId, signal: operation.controller.signal })))
      .then(value => {
        if (!value) return;
        if (
          operation.controller.signal.aborted ||
          operation.generation !== attachmentSelectionGenerationReference.current ||
          activeAttachmentPickerReference.current?.token !== operation.token
        ) {
          releaseSelectedAttachment(value, false);
          return;
        }
        try {
          validateWebFileAttachment(value, 0, attachmentPolicy);
        } catch (error) {
          releaseSelectedAttachment(value, false);
          throw error;
        }
        const next = Object.freeze({
          filename: value.filename,
          size: value.size,
          type: value.type,
          uri: value.uri,
        });
        replaceSelectedAttachment(next);
        setLocalError(undefined);
      })
      .catch((error: unknown) => {
        if (
          operation.controller.signal.aborted ||
          operation.generation !== attachmentSelectionGenerationReference.current ||
          activeAttachmentPickerReference.current?.token !== operation.token
        ) return;
        reportAttachmentError(error);
      })
      .finally(() => {
        if (activeAttachmentPickerReference.current?.token !== operation.token) return;
        activeAttachmentPickerReference.current = undefined;
        setAttachmentPickerPending(false);
      });
  }, [
    abortActiveAttachmentPicker,
    adapter.conversationId,
    adapter.isLoading,
    adapter.isRunning,
    attachmentPolicy,
    disabled,
    pickAttachment,
    releaseSelectedAttachment,
    replaceSelectedAttachment,
    reportAttachmentError,
    sendPending,
  ]);

  const abortActiveTimelineOperation = useCallback(() => {
    const active = activeTimelineOperationReference.current;
    if (!active) return;
    activeTimelineOperationReference.current = undefined;
    if (!active.controller.signal.aborted) active.controller.abort();
  }, []);

  const runTimelineOperation = useCallback((
    operation: MemeLoopChatOperation,
    callback: (signal: AbortSignal) => Promise<void>,
  ) => {
    abortActiveTimelineOperation();
    const active: ActiveTimelineOperation = {
      controller: new AbortController(),
      generation: timelineGenerationReference.current,
      token: Symbol(operation),
    };
    activeTimelineOperationReference.current = active;
    setLocalError(undefined);
    void Promise.resolve()
      .then(() => {
        active.controller.signal.throwIfAborted();
        return callback(active.controller.signal);
      })
      .catch((error: unknown) => {
        if (
          active.controller.signal.aborted ||
          active.generation !== timelineGenerationReference.current ||
          activeTimelineOperationReference.current?.token !== active.token
        ) return;
        reportOperationError(error, operation);
      })
      .finally(() => {
        if (activeTimelineOperationReference.current?.token === active.token) {
          activeTimelineOperationReference.current = undefined;
        }
      });
  }, [abortActiveTimelineOperation, reportOperationError]);

  const abortActiveMessageExport = useCallback(() => {
    const active = activeMessageExportReference.current;
    if (!active) return;
    activeMessageExportReference.current = undefined;
    if (!active.controller.signal.aborted) active.controller.abort();
  }, []);

  const abortActiveDetailRequest = useCallback(() => {
    const active = activeDetailRequestReference.current;
    if (!active) return;
    activeDetailRequestReference.current = undefined;
    if (!active.controller.signal.aborted) active.controller.abort();
  }, []);

  const exportMessage = useCallback((messageId: string) => {
    if (!adapter.exportMessage) return;
    abortActiveMessageExport();
    const operation: ActiveMessageExport = {
      controller: new AbortController(),
      generation: exportGenerationReference.current,
      token: Symbol(messageId),
    };
    activeMessageExportReference.current = operation;
    void Promise.resolve()
      .then(() => {
        operation.controller.signal.throwIfAborted();
        return adapter.exportMessage!(messageId, { signal: operation.controller.signal });
      })
      .catch((error: unknown) => {
        if (
          operation.controller.signal.aborted ||
          operation.generation !== exportGenerationReference.current ||
          activeMessageExportReference.current?.token !== operation.token
        ) return;
        reportOperationError(error, 'export-message');
      })
      .finally(() => {
        if (activeMessageExportReference.current?.token === operation.token) {
          activeMessageExportReference.current = undefined;
        }
      });
  }, [abortActiveMessageExport, adapter, reportOperationError]);

  useEffect(() => {
    const selectedEntry = timelineEntries.find(entry => entry.entryIndex === selectedTimelineEntryIndex);
    const targetTurnId = selectedEntry?.kind === 'turn' ? selectedEntry.turnId : windowAnchorTurnId;
    const targetMessageId = residentMessages.find(message => message.turnId === targetTurnId)?.messageId;
    const index = invertedMessageIndex(residentMessages, targetMessageId);
    if (index < 0) return;
    try {
      messageListReference.current?.scrollToIndex({ animated: true, index, viewPosition: 0.5 });
    } catch {
      // GiftedChat will retry naturally on the next resident-window update.
    }
  }, [residentMessages, selectedTimelineEntryIndex, timelineEntries, windowAnchorTurnId]);

  useEffect(() => {
    timelineGenerationReference.current += 1;
    abortActiveTimelineOperation();
    exportGenerationReference.current += 1;
    abortActiveMessageExport();
    detailGenerationReference.current += 1;
    abortActiveDetailRequest();
    setDetail(undefined);
    setLocalError(undefined);
    setSelectedTimelineEntryIndex(undefined);
    setTimelineOpen(false);
    setTimelineSeekValue('');
    setVisibleMessageIds(new Set());
    setAttachmentHydration(new Map());
    attachmentSelectionGenerationReference.current += 1;
    abortActiveAttachmentPicker();
    const previousAttachment = selectedAttachmentReference.current;
    selectedAttachmentReference.current = undefined;
    setSelectedAttachment(undefined);
    if (previousAttachment) releaseSelectedAttachmentReference.current(previousAttachment, false);
    setSendPending(false);
    return () => {
      timelineGenerationReference.current += 1;
      abortActiveTimelineOperation();
      exportGenerationReference.current += 1;
      abortActiveMessageExport();
      abortActiveDetailRequest();
      attachmentSelectionGenerationReference.current += 1;
      abortActiveAttachmentPicker();
      const attachment = selectedAttachmentReference.current;
      selectedAttachmentReference.current = undefined;
      if (attachment) releaseSelectedAttachmentReference.current(attachment, false);
    };
  }, [abortActiveAttachmentPicker, abortActiveDetailRequest, abortActiveMessageExport, abortActiveTimelineOperation, adapter.conversationId]);

  useEffect(() => {
    const residentIds = new Set(messageById.keys());
    const active = activeDetailRequestReference.current;
    if (active && !residentIds.has(active.messageId)) abortActiveDetailRequest();
    setDetail(current => current && residentIds.has(current.messageId) ? current : undefined);
  }, [abortActiveDetailRequest, messageById]);

  const handleSend = useCallback(
    (giftedMessages: IMessage[]) => {
      const text = giftedMessages[0]?.text ?? '';
      const attachment = selectedAttachmentReference.current;
      if (!text.trim() && !attachment) return;
      setSendPending(true);
      void runOperation('send-message', () =>
        adapter.sendMessage({
          text,
          ...(attachment ? { file: attachment } : {}),
        })).then(sent => {
          if (sent && attachment && selectedAttachmentReference.current === attachment) {
            replaceSelectedAttachment(undefined);
          }
        }).finally(() => {
          setSendPending(false);
        });
    },
    [adapter, replaceSelectedAttachment, runOperation],
  );

  const handleLongPress = useCallback(
    (_context: unknown, giftedMessage: IMessage) => {
      const turnId = findTurnId(residentMessages, giftedMessage._id);
      if (!turnId) return;
      void runOperation('retry-turn', () => adapter.retryTurn(turnId));
    },
    [adapter, residentMessages, runOperation],
  );

  const handleDelete = useCallback(
    (giftedMessage: IMessage) => {
      const turnId = findTurnId(residentMessages, giftedMessage._id);
      if (!turnId) return;
      void runOperation('delete-turn', () => adapter.deleteTurn(turnId));
    },
    [adapter, residentMessages, runOperation],
  );

  const handleTargetChange = useCallback(
    (targetId: string) => {
      if (!adapter.setExecutionTarget) return;
      void runOperation('set-execution-target', () => adapter.setExecutionTarget!(targetId, { restartCurrentTurn: adapter.isRunning }));
    },
    [adapter, runOperation],
  );

  const renderFooter = useCallback(
    (props: { currentMessage?: IMessage }) => {
      const giftedMessage = props.currentMessage;
      if (!giftedMessage) return null;
      const message = messageById.get(giftedMessage._id);
      if (!message) return null;
      const imagePreviews = attachmentHydration.get(message.messageId)?.attachments.map(item => {
        if (item.source.kind !== 'uri') return null;
        return (
          <Image
            key={item.reference.contentHash}
            source={{ uri: item.source.uri }}
            accessibilityLabel={labels.attachment(item.reference.filename)}
            resizeMode='contain'
            style={{ width: '100%', height: compactLayout ? 180 : 280, marginBottom: 8, borderRadius: 8 }}
          />
        );
      });
      const truncationAction = resolveDisplayTruncationAction(message, {
        detail: adapter.loadMessageDetail !== undefined,
        export: adapter.exportMessage !== undefined,
      });
      if (truncationAction === 'export' && adapter.exportMessage) {
        return (
          <>
            {imagePreviews}
            <View style={{ paddingHorizontal: 8, paddingBottom: 4 }}>
              <Pressable
                accessibilityRole='button'
                accessibilityLabel={labels.exportFullMessage}
                onPress={() => {
                  exportMessage(message.messageId);
                }}
                style={{ minHeight: 44, justifyContent: 'center' }}
              >
                <Text style={{ color: colors.primary, fontSize: 12 }}>{labels.exportFullMessage}</Text>
              </Pressable>
            </View>
          </>
        );
      }
      if (!adapter.loadMessageDetail || (!message.detailRef && truncationAction !== 'detail')) return imagePreviews;
      const loaded = detail?.messageId === message.messageId ? detail.text : undefined;
      return (
        <>
          {imagePreviews}
          <View style={{ paddingHorizontal: 8, paddingBottom: 4 }}>
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={loaded ? labels.reloadDetails : labels.loadDetails}
              onPress={() => {
                const generation = detailGenerationReference.current;
                abortActiveDetailRequest();
                setDetail(undefined);
                const request: ActiveDetailRequest = {
                  controller: new AbortController(),
                  messageId: message.messageId,
                  token: Symbol(message.messageId),
                };
                activeDetailRequestReference.current = request;
                void Promise.resolve().then(() =>
                  adapter.loadMessageDetail?.(message, {
                    limit: MEMELOOP_MESSAGE_DETAIL_LIMIT,
                    maxBytes: MEMELOOP_MESSAGE_DETAIL_MAX_BYTES,
                    signal: request.controller.signal,
                  })
                ).then(payload => {
                  if (
                    generation !== detailGenerationReference.current || request.controller.signal.aborted ||
                    activeDetailRequestReference.current?.token !== request.token
                  ) return;
                  setLocalError(undefined);
                  const page = payload === null || payload === undefined ? undefined : validateMessageDetailPage(payload);
                  const formatted = page && formatMessageDetailPage(page);
                  const text = !formatted || formatted.text.length === 0
                    ? labels.noDetails
                    : `${formatted.text}${formatted.displayTruncated ? `\n\n${labels.detailTruncated}` : ''}`;
                  if (generation === detailGenerationReference.current) setDetail({ messageId: message.messageId, text });
                }).catch((error: unknown) => {
                  if (
                    generation !== detailGenerationReference.current || request.controller.signal.aborted ||
                    activeDetailRequestReference.current?.token !== request.token
                  ) return;
                  reportOperationError(error, 'load-detail');
                  setDetail({ messageId: message.messageId, text: labels.noDetails });
                }).finally(() => {
                  if (activeDetailRequestReference.current?.token === request.token) activeDetailRequestReference.current = undefined;
                });
              }}
              style={{ minHeight: 44, justifyContent: 'center' }}
            >
              <Text style={{ color: colors.primary, fontSize: 12 }}>{loaded ? labels.reloadDetails : labels.loadDetails}</Text>
            </Pressable>
            {loaded && <Text style={{ fontSize: 12, color: colors.onSurface }}>{loaded}</Text>}
          </View>
        </>
      );
    },
    [abortActiveDetailRequest, adapter, attachmentHydration, colors.onSurface, colors.primary, compactLayout, detail, exportMessage, labels, messageById, reportOperationError],
  );

  const renderGiftedMessageText = useCallback((props: { currentMessage?: IMessage }) => {
    const giftedMessage = props.currentMessage;
    if (!giftedMessage) return null;
    const message = messageById.get(giftedMessage._id);
    if (!message) return null;
    const presentation = resolveErrorPresentation(message) ??
      (message.role === 'error' ? genericErrorPresentation : null);
    if (presentation) {
      return (
        <View style={{ paddingHorizontal: 10, paddingVertical: 6 }}>
          <Text accessibilityRole='alert' style={{ color: colors.error, fontWeight: '600' }}>{presentation.title}</Text>
          <Text style={{ color: colors.onSurface }}>{presentation.message}</Text>
          {presentation.diagnosticId && <Text style={{ color: colors.onSurfaceVariant }}>{labels.diagnosticId(presentation.diagnosticId)}</Text>}
          {presentation.actionLabel && onErrorAction && (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={presentation.actionLabel}
              onPress={() => {
                void runOperation('configure-error', () => onErrorAction(presentation));
              }}
              style={{ minHeight: 44, justifyContent: 'center' }}
            >
              <Text style={{ color: colors.primary }}>{presentation.actionLabel}</Text>
            </Pressable>
          )}
        </View>
      );
    }
    if (!renderMessageContent) {
      return (
        <View style={{ paddingHorizontal: 10, paddingVertical: 6 }}>
          <Text style={{ color: message.role === 'user' ? colors.onPrimary : colors.onSurface }}>{giftedMessage.text}</Text>
        </View>
      );
    }
    return (
      <View style={{ paddingHorizontal: 10, paddingVertical: 6 }}>
        {renderMessageContent(message, message.role === 'user')}
      </View>
    );
  }, [colors, genericErrorPresentation, labels, messageById, onErrorAction, renderMessageContent, resolveErrorPresentation, runOperation]);

  const displayedError = adapter.error ?? localError;
  const errorPresentation = displayedError
    ? resolveErrorPresentation(displayedError) ?? genericErrorPresentation
    : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {title && <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: '600', paddingHorizontal: 12, paddingVertical: 8 }}>{title}</Text>}
      {adapter.executionTargets && adapter.setExecutionTarget && adapter.executionTargets.length > 1 && (
        <View style={{ flexDirection: logicalRowDirection, flexWrap: 'wrap', gap: 8, padding: 8 }}>
          {adapter.executionTargets.map(target => (
            <Pressable
              key={target.id}
              disabled={target.disabled}
              onPress={() => {
                handleTargetChange(target.id);
              }}
              accessibilityRole='button'
              accessibilityLabel={target.label}
              accessibilityState={{ disabled: target.disabled, selected: target.id === adapter.activeExecutionTargetId }}
              style={{
                minHeight: 44,
                justifyContent: 'center',
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                backgroundColor: target.id === adapter.activeExecutionTargetId ? colors.primary : colors.surfaceVariant,
              }}
            >
              <Text style={{ color: target.id === adapter.activeExecutionTargetId ? colors.onPrimary : colors.onSurfaceVariant }}>{target.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {adapter.isLoading
        ? <Text style={{ color: colors.onSurface, textAlign: 'center', padding: 12 }}>{loadingMessage}</Text>
        : residentMessages.length === 0 && <Text style={{ color: colors.onSurface, textAlign: 'center', padding: 12 }}>{emptyMessage}</Text>}
      {displayedError && (
        <View accessibilityRole='alert' style={{ paddingHorizontal: 12, paddingVertical: 6 }}>
          <Text style={{ color: colors.error, fontWeight: '600' }}>{errorPresentation?.title}</Text>
          <Text style={{ color: colors.error }}>{errorPresentation?.message}</Text>
          {errorPresentation?.diagnosticId && <Text style={{ color: colors.onSurfaceVariant }}>{labels.diagnosticId(errorPresentation.diagnosticId)}</Text>}
        </View>
      )}
      {errorPresentation?.actionLabel && onErrorAction && (
        <Pressable
          accessibilityRole='button'
          accessibilityLabel={errorPresentation.actionLabel}
          onPress={() => {
            void runOperation('configure-error', () => onErrorAction(errorPresentation));
          }}
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 }}
        >
          <Text style={{ color: colors.primary }}>{errorPresentation.actionLabel}</Text>
        </Pressable>
      )}
      <GiftedChat
        forwardRef={messageListReference}
        messages={messages}
        onSend={handleSend}
        user={{ _id: 'user' }}
        placeholder={adapter.isRunning ? labels.waitingPlaceholder : placeholder}
        isTyping={adapter.isRunning}
        onLongPress={handleLongPress}
        renderCustomView={renderFooter}
        renderMessageText={renderGiftedMessageText}
        onDelete={handleDelete}
        textInputProps={{ editable: !disabled && !adapter.isLoading && !sendPending }}
        renderActions={pickAttachment
          ? () => (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={selectedAttachment
                ? labels.replaceAttachment(selectedAttachment.filename)
                : labels.addAttachment}
              accessibilityState={{ disabled: disabled || adapter.isLoading || adapter.isRunning || attachmentPickerPending || sendPending }}
              disabled={disabled || adapter.isLoading || adapter.isRunning || attachmentPickerPending || sendPending}
              onPress={startAttachmentPicker}
              style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: compactLayout ? 6 : 10 }}
            >
              <Text style={{ color: colors.primary, fontSize: compactLayout ? 18 : 14 }}>{compactLayout ? '+' : labels.addAttachment}</Text>
            </Pressable>
          )
          : undefined}
        renderAccessory={selectedAttachment
          ? () => (
            <View
              accessibilityLabel={labels.selectedAttachment(selectedAttachment.filename)}
              style={{
                alignItems: 'center',
                flexDirection: logicalRowDirection,
                gap: 6,
                minHeight: 44,
                paddingHorizontal: compactLayout ? 6 : 12,
              }}
            >
              <Text numberOfLines={largeText ? undefined : 1} style={{ color: colors.onSurface, flex: 1 }}>
                {labels.selectedAttachment(selectedAttachment.filename)}
              </Text>
              <Pressable
                accessibilityRole='button'
                accessibilityLabel={labels.removeAttachment(selectedAttachment.filename)}
                accessibilityState={{ disabled: attachmentPickerPending || sendPending }}
                disabled={attachmentPickerPending || sendPending}
                onPress={() => {
                  replaceSelectedAttachment(undefined);
                }}
                style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}
              >
                <Text style={{ color: colors.error, fontSize: 18 }}>×</Text>
              </Pressable>
            </View>
          )
          : undefined}
        listViewProps={{
          onViewableItemsChanged,
          viewabilityConfig: { itemVisiblePercentThreshold: 1 },
        }}
        inverted
        loadEarlier={adapter.hasMoreBefore}
        isLoadingEarlier={adapter.isLoadingMoreBefore}
        loadEarlierLabel={timelineLabels.loadEarlier}
        onLoadEarlier={() => {
          if (adapter.loadMoreBefore) void runOperation('load-more-before', adapter.loadMoreBefore);
        }}
      />
      {adapter.hasMoreAfter && adapter.loadMoreAfter && (
        <Pressable
          accessibilityRole='button'
          accessibilityLabel={timelineLabels.loadLater}
          disabled={adapter.isLoadingMoreAfter}
          onPress={() => {
            void runOperation('load-more-after', adapter.loadMoreAfter!);
          }}
          style={{ alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8 }}
        >
          <Text style={{ color: colors.primary }}>{timelineLabels.loadLater}</Text>
        </Pressable>
      )}
      {(adapter.pendingNewMessageCount ?? 0) > 0 && adapter.jumpToLatest && (
        <Pressable
          accessibilityRole='button'
          accessibilityLabel={timelineLabels.newMessages(adapter.pendingNewMessageCount ?? 0)}
          onPress={() => {
            void runOperation('jump-to-latest', adapter.jumpToLatest!);
          }}
          style={{ alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 }}
        >
          <Text style={{ color: colors.primary }}>{timelineLabels.newMessages(adapter.pendingNewMessageCount ?? 0)}</Text>
        </Pressable>
      )}
      {adapter.timeline && activeTimelineEntry && (
        <>
          <Pressable
            accessibilityRole='button'
            accessibilityLabel={`${timelineLabels.navigation}: ${
              activeTimelineEntry.kind === 'compaction'
                ? timelineLabels.compacted(activeTimelineEntry.compactedMessageCount)
                : timelineLabels.turn(activeTimelineEntry.turnIndex + 1, adapter.timeline.totalTurns)
            }`}
            onPress={() => {
              setTimelineOpen(true);
            }}
            style={{
              position: 'absolute',
              start: 4,
              top: 52,
              minWidth: 44,
              minHeight: 44,
              maxWidth: compactLayout ? 132 : 180,
              borderRadius: 10,
              backgroundColor: colors.inverseSurface,
              paddingHorizontal: 8,
              paddingVertical: 6,
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: colors.inverseOnSurface, fontSize: 12 }}>
              {activeTimelineEntry.entryIndex + 1}/{adapter.timeline.totalEntries}
            </Text>
            <Text numberOfLines={largeText ? undefined : 1} style={{ color: colors.inverseOnSurface, fontSize: 10 }}>
              {activeTimelineEntry.kind === 'compaction' ? activeTimelineEntry.summaryPreview : activeTimelineEntry.userPreview}
            </Text>
          </Pressable>
          <Modal
            animationType='fade'
            transparent
            visible={timelineOpen}
            onRequestClose={() => {
              setTimelineOpen(false);
            }}
          >
            <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: colors.backdrop }}>
              <Pressable
                accessibilityRole='button'
                accessibilityLabel={labels.close}
                onPress={() => {
                  setTimelineOpen(false);
                }}
                style={{ flex: 1 }}
              />
              <View
                style={{
                  maxHeight: compactLayout ? '85%' : '70%',
                  backgroundColor: colors.surface,
                  borderTopStartRadius: 16,
                  borderTopEndRadius: 16,
                  padding: compactLayout ? 8 : 12,
                }}
              >
                <Text style={{ color: colors.onSurface, fontSize: 16, fontWeight: '600', paddingBottom: 8 }}>{timelineLabels.navigation}</Text>
                {adapter.loadTimelineAround && adapter.timeline.totalEntries > 1 && (
                  <View style={{ flexDirection: logicalRowDirection, flexWrap: compactLayout ? 'wrap' : 'nowrap', minHeight: 44, alignItems: 'center', gap: 8 }}>
                    <TextInput
                      accessibilityLabel={timelineLabels.seek}
                      keyboardType='number-pad'
                      value={timelineSeekValue}
                      onChangeText={setTimelineSeekValue}
                      placeholder={`1-${adapter.timeline.totalEntries}`}
                      style={{
                        flexGrow: 1,
                        flexBasis: compactLayout ? '70%' : 0,
                        minHeight: 44,
                        color: colors.onSurface,
                        borderWidth: 1,
                        borderColor: colors.outline,
                        borderRadius: 8,
                        paddingHorizontal: 8,
                      }}
                    />
                    <Pressable
                      accessibilityRole='button'
                      accessibilityLabel={timelineLabels.seek}
                      onPress={() => {
                        const requested = Number(timelineSeekValue);
                        if (!Number.isFinite(requested)) {
                          return;
                        }
                        const entryIndex = Math.max(0, Math.min(adapter.timeline!.totalEntries - 1, Math.trunc(requested) - 1));
                        runTimelineOperation('load-timeline-around', signal =>
                          adapter.loadTimelineAround!(entryIndex, adapter.timeline!.revision, signal));
                      }}
                      style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Text style={{ color: colors.primary }}>{timelineLabels.seek}</Text>
                    </Pressable>
                  </View>
                )}
                <FlatList
                  data={timelineEntries}
                  keyExtractor={entry => entry.cursor}
                  ListHeaderComponent={adapter.timeline.hasMoreBefore && adapter.loadTimelineBefore
                    ? (
                      <Pressable
                        accessibilityRole='button'
                        accessibilityLabel={timelineLabels.loadEarlier}
                        disabled={adapter.isLoadingTimelineBefore}
                        onPress={() => {
                          const cursor = timelineEntries[0]?.cursor;
                          if (cursor) runTimelineOperation('load-timeline-before', signal => adapter.loadTimelineBefore!(cursor, adapter.timeline!.revision, signal));
                        }}
                        style={{ minHeight: 44, justifyContent: 'center', alignItems: 'center' }}
                      >
                        <Text style={{ color: colors.primary }}>{timelineLabels.loadEarlier}</Text>
                      </Pressable>
                    )
                    : undefined}
                  ListFooterComponent={adapter.timeline.hasMoreAfter && adapter.loadTimelineAfter
                    ? (
                      <Pressable
                        accessibilityRole='button'
                        accessibilityLabel={timelineLabels.loadLater}
                        disabled={adapter.isLoadingTimelineAfter}
                        onPress={() => {
                          const cursor = timelineEntries.at(-1)?.cursor;
                          if (cursor) runTimelineOperation('load-timeline-after', signal => adapter.loadTimelineAfter!(cursor, adapter.timeline!.revision, signal));
                        }}
                        style={{ minHeight: 44, justifyContent: 'center', alignItems: 'center' }}
                      >
                        <Text style={{ color: colors.primary }}>{timelineLabels.loadLater}</Text>
                      </Pressable>
                    )
                    : undefined}
                  renderItem={({ item: entry }) => (
                    <Pressable
                      accessibilityRole='button'
                      accessibilityLabel={entry.kind === 'compaction'
                        ? `${timelineLabels.compacted(entry.compactedMessageCount)}. ${labels.timelineTimestamp(entry.timestamp)}. ${entry.summaryPreview}`
                        : [
                          timelineLabels.turn(entry.turnIndex + 1, adapter.timeline!.totalTurns),
                          labels.timelineTimestamp(entry.timestamp),
                          `${labels.user}: ${entry.userPreview}`,
                          ...entry.participantPreviews.map(participant => `${participant.actorLabel}: ${participant.preview}`),
                          entry.responseCount > entry.participantPreviews.length
                            ? timelineLabels.moreResponses(entry.responseCount - entry.participantPreviews.length)
                            : undefined,
                        ].filter(Boolean).join('. ')}
                      accessibilityState={{ selected: activeTimelineEntry.entryIndex === entry.entryIndex }}
                      onPress={() => {
                        setSelectedTimelineEntryIndex(entry.entryIndex);
                        setTimelineOpen(false);
                        if (entry.kind === 'turn' && adapter.loadAround) {
                          runTimelineOperation('load-around', signal => adapter.loadAround!(entry.turnId, entry.cursor, adapter.timeline!.revision, signal));
                        } else if (entry.kind === 'compaction' && adapter.loadAroundTimelineEntry) {
                          runTimelineOperation(
                            'load-around-timeline-entry',
                            signal => adapter.loadAroundTimelineEntry!(entry.entryId, entry.cursor, adapter.timeline!.revision, signal),
                          );
                        }
                      }}
                      style={{
                        minHeight: 44,
                        paddingHorizontal: 8,
                        paddingVertical: 6,
                        borderRadius: 8,
                        backgroundColor: activeTimelineEntry.entryIndex === entry.entryIndex ? colors.primaryContainer : colors.surface,
                      }}
                    >
                      <Text style={{ color: activeTimelineEntry.entryIndex === entry.entryIndex ? colors.onPrimaryContainer : colors.onSurface, fontSize: 12, fontWeight: '600' }}>
                        {entry.kind === 'compaction'
                          ? timelineLabels.compacted(entry.compactedMessageCount)
                          : timelineLabels.turn(entry.turnIndex + 1, adapter.timeline!.totalTurns)}
                      </Text>
                      <Text style={{ color: colors.onSurfaceVariant, fontSize: 11 }}>
                        {labels.timelineTimestamp(entry.timestamp)}
                      </Text>
                      <Text numberOfLines={largeText ? undefined : 2} style={{ color: colors.onSurface, fontSize: 12 }}>
                        {entry.kind === 'compaction' ? entry.summaryPreview : `${labels.user}: ${entry.userPreview}`}
                      </Text>
                      {entry.kind === 'turn' &&
                        entry.participantPreviews.map((participant, participantIndex) => (
                          <Text
                            key={`${participant.role}:${participant.actorId}:${participantIndex}`}
                            numberOfLines={largeText ? undefined : 1}
                            style={{ color: colors.onSurfaceVariant, fontSize: 11 }}
                          >
                            {participant.actorLabel}: {participant.preview}
                          </Text>
                        ))}
                      {entry.kind === 'turn' && entry.responseCount > entry.participantPreviews.length && (
                        <Text numberOfLines={largeText ? undefined : 1} style={{ color: colors.onSurfaceVariant, fontSize: 11 }}>
                          {timelineLabels.moreResponses(entry.responseCount - entry.participantPreviews.length)}
                        </Text>
                      )}
                    </Pressable>
                  )}
                />
              </View>
            </View>
          </Modal>
        </>
      )}
    </View>
  );
}
