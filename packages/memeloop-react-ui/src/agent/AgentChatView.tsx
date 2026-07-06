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
import type { ChatMessage } from 'memeloop';
import React, { useCallback } from 'react';

import { MemeLoopComposer, MemeLoopRuntimeProvider, MemeLoopThread } from '../chat/index.js';
import type { MemeLoopChatAdapter, MemeLoopComposerProps, WikiTiddlerAttachment, WikiTiddlerClickData } from '../chat/types.js';
import { ExecutionTargetSelector } from './ExecutionTargetSelector.js';

// ─── Types ─────────────────────────────────────────────────────────

export interface AgentChatViewProps {
  /** The chat adapter driving the conversation. */
  adapter: MemeLoopChatAdapter;

  /** Optional custom header (e.g. ChatHeader with agent switcher). */
  header?: React.ReactNode;

  /** Optional custom footer (e.g. model parameters dialog). */
  footer?: React.ReactNode;

  /** Custom empty state content. */
  empty?: React.ReactNode;

  /** Custom message content renderer. */
  renderMessageContent?: (message: ChatMessage, isUser: boolean) => React.ReactNode;

  /** Custom attachment actions rendered next to the file button. */
  renderAttachmentActions?: React.ReactNode;

  /** Currently selected file. */
  selectedFile?: File;

  /** Currently selected wiki tiddler attachments. */
  selectedWikiTiddlers?: WikiTiddlerAttachment[];

  /** File selection callback. */
  onFileSelect?: (file: File) => void;

  /** Wiki tiddler selection callback. */
  onWikiTiddlerSelect?: (tiddler: WikiTiddlerAttachment) => void;

  /** File clear callback. */
  onClearFile?: () => void;

  /** Wiki tiddler removal callback. */
  onRemoveWikiTiddler?: (index: number) => void;

  /** Wiki tiddler click handler (in messages). */
  onWikiTiddlerClick?: (tiddler: WikiTiddlerClickData) => void;

  /** Custom turn actions renderer; overrides default. */
  renderTurnActions?: (message: ChatMessage) => React.ReactNode;

  /** Custom composer component, overrides default MemeLoopComposer. */
  composerComponent?: React.ComponentType<MemeLoopComposerProps>;

  /** Composer placeholder text. */
  placeholder?: string;

  /** Whether the composer and actions are disabled. */
  disabled?: boolean;

  /** Custom loading message. */
  loadingMessage?: string;

  /** Custom error message prefix. */
  errorMessagePrefix?: string;

  /** Custom empty message. */
  emptyMessage?: string;

  /** Custom error renderer for empty-thread failures. */
  renderError?: (error: Error) => React.ReactNode;

  /** Whether to show default turn actions (copy, retry, delete). */
  showTurnActions?: boolean;
}

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

// ─── Default turn actions ──────────────────────────────────────────

