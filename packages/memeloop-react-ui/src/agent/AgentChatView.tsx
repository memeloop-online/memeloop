/**
 * AgentChatView — reusable chat view for an agent conversation.
 *
 * Composes MemeLoopThread + MemeLoopComposer + MemeLoopRuntimeProvider
 * with generic empty/loading/error rendering, default message renderers,
 * and built-in turn actions.
 *
 * Host-specific features (wiki tiddler selector, custom header, model parameters)
 * are provided via props/slots.
 */

import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CopyAllIcon from '@mui/icons-material/CopyAll';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import ReplayIcon from '@mui/icons-material/Replay';
import { Box, CircularProgress, IconButton, Tooltip, Typography } from '@mui/material';
import { AgentRunFailure, type ConversationMessageListProjection, extractAgentRunError } from 'memeloop';
import React, { useCallback } from 'react';

import { MemeLoopAttachmentValidationError, validateMemeLoopAttachmentSelection, validateWebFileAttachment, validateWikiTiddlerAttachment } from '../chat/attachmentValidation.js';
import type { MessageContentToolRenderer } from '../chat/content/MessageContent.js';
import { normalizeMemeLoopChatError } from '../chat/coreTypes.js';
import { MemeLoopComposer, MemeLoopRuntimeProvider, MemeLoopThread, useMemeLoopChatContext } from '../chat/index.js';
import { notifyMemeLoopObserver } from '../chat/observerErrors.js';
import type {
  ConversationTimelineLabels,
  DroppedAttachmentResolver,
  MemeLoopAttachmentSelectionContext,
  MemeLoopComposerProps,
  WebMemeLoopChatAdapter,
  WebSelectedAttachmentBatch,
  WikiTiddlerAttachment,
  WikiTiddlerClickData,
} from '../chat/types.js';
import { snapshotDroppedAttachments } from '../chat/webAttachmentDrop.js';
import { ExecutionTargetSelector } from './ExecutionTargetSelector.js';
import type { ExecutionTargetSelectorLabels } from './ExecutionTargetSelector.js';

// ─── Types ─────────────────────────────────────────────────────────

export interface AgentChatViewProps {
  /** The chat adapter driving the conversation. */
  adapter: WebMemeLoopChatAdapter;

  /** Optional custom header (e.g. ChatHeader with agent switcher). */
  header?: React.ReactNode;

  /** Optional custom footer (e.g. model parameters dialog). */
  footer?: React.ReactNode;

  /** Custom empty state content. */
  empty?: React.ReactNode;

  /** Custom message content renderer. */
  renderMessageContent?: (message: ConversationMessageListProjection, isUser: boolean) => React.ReactNode;

  /** Custom attachment actions rendered next to the file button. */
  renderAttachmentActions?: React.ReactNode;

  /** Custom attachment picker replacing the default file button. */
  renderAttachmentPicker?: MemeLoopComposerProps['renderAttachmentPicker'];

  /** Currently selected file. */
  selectedFile?: File;

  /** Currently selected wiki tiddler attachments. */
  selectedWikiTiddlers?: readonly WikiTiddlerAttachment[];

  /** File selection callback. */
  onFileSelect?: (file: File) => void;

  /** Wiki tiddler selection callback. */
  onWikiTiddlerSelect?: (tiddler: WikiTiddlerAttachment) => void;

  /** Required for atomic multi-item drag/drop commits. Must observe `signal`. */
  onAttachmentsSelect?: (
    batch: WebSelectedAttachmentBatch,
    context: MemeLoopAttachmentSelectionContext,
  ) => Promise<void> | void;

  /** File clear callback. */
  onClearFile?: () => void;

  /** Atomically clear every host-controlled attachment after a successful send. */
  onClearAttachments?: () => void;

  /** Wiki tiddler removal callback. */
  onRemoveWikiTiddler?: (index: number) => void;

  /** Wiki tiddler click handler (in messages). */
  onWikiTiddlerClick?: (tiddler: WikiTiddlerClickData) => void;

