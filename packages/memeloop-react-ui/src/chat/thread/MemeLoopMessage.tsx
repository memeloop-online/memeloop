import LibraryBooksIcon from '@mui/icons-material/LibraryBooks';
import PersonIcon from '@mui/icons-material/Person';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import { Alert, Avatar, Box, Button, Chip, CircularProgress, Paper, styled, Typography } from '@mui/material';
import React, { useMemo } from 'react';

import { MessageContent } from '../content/MessageContent.js';
import type { MessageContentLabels } from '../content/MessageContent.js';
import { getDisplayTruncation, resolveDisplayTruncationAction } from '../displayBounds.js';
import { formatMessageDetailPage, MEMELOOP_MESSAGE_DETAIL_LIMIT, MEMELOOP_MESSAGE_DETAIL_MAX_BYTES, validateMessageDetailPage } from '../messageDetail.js';
import type { MemeLoopMessageProps, WikiTiddlerClickData } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Calculate whether a message should appear "expired" / grayed-out based on its
 * `duration` metadata. A duration of 0 means always expired; a positive number
 * means expired after that many messages have passed.
 */
function isMessageExpired(
  message: { duration?: number | null },
  messageIndex: number,
  totalMessages: number,
): boolean {
  if (message.duration === undefined || message.duration === null) return false;
  if (message.duration === 0) return true;
  return totalMessages - 1 - messageIndex >= message.duration;
}

// ── Image attachment ─────────────────────────────────────────────────────────

function ImagePreview({ alt, file }: { alt: string; file: unknown }) {
  const [url, setUrl] = React.useState<string | undefined>();

  React.useEffect(() => {
    if (file instanceof File) {
      const objectUrl = URL.createObjectURL(file);
      setUrl(objectUrl);
      return () => {
        URL.revokeObjectURL(objectUrl);
      };
    }
    if (file && typeof file === 'object' && 'path' in file) {
      const filePath = (file as { path: string }).path;
      setUrl(`file://${filePath}`);
    }
  }, [file]);

  if (!url) return null;

  return (
    <Box
      component='img'
      src={url}
      alt={alt}
      data-testid='message-image-attachment'
      sx={{
        maxWidth: '100%',
        maxHeight: 300,
        borderRadius: 1,
        mb: 1,
        display: 'block',
        cursor: 'pointer',
      }}
      onClick={() => {
        window.open(url, '_blank');
      }}
    />
  );
}

// ── Wiki tiddler attachment ──────────────────────────────────────────────────

interface WikiTiddlerChip {
  workspaceName: string;
  tiddlerTitle: string;
  workspaceId?: string;
  renderedContent?: string;
}

function WikiTiddlerChips({
  tiddlers,
  onTiddlerClick,
}: {
  tiddlers: WikiTiddlerChip[];
  onTiddlerClick?: (tiddler: WikiTiddlerClickData) => void;
}) {
  if (tiddlers.length === 0) return null;

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>
      {tiddlers.map((tiddler, index) => (
        <Chip
          key={index}
          icon={<LibraryBooksIcon />}
          label={`${tiddler.workspaceName}: ${tiddler.tiddlerTitle}`}
          size='small'
          data-testid={`wiki-tiddler-chip-message-${index}`}
          sx={{ maxWidth: 300, cursor: onTiddlerClick ? 'pointer' : undefined }}
          title={tiddler.renderedContent
            ? tiddler.renderedContent.substring(0, 100) + '...'
            : tiddler.tiddlerTitle}
          onClick={onTiddlerClick && tiddler.workspaceId
            ? () => {
              onTiddlerClick({
                workspaceId: tiddler.workspaceId!,
                workspaceName: tiddler.workspaceName,
                tiddlerTitle: tiddler.tiddlerTitle,
                renderedContent: tiddler.renderedContent,
              });
            }
            : undefined}
        />
      ))}
    </Box>
  );
}

// ── Utilities for reading attachments from ChatMessage metadata ───────────────

function getFileAttachment(message: { metadata?: Record<string, unknown> }): unknown {
  return message.metadata?.file;
}

function getWikiTiddlers(message: { metadata?: Record<string, unknown> }): WikiTiddlerChip[] {
  const raw = message.metadata?.wikiTiddlers;
  return Array.isArray(raw) ? (raw as WikiTiddlerChip[]) : [];
}

// ── Styled components ────────────────────────────────────────────────────────

const Root = styled(Box, {
  shouldForwardProp: (property) => property !== '$isUser',
})<{ $isUser: boolean }>`
  display: flex;
  gap: 12px;
  max-width: ${(props) => (props.$isUser ? '80%' : '100%')};
  align-self: ${(props) => (props.$isUser ? 'flex-end' : 'flex-start')};

  @container memeloop-chat (max-width: 480px) {
    gap: 6px;
    max-width: 100%;

    .MuiAvatar-root {
      width: 24px;
      height: 24px;
    }
  }
`;