function DefaultTurnActions({
  message,
  orderedMessages,
  onRetry,
  onDelete,
}: {
  message: ChatMessage;
  orderedMessages: readonly ChatMessage[];
  onRetry: (userMessageId: string) => void;
  onDelete: (userMessageId: string) => void;
}) {
  if (message.role === 'user') return null;

  // Find the preceding user message to identify the turn
  const messageIndex = orderedMessages.findIndex((item) => item.messageId === message.messageId);
  if (messageIndex < 0) return null;

  const precedingUser = orderedMessages
    .slice(0, messageIndex)
    .filter((m) => m.role === 'user')
    .pop();
  if (!precedingUser) return null;

  const isAssistant = message.role === 'assistant';

  const handleCopy = () => {
    const fromIndex = messageIndex;
    const toIndex = orderedMessages.findIndex(
      (m, index) => index > fromIndex && m.role === 'user',
    );
    const range = toIndex >= 0 ? orderedMessages.slice(fromIndex, toIndex) : orderedMessages.slice(fromIndex);
    const text = range.map((m) => m.content).filter(Boolean).join('\n\n');
    if (text) void navigator.clipboard.writeText(text);
  };

  const handleCopyAll = () => {
    const text = orderedMessages
      .map((m) => {
        const role = m.role === 'user' ? 'User' : 'Agent';
        return m.content ? `${role}: ${m.content}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
    if (text) void navigator.clipboard.writeText(text);
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
          <Tooltip title='Retry' disableInteractive>
            <IconButton
              size='small'
              aria-label='Retry'
              data-testid='turn-action-retry'
              onClick={() => {
                onRetry(precedingUser.messageId);
              }}
            >
              <ReplayIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title='Delete turn' disableInteractive>
            <IconButton
              size='small'
              aria-label='Delete turn'
              data-testid='turn-action-delete'
              onClick={() => {
                onDelete(precedingUser.messageId);
              }}
            >
              <DeleteOutlineIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </>
      )}
      <Tooltip title='Copy' disableInteractive>
        <IconButton size='small' aria-label='Copy' onClick={handleCopy}>
          <ContentCopyIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title='Copy all' disableInteractive>
        <IconButton size='small' aria-label='Copy all' onClick={handleCopyAll}>
          <CopyAllIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
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
  selectedFile,
  selectedWikiTiddlers,
  onFileSelect,
  onWikiTiddlerSelect,
  onClearFile,
  onRemoveWikiTiddler,
  onWikiTiddlerClick,
  renderTurnActions: customRenderTurnActions,
  composerComponent: CustomComposer,
  placeholder,
  disabled,
  loadingMessage = 'Loading chat...',
  emptyMessage = 'Start a conversation',
  renderError,
  showTurnActions = true,
}: AgentChatViewProps) {
  const hasMessages = adapter.messages.length > 0;
  const showLoading = adapter.isLoading && !hasMessages;
  const showError = !!adapter.error && !hasMessages;
  // When messages exist and there is an error, render it in the header
  const errorHeader = hasMessages && adapter.error
    ? (renderError ? renderError(adapter.error) : <DefaultError message={adapter.error.message ?? 'An error occurred'} />)
    : null;

  const computedEmpty = (
    <>
      {showLoading && <DefaultLoading message={loadingMessage} />}
      {showError && (adapter.error && renderError
        ? renderError(adapter.error)
        : <DefaultError message={adapter.error?.message ?? 'An error occurred'} />)}
      {!showLoading && !showError && (empty ?? <DefaultEmpty message={emptyMessage} />)}
    </>
  );

  // Build default turn actions using adapter callbacks
  const turnActions = useCallback(
    (message: ChatMessage) => {
      if (customRenderTurnActions) return customRenderTurnActions(message);
      if (!showTurnActions) return null;
      if (message.role === 'user') return null;
      return (
        <DefaultTurnActions
          message={message}
          orderedMessages={adapter.messages}
          onRetry={(id) => {
            void adapter.retryTurn(id);
          }}
          onDelete={(id) => {
            void adapter.deleteTurn(id);
          }}
        />
      );
    },
    [adapter, customRenderTurnActions, showTurnActions],
  );

  // Build composer component
  const composerProps: MemeLoopComposerProps = {
    selectedFile,
    selectedWikiTiddlers,
    onFileSelect,
    onWikiTiddlerSelect,
    onClearFile,
    onRemoveWikiTiddler,
    renderAttachmentActions,
    disabled,
    placeholder,
  };
  const resolvedComposerComponent: React.ComponentType | undefined = () => {
    const Composer = CustomComposer ?? MemeLoopComposer;
    return <Composer {...composerProps} />;
  };

  return (
    <MemeLoopRuntimeProvider adapter={adapter}>
      <MemeLoopThread
        header={
          <>
            {errorHeader}
            {header}
            {adapter.executionTargets && adapter.setExecutionTarget && (
              <ExecutionTargetSelector
                targets={adapter.executionTargets}
                activeTargetId={adapter.activeExecutionTargetId}
                isRunning={adapter.isRunning}
                disabled={disabled}
                onChange={adapter.setExecutionTarget}
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
      />
      {footer}
    </MemeLoopRuntimeProvider>
  );
}