  /** Custom turn actions renderer; overrides default. */
  renderTurnActions?: (message: ConversationMessageListProjection) => React.ReactNode;

  /** Custom composer component, overrides default MemeLoopComposer. */
  composerComponent?: React.ComponentType<MemeLoopComposerProps>;

  /** Toolbar rendered inside the composer row (between attachment actions and send). */
  composerToolbar?: React.ReactNode;

  /** Composer placeholder text. */
  placeholder?: string;

  /** Localized composer input and action labels. */
  composerLabels?: Partial<import('../chat/types.js').MemeLoopComposerLabels>;

  /** Whether the composer and actions are disabled. */
  disabled?: boolean;

  /** Custom loading message. */
  loadingMessage?: string;

  /** Custom error message prefix. */
  errorMessagePrefix?: string;

  /** Localized fail-closed text used when no typed error renderer is supplied. */
  genericErrorMessage?: string;

  /** Localized fail-closed text used for caught asynchronous operation errors. */
  operationErrorMessage?: string;

  /** Custom empty message. */
  emptyMessage?: string;

  /** Custom error renderer for empty-thread failures. */
  renderError?: (error: Error) => React.ReactNode;

  /** Host-safe renderer for caught asynchronous operation errors. */
  renderOperationError?: (error: Error) => React.ReactNode;

  /** Whether to show default turn actions (copy, retry, delete). */
  showTurnActions?: boolean;

  /** Whether to show the shared sampled timeline rail. Defaults to true. */
  showTimeline?: boolean;

  /** Localized timeline labels supplied by the host. */
  timelineLabels?: Partial<ConversationTimelineLabels>;

  /** Host locale-aware timestamp formatter used by timeline tooltips. */
  formatTimelineTimestamp?: (timestamp: number) => string;

  /** Localized labels for the shared turn actions and copied transcript. */
  actionLabels?: Partial<AgentChatActionLabels>;

  /** Localized execution-target selector and restart-confirmation labels. */
  executionTargetLabels?: Partial<ExecutionTargetSelectorLabels>;

  /** Localized fallback message, attachment and detail labels. */
  messageLabels?: import('../chat/types.js').MemeLoopThreadProps['messageLabels'];

  /** Host renderers for typed tool-result presentations. */
  toolResultRenderers?: Readonly<Record<string, MessageContentToolRenderer>>;

  /** Resolve host-specific drag payloads (for example TiddlyWiki titles). */
  resolveDroppedWikiTiddlers?: DroppedAttachmentResolver;

  /** Shared bounded validation applied to picker and drag/drop attachments. */
  attachmentPolicy?: import('../chat/attachmentValidation.js').MemeLoopAttachmentPolicy;
}

export interface AgentChatActionLabels {
  retry: string;
  deleteTurn: string;
  copy: string;
  copyAll: string;
  user: string;
  agent: string;
}

interface AttachmentSelectionOperation {
  controller: AbortController;
  generation: number;
  token: symbol;
}

const DEFAULT_ACTION_LABELS: AgentChatActionLabels = {
  retry: 'Retry',
  deleteTurn: 'Delete turn',
  copy: 'Copy',
  copyAll: 'Copy all',
  user: 'User',
  agent: 'Agent',
};

// ─── Default empty state ───────────────────────────────────────────

function DefaultEmpty({ message }: { message: string }) {
  return (
    <Box sx={{ textAlign: 'center', p: 4, color: 'text.secondary' }}>
      <Typography>{message}</Typography>
    </Box>
  );
}

function DefaultLoading({ message }: { message: string }) {
  return (
    <Box sx={{ textAlign: 'center', p: 4 }}>
      <CircularProgress size={24} />
      <Typography sx={{ mt: 2 }}>{message}</Typography>
    </Box>
  );
}

function DefaultError({ message }: { message: string }) {
  return (
    <Box data-testid='error-message' sx={{ textAlign: 'center', p: 2, color: 'error.main' }}>
      <Typography>{message}</Typography>
    </Box>
  );
}