const ExpiredRoot = styled(Box)`
  opacity: 0.5;
  transition: opacity 0.3s ease-in-out;
`;

const UserBubble = styled(Paper)`
  background-color: ${(props) => props.theme.palette.primary.light};
  color: ${(props) => props.theme.palette.primary.contrastText};
  padding: 12px 16px;
  border-radius: 12px;
`;

const AgentContainer = styled(Box, {
  shouldForwardProp: (property) => property !== '$expired',
})<{ $expired?: boolean }>`
  width: 100%;
  padding: 4px 0;
  opacity: ${(props) => (props.$expired ? 0.6 : 1)};
  transition: opacity 0.3s ease-in-out;
`;

function MessageAvatar({ isUser }: { isUser: boolean }) {
  return (
    <Avatar
      sx={{
        backgroundColor: (theme) => (isUser ? theme.palette.primary.main : theme.palette.grey[400]),
      }}
    >
      {isUser ? <PersonIcon /> : <SmartToyIcon />}
    </Avatar>
  );
}

export interface MemeLoopMessageLabels extends MessageContentLabels {
  attachmentAlt: string;
  noDetails: string;
  loadDetails: string;
  reloadDetails: string;
  hideDetails: string;
  showDetails: string;
  detailTruncated: string;
  detailLoadFailed: string;
  exportFullMessage: string;
}

const defaultLabels: MemeLoopMessageLabels = {
  attachmentAlt: 'Attachment',
  noDetails: 'No details available.',
  loadDetails: 'Load details',
  reloadDetails: 'Reload details',
  hideDetails: 'Hide details',
  showDetails: 'Show details',
  detailTruncated: 'Only a bounded detail fragment is shown. Export the conversation for complete content.',
  detailLoadFailed: 'Details could not be loaded.',
  exportFullMessage: 'Export full message',
  error: 'Error',
  toolResult: 'Tool result',
  toolCall: toolName => `Tool call: ${toolName}`,
  truncated: (count, capability) =>
    `Message shortened for display (${String(count)} characters).${
      capability === 'detail' ? ' View details for complete content.' : capability === 'export' ? ' Export for complete content.' : ''
    }`,
  askQuestion: {
    answerPlaceholder: 'Your answer…',
    submit: 'Submit',
    confirmSelection: 'Confirm selection',
    answered: 'Answered',
  },
};

function DetailReferencePanel({
  message,
  loadMessageDetail,
  labels,
  active = true,
  onActivate,
}: {
  message: MemeLoopMessageProps['message'];
  loadMessageDetail?: MemeLoopMessageProps['loadMessageDetail'];
  labels: MemeLoopMessageLabels;
  active?: boolean;
  onActivate?: (messageId: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [detail, setDetail] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const generationReference = React.useRef(0);
  const controllerReference = React.useRef<AbortController | undefined>(undefined);

  React.useEffect(() => {
    generationReference.current += 1;
    controllerReference.current?.abort();
    controllerReference.current = undefined;
    setExpanded(false);
    setLoading(false);
    setDetail(null);
    setError(null);
    return () => {
      generationReference.current += 1;
      controllerReference.current?.abort();
      controllerReference.current = undefined;
    };
  }, [message.detailRef?.type, message.messageId]);

  React.useEffect(() => {
    if (active) return;
    generationReference.current += 1;
    controllerReference.current?.abort();
    controllerReference.current = undefined;
    setExpanded(false);
    setLoading(false);
    setDetail(null);
    setError(null);
  }, [active]);

  const displayTruncation = getDisplayTruncation(message);
  if (!loadMessageDetail || (!message.detailRef && displayTruncation?.capability !== 'detail')) return null;

  const handleLoad = async (reload = false) => {
    if (detail !== null && !reload) {
      setExpanded(previous => !previous);
      return;
    }
    onActivate?.(message.messageId);
    generationReference.current += 1;
    const generation = generationReference.current;
    controllerReference.current?.abort();
    const controller = new AbortController();
    controllerReference.current = controller;
    setLoading(true);
    setError(null);
    try {
      const raw = await loadMessageDetail(message, {
        limit: MEMELOOP_MESSAGE_DETAIL_LIMIT,
        maxBytes: MEMELOOP_MESSAGE_DETAIL_MAX_BYTES,
        signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== generationReference.current) return;
      const page = raw === null ? null : validateMessageDetailPage(raw);
      const formatted = page === null ? undefined : formatMessageDetailPage(page);
      setDetail(
        formatted === undefined || formatted.text.length === 0
          ? labels.noDetails
          : `${formatted.text}${formatted.displayTruncated ? `\n\n${labels.detailTruncated}` : ''}`,
      );
      setExpanded(true);
    } catch {
      if (controller.signal.aborted || generation !== generationReference.current) return;
      setError(labels.detailLoadFailed);
    } finally {
      if (generation === generationReference.current) {
        setLoading(false);
        if (controllerReference.current === controller) controllerReference.current = undefined;
      }
    }
  };

  return (
    <Box sx={{ mt: 1 }}>
      <Button size='small' variant='outlined' onClick={() => void handleLoad()} disabled={loading}>
        {loading ? <CircularProgress size={14} sx={{ mr: 1 }} /> : null}
        {detail === null ? labels.loadDetails : expanded ? labels.hideDetails : labels.showDetails}
      </Button>
      {detail !== null && expanded && (
        <Button size='small' onClick={() => void handleLoad(true)} disabled={loading} sx={{ ml: 0.5 }}>
          {labels.reloadDetails}
        </Button>
      )}
      {message.detailRef && (
        <Typography variant='caption' color='text.secondary' sx={{ ml: 1 }}>
          {message.detailRef.type}
        </Typography>
      )}
      {error && <Alert severity='error' sx={{ mt: 1 }}>{error}</Alert>}
      {expanded && detail !== null && (
        <Paper variant='outlined' sx={{ mt: 1, p: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto' }}>
          {detail}
        </Paper>
      )}
    </Box>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export const MemeLoopMessage: React.FC<MemeLoopMessageProps> = ({
  message,
  isStreaming = false,
  renderContent,
  renderTurnActions,
  onWikiTiddlerClick,
  loadMessageDetail,
  detailDisplayActive,
  onActivateDetailDisplay,
  exportMessage,
  labels: labelOverrides,
}) => {
  const exportAbortControllerReference = React.useRef<AbortController | undefined>(undefined);
  const [exporting, setExporting] = React.useState(false);
  React.useEffect(() => () => {
    exportAbortControllerReference.current?.abort(new Error('message export disposed'));
    exportAbortControllerReference.current = undefined;
  }, []);
  const labels = { ...defaultLabels, ...labelOverrides };
  const isUser = message.role === 'user';
  const displayTruncationAction = resolveDisplayTruncationAction(message, {
    detail: loadMessageDetail !== undefined,
    export: exportMessage !== undefined,
  });

  // Expired detection — uses index 0 as a fallback since we don't have global
  // ordering here; hosts that care about duration should pass renderContent.
  // The expired styling is purely visual; hosts can override it entirely.
  const expired = useMemo(() => isMessageExpired(message, 0, 1), [message]);

  const file = useMemo(() => getFileAttachment(message), [message]);
  const wikiTiddlers = useMemo(() => getWikiTiddlers(message), [message]);
  const hasAttachments = !!(file || wikiTiddlers.length > 0);

  const content = (
    <>
      {hasAttachments && (
        <>
          {file && <ImagePreview file={file} alt={labels.attachmentAlt} />}
          <WikiTiddlerChips tiddlers={wikiTiddlers} onTiddlerClick={onWikiTiddlerClick} />
        </>
      )}
      <Box data-testid={!isUser && isStreaming ? 'assistant-streaming-text' : undefined}>
        {renderContent ? renderContent(message, isUser) : <MessageContent message={message} labels={labels} />}
      </Box>
      <DetailReferencePanel
        message={message}
        loadMessageDetail={loadMessageDetail}
        labels={labels}
        active={detailDisplayActive}
        onActivate={onActivateDetailDisplay}
      />
      {displayTruncationAction === 'export' && exportMessage && (
        <Button
          size='small'
          variant='outlined'
          disabled={exporting}
          onClick={() => {
            exportAbortControllerReference.current?.abort(new Error('message export superseded'));
            const controller = new AbortController();
            exportAbortControllerReference.current = controller;
            setExporting(true);
            void exportMessage(message.messageId, { signal: controller.signal })
              .catch(() => {})
              .finally(() => {
                if (exportAbortControllerReference.current === controller) {
                  exportAbortControllerReference.current = undefined;
                  setExporting(false);
                }
              });
          }}
          sx={{ mt: 1 }}
        >
          {labels.exportFullMessage}
        </Button>
      )}
      {!isUser && renderTurnActions?.(message)}
    </>
  );

  if (isUser) {
    return (
      <Root
        $isUser
        tabIndex={-1}
        data-testid='message-bubble'
        data-memeloop-message-id={message.messageId}
        data-memeloop-turn-id={message.turnId}
        data-memeloop-turn-anchor='true'
      >
        {expired
          ? (
            <ExpiredRoot>
              <UserBubble elevation={1}>{content}</UserBubble>
            </ExpiredRoot>
          )
          : <UserBubble elevation={1}>{content}</UserBubble>}
        <MessageAvatar isUser />
      </Root>
    );
  }

  return (
    <Root
      $isUser={false}
      tabIndex={-1}
      data-testid='message-bubble'
      data-memeloop-message-id={message.messageId}
      data-memeloop-turn-id={message.turnId}
    >
      <MessageAvatar isUser={false} />
      <AgentContainer
        $expired={expired}
        data-testid={message.role === 'assistant' ? 'assistant-message' : undefined}
      >
        {content}
      </AgentContainer>
    </Root>
  );
};