export function getConversationError(messages: readonly ConversationMessageListProjection[]): Error | null {
  const message = messages.at(-1);
  if (message?.role !== 'error') return null;
  // Only durable typed metadata crosses the rendering boundary; raw
  // content/errorDetail strings are never interpreted as an error payload.
  const error = extractAgentRunError(message.metadata?.agentRunError);
  return error ? new AgentRunFailure(error) : new Error('agent-run-failed');
}

// ─── Default turn actions ──────────────────────────────────────────

function DefaultTurnActions({
  message,
  copyTextByTurn,
  onRetry,
  onDelete,
  startConversationExport,
  labels,
}: {
  message: ConversationMessageListProjection;
  copyTextByTurn: ReadonlyMap<string, string>;
  onRetry: (turnId: string) => Promise<void>;
  onDelete: (turnId: string) => Promise<void>;
  startConversationExport?: (
    clearError: () => void,
    reportError: (error: unknown, operation: 'copy-conversation') => void,
  ) => void;
  labels: AgentChatActionLabels;
}) {
  const { clearOperationError, reportOperationError } = useMemeLoopChatContext();
  // Error rows are rendered through the typed fail-closed presentation and
  // must never expose their raw content through copy controls.
  if (message.role === 'user' || message.role === 'error') return null;

  const isAssistant = message.role === 'assistant';

  const handleCopy = () => {
    // A resident page may not contain the user row, and concurrent replies are
    // not necessarily adjacent. The protocol turn identity is authoritative.
    // The transcript is grouped once per adapter snapshot so each action stays
    // O(1) even when a host accidentally exposes a long backing history.
    const text = copyTextByTurn.get(message.turnId) ?? '';
    if (text) {
      clearOperationError();
      void Promise.resolve().then(() => navigator.clipboard.writeText(text)).catch((error: unknown) => {
        reportOperationError(error, 'copy-message');
      });
    }
  };

  const handleCopyAll = () => {
    startConversationExport?.(clearOperationError, reportOperationError);
  };

  const runTurnOperation = (operation: 'delete-turn' | 'retry-turn', callback: () => Promise<void>) => {
    clearOperationError();
    void Promise.resolve().then(callback).catch((error: unknown) => {
      reportOperationError(error, operation);
    });
  };

  return (
    <Box
      sx={{
        display: 'flex',
        gap: 0.5,
        mt: 0.5,
        opacity: 1,
      }}
    >
      {isAssistant && (
        <>
          <Tooltip title={labels.retry} disableInteractive>
            <IconButton
              size='small'
              aria-label={labels.retry}
              data-testid='turn-action-retry'
              onClick={() => {
                runTurnOperation('retry-turn', () => onRetry(message.turnId));
              }}
            >
              <ReplayIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title={labels.deleteTurn} disableInteractive>
            <IconButton
              size='small'
              aria-label={labels.deleteTurn}
              data-testid='turn-action-delete'
              onClick={() => {
                runTurnOperation('delete-turn', () => onDelete(message.turnId));
              }}
            >
              <DeleteOutlineIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </>
      )}
      <Tooltip title={labels.copy} disableInteractive>
        <IconButton size='small' aria-label={labels.copy} onClick={handleCopy}>
          <ContentCopyIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
      {startConversationExport && (
        <Tooltip title={labels.copyAll} disableInteractive>
          <IconButton size='small' aria-label={labels.copyAll} onClick={handleCopyAll}>
            <CopyAllIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}

// ─── Main component ────────────────────────────────────────────────

export function AgentChatView({
  adapter,
  header,
  footer,
  empty,
  renderMessageContent,
  renderAttachmentActions,
  renderAttachmentPicker,
  selectedFile,
  selectedWikiTiddlers,
  onFileSelect,
  onWikiTiddlerSelect,
  onAttachmentsSelect,
  onClearFile,
  onClearAttachments,
  onRemoveWikiTiddler,
  onWikiTiddlerClick,
  renderTurnActions: customRenderTurnActions,
  composerComponent: CustomComposer,
  composerToolbar,
  placeholder,
  composerLabels,
  disabled,
  loadingMessage = 'Loading chat...',
  genericErrorMessage = 'Something went wrong.',
  operationErrorMessage = 'The operation could not be completed.',
  emptyMessage = 'Start a conversation',
  renderError,
  renderOperationError,
  showTurnActions = true,
  showTimeline = true,
  timelineLabels,
  formatTimelineTimestamp,
  actionLabels,
  executionTargetLabels,
  messageLabels,
  toolResultRenderers,
  resolveDroppedWikiTiddlers,
  attachmentPolicy,
}: AgentChatViewProps) {
  const [attachmentError, setAttachmentError] = React.useState<Error | undefined>(undefined);
  const resolvedActionLabels = React.useMemo(
    () => ({ ...DEFAULT_ACTION_LABELS, ...actionLabels }),
    [actionLabels],
  );
  const hasMessages = adapter.messages.length > 0;
  const copyTextByTurn = React.useMemo(() => {
    const grouped = new Map<string, string[]>();
    for (const item of adapter.messages) {
      if (item.role === 'user' || item.role === 'error' || !item.content) continue;
      const values = grouped.get(item.turnId);
      if (values) values.push(item.content);
      else grouped.set(item.turnId, [item.content]);
    }
    return new Map([...grouped].map(([turnId, values]) => [turnId, values.join('\n\n')] as const));
  }, [adapter.messages]);
  const conversationError = getConversationError(adapter.messages);
  const displayedError = conversationError ?? adapter.error;
  const showLoading = adapter.isLoading && !hasMessages;
  const showError = !!displayedError && !hasMessages;
  const conversationExportGenerationReference = React.useRef(0);
  const activeConversationExportReference = React.useRef<
    {
      controller: AbortController;
      generation: number;
      token: symbol;
    } | undefined
  >(undefined);
  const abortActiveConversationExport = useCallback(() => {
    const active = activeConversationExportReference.current;
    if (!active) return;
    activeConversationExportReference.current = undefined;
    if (!active.controller.signal.aborted) active.controller.abort();
  }, []);
  React.useEffect(() => {
    conversationExportGenerationReference.current += 1;
    abortActiveConversationExport();
    return () => {
      conversationExportGenerationReference.current += 1;
      abortActiveConversationExport();
    };
  }, [abortActiveConversationExport, adapter.conversationId]);
  const startConversationExport = useCallback((
    clearError: () => void,
    reportError: (error: unknown, operation: 'copy-conversation') => void,
  ) => {
    if (!adapter.exportConversation) return;
    clearError();
    abortActiveConversationExport();
    const operation = {
      controller: new AbortController(),
      generation: conversationExportGenerationReference.current,
      token: Symbol(adapter.conversationId),
    };
    activeConversationExportReference.current = operation;
    void Promise.resolve()
      .then(() => {
        operation.controller.signal.throwIfAborted();
        return adapter.exportConversation!({ signal: operation.controller.signal });
      })
      .catch((error: unknown) => {
        if (
          operation.controller.signal.aborted ||
          operation.generation !== conversationExportGenerationReference.current ||
          activeConversationExportReference.current?.token !== operation.token
        ) return;
        reportError(error, 'copy-conversation');
      })
      .finally(() => {
        if (activeConversationExportReference.current?.token === operation.token) {
          activeConversationExportReference.current = undefined;
        }
      });
  }, [abortActiveConversationExport, adapter]);

  const computedEmpty = (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', minHeight: 0 }}>
      {showLoading && <DefaultLoading message={loadingMessage} />}
      {showError && (displayedError && renderError
        ? renderError(displayedError)
        : <DefaultError message={genericErrorMessage} />)}
      {!showLoading && !showError && (empty ?? <DefaultEmpty message={emptyMessage} />)}
    </Box>
  );

  // Build default turn actions using adapter callbacks
  const turnActions = useCallback(
    (message: ConversationMessageListProjection) => {
      if (customRenderTurnActions) return customRenderTurnActions(message);
      if (!showTurnActions) return null;
      if (message.role === 'user') return null;
      return (
        <DefaultTurnActions
          message={message}
          copyTextByTurn={copyTextByTurn}
          onRetry={adapter.retryTurn}
          onDelete={adapter.deleteTurn}
          startConversationExport={adapter.exportConversation ? startConversationExport : undefined}
          labels={resolvedActionLabels}
        />
      );
    },
    [adapter, copyTextByTurn, customRenderTurnActions, resolvedActionLabels, showTurnActions, startConversationExport],
  );

  const composerRenderState = React.useRef<{
    Component: React.ComponentType<MemeLoopComposerProps>;
    props: MemeLoopComposerProps;
  }>({
    Component: CustomComposer ?? MemeLoopComposer,
    props: {},
  });
  const attachmentSelectionQueueReference = React.useRef(Promise.resolve());
  const attachmentSelectionPendingReference = React.useRef(0);
  const attachmentSelectionGenerationReference = React.useRef(0);
  const attachmentSelectionOperationsReference = React.useRef(new Map<symbol, AbortController>());
  const activeDropOperationReference = React.useRef<AttachmentSelectionOperation | undefined>(undefined);
  const attachmentSelectionReference = React.useRef<WebSelectedAttachmentBatch>({
    file: selectedFile,
    wikiTiddlers: Object.freeze([...(selectedWikiTiddlers ?? [])]),
  });
  if (attachmentSelectionPendingReference.current === 0) {
    attachmentSelectionReference.current = Object.freeze({
      ...(selectedFile ? { file: selectedFile } : {}),
      wikiTiddlers: Object.freeze([...(selectedWikiTiddlers ?? [])]),
    });
  }
  const abortAttachmentOperations = useCallback((reason: Error) => {
    const activeDrop = activeDropOperationReference.current;
    activeDropOperationReference.current = undefined;
    if (activeDrop && !activeDrop.controller.signal.aborted) activeDrop.controller.abort(reason);
    for (const controller of attachmentSelectionOperationsReference.current.values()) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
    attachmentSelectionOperationsReference.current.clear();
  }, []);
  React.useEffect(() => {
    attachmentSelectionGenerationReference.current += 1;
    abortAttachmentOperations(new Error('attachment conversation generation changed'));
    attachmentSelectionQueueReference.current = Promise.resolve();
    attachmentSelectionReference.current = Object.freeze({
      ...(selectedFile ? { file: selectedFile } : {}),
      wikiTiddlers: Object.freeze([...(selectedWikiTiddlers ?? [])]),
    });
    return () => {
      attachmentSelectionGenerationReference.current += 1;
      abortAttachmentOperations(new Error('attachment selection disposed'));
    };
    // Selection props intentionally do not restart a generation. They are
    // host-controlled projections; conversation identity owns cancellation.
  }, [abortAttachmentOperations, adapter.conversationId]);
  const reportAttachmentError = useCallback((error: unknown, operation: 'resolve-dropped-attachments' | 'select-attachment') => {
    const normalized = error instanceof MemeLoopAttachmentValidationError ? error : normalizeMemeLoopChatError(error);
    setAttachmentError(normalized);
    notifyMemeLoopObserver(
      () => adapter.onError?.(normalized, operation),
      'adapter.onError',
      operation,
      adapter.onObserverError,
    );
  }, [adapter]);
  const enqueueAttachmentSelection = useCallback((
    build: (current: WebSelectedAttachmentBatch) => WebSelectedAttachmentBatch,
  ): Promise<void> => {
    if (!onAttachmentsSelect) return Promise.reject(new MemeLoopAttachmentValidationError('attachment-atomic-commit-required'));
    const generation = attachmentSelectionGenerationReference.current;
    attachmentSelectionPendingReference.current += 1;
    const task = attachmentSelectionQueueReference.current.then(async () => {
      if (generation !== attachmentSelectionGenerationReference.current) return;
      const token = Symbol('attachment-selection');
      const controller = new AbortController();
      attachmentSelectionOperationsReference.current.set(token, controller);
      try {
        const next = validateMemeLoopAttachmentSelection(
          build(attachmentSelectionReference.current),
          attachmentPolicy,
        ) as WebSelectedAttachmentBatch;
        const context = Object.freeze({
          conversationId: adapter.conversationId,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        await onAttachmentsSelect(next, context);
        if (controller.signal.aborted || generation !== attachmentSelectionGenerationReference.current) return;
        attachmentSelectionReference.current = next;
        setAttachmentError(undefined);
      } catch (error) {
        if (controller.signal.aborted || generation !== attachmentSelectionGenerationReference.current) return;
        throw error;
      } finally {
        attachmentSelectionOperationsReference.current.delete(token);
      }
    });
    attachmentSelectionQueueReference.current = task.catch(() => undefined);
    return task.finally(() => {
      attachmentSelectionPendingReference.current = Math.max(0, attachmentSelectionPendingReference.current - 1);
    });
  }, [adapter.conversationId, attachmentPolicy, onAttachmentsSelect]);
  const validatedFileSelect = useCallback((file: File) => {
    if (onAttachmentsSelect) {
      void enqueueAttachmentSelection(current => {
        validateWebFileAttachment(file, current.wikiTiddlers.length, attachmentPolicy);
        return { file, wikiTiddlers: current.wikiTiddlers };
      }).catch((error: unknown) => {
        reportAttachmentError(error, 'select-attachment');
      });
      return;
    }
    try {
      validateWebFileAttachment(file, selectedWikiTiddlers?.length ?? 0, attachmentPolicy);
      onFileSelect?.(file);
      setAttachmentError(undefined);
    } catch (error) {
      reportAttachmentError(error, 'select-attachment');
    }
  }, [attachmentPolicy, enqueueAttachmentSelection, onAttachmentsSelect, onFileSelect, reportAttachmentError, selectedWikiTiddlers]);
  const validatedTiddlerSelect = useCallback((tiddler: WikiTiddlerAttachment) => {
    if (onAttachmentsSelect) {
      void enqueueAttachmentSelection(current => {
        const canonical = validateWikiTiddlerAttachment(tiddler, current.wikiTiddlers, !!current.file, attachmentPolicy);
        return { file: current.file, wikiTiddlers: [...current.wikiTiddlers, canonical] };
      }).catch((error: unknown) => {
        reportAttachmentError(error, 'select-attachment');
      });
      return;
    }
    try {
      const canonical = validateWikiTiddlerAttachment(tiddler, selectedWikiTiddlers ?? [], !!selectedFile, attachmentPolicy);
      onWikiTiddlerSelect?.(canonical);
      setAttachmentError(undefined);
    } catch (error) {
      reportAttachmentError(error, 'select-attachment');
    }
  }, [attachmentPolicy, enqueueAttachmentSelection, onAttachmentsSelect, onWikiTiddlerSelect, reportAttachmentError, selectedFile, selectedWikiTiddlers]);
  composerRenderState.current = {
    Component: CustomComposer ?? MemeLoopComposer,
    props: {
      selectedFile,
      selectedWikiTiddlers,
      onFileSelect: onAttachmentsSelect || onFileSelect ? validatedFileSelect : undefined,
      onWikiTiddlerSelect: onAttachmentsSelect || onWikiTiddlerSelect ? validatedTiddlerSelect : undefined,
      onClearFile,
      onClearAttachments,
      onRemoveWikiTiddler,
      renderAttachmentActions,
      renderAttachmentPicker,
      renderComposerToolbar: composerToolbar,
      disabled,
      placeholder,
      labels: composerLabels,
    },
  };

  // assistant-ui accepts a component type rather than an element. Its identity
  // must remain stable even when host slot nodes/callbacks are recreated; the
  // stable wrapper reads the latest render inputs through the ref above.
  const resolvedComposerComponent = useCallback(() => {
    const { Component, props } = composerRenderState.current;
    return <Component {...props} />;
  }, []);

  const handleDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.preventDefault();
    const generation = attachmentSelectionGenerationReference.current;
    const previous = activeDropOperationReference.current;
    if (previous && !previous.controller.signal.aborted) previous.controller.abort(new Error('attachment drop superseded'));
    const operation: AttachmentSelectionOperation = {
      controller: new AbortController(),
      generation,
      token: Symbol('attachment-drop'),
    };
    activeDropOperationReference.current = operation;
    try {
      const snapshot = snapshotDroppedAttachments(event.dataTransfer, attachmentPolicy);
      const context = Object.freeze({ conversationId: adapter.conversationId, signal: operation.controller.signal });
      const droppedTiddlers = resolveDroppedWikiTiddlers
        ? await resolveDroppedWikiTiddlers(snapshot, context)
        : [];
      operation.controller.signal.throwIfAborted();
      if (
        operation.generation !== attachmentSelectionGenerationReference.current ||
        activeDropOperationReference.current?.token !== operation.token
      ) return;
      if (snapshot.files.length === 0 && droppedTiddlers.length === 0) return;
      if (!onAttachmentsSelect) {
        throw new MemeLoopAttachmentValidationError('attachment-atomic-commit-required');
      }
      await enqueueAttachmentSelection(current => {
        const file = snapshot.files[0] ?? current.file;
        const selected = [...current.wikiTiddlers];
        if (file) validateWebFileAttachment(file, selected.length + droppedTiddlers.length, attachmentPolicy);
        for (const tiddler of droppedTiddlers) {
          const canonical = validateWikiTiddlerAttachment(tiddler, selected, !!file, attachmentPolicy);
          selected.push(canonical);
        }
        return { file, wikiTiddlers: selected };
      });
    } catch (error) {
      if (
        operation.controller.signal.aborted ||
        operation.generation !== attachmentSelectionGenerationReference.current ||
        activeDropOperationReference.current?.token !== operation.token
      ) return;
      reportAttachmentError(error, 'resolve-dropped-attachments');
    } finally {
      if (activeDropOperationReference.current?.token === operation.token) activeDropOperationReference.current = undefined;
    }
  }, [adapter.conversationId, attachmentPolicy, disabled, enqueueAttachmentSelection, onAttachmentsSelect, reportAttachmentError, resolveDroppedWikiTiddlers]);

  return (
    <Box
      data-testid='memeloop-agent-chat'
      onDragOver={event => {
        if (!disabled && (event.dataTransfer.files.length > 0 || resolveDroppedWikiTiddlers)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={event => void handleDrop(event)}
      sx={{
        containerType: 'inline-size',
        containerName: 'memeloop-chat',
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        '& > *': { flex: 1, minHeight: 0, minWidth: 0 },
      }}
    >
      <MemeLoopRuntimeProvider adapter={adapter}>
        <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, '& > *': { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }}>
          <MemeLoopThread
            header={
              <>
                {header}
                {adapter.executionTargets && adapter.setExecutionTarget && (
                  <ExecutionTargetSelector
                    targets={adapter.executionTargets}
                    activeTarget={adapter.activeExecutionTarget}
                    isRunning={adapter.isRunning}
                    disabled={disabled}
                    onChange={adapter.setExecutionTarget}
                    onError={adapter.onError}
                    onObserverError={adapter.onObserverError}
                    labels={executionTargetLabels}
                  />
                )}
              </>
            }
            empty={computedEmpty}
            composerComponent={resolvedComposerComponent}
            renderMessageContent={renderMessageContent}
            renderTurnActions={turnActions}
            onWikiTiddlerClick={onWikiTiddlerClick}
            loadMessageDetail={adapter.loadMessageDetail}
            loadMessageReasoning={adapter.loadMessageReasoning}
            showTimeline={showTimeline}
            timelineLabels={timelineLabels}
            formatTimelineTimestamp={formatTimelineTimestamp}
            messageLabels={messageLabels}
            toolResultRenderers={toolResultRenderers}
            renderOperationError={renderOperationError}
            operationErrorOverride={attachmentError}
            onClearOperationErrorOverride={() => {
              setAttachmentError(undefined);
            }}
            operationErrorMessage={operationErrorMessage}
          />
          {footer}
        </Box>
      </MemeLoopRuntimeProvider>
    </Box>
  );
}
