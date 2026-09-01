import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import LibraryBooksIcon from '@mui/icons-material/LibraryBooks';
import PersonIcon from '@mui/icons-material/Person';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import { Alert, Avatar, Box, Button, Chip, CircularProgress, Collapse, Paper, styled, Typography } from '@mui/material';
import React, { useMemo } from 'react';

import { MessageContent } from '../content/MessageContent.js';
import type { MessageContentLabels } from '../content/MessageContent.js';
import { getDisplayTruncation, resolveDisplayTruncationAction } from '../displayBounds.js';
import { formatMessageDetailPage, MEMELOOP_MESSAGE_DETAIL_LIMIT, MEMELOOP_MESSAGE_DETAIL_MAX_BYTES, validateMessageDetailPage } from '../messageDetail.js';
import { MEMELOOP_REASONING_PAGE_MAX_BYTES, messageReasoningProjection, validateMessageReasoningPage } from '../messageReasoning.js';
import type { MemeLoopMessageProps, WikiTiddlerClickData } from '../types.js';
import {
  imageAttachmentReferences,
  isSafeRasterImageMimeType,
  MEMELOOP_VISIBLE_ATTACHMENT_MAX_BYTES,
  MEMELOOP_VISIBLE_ATTACHMENT_MAX_COUNT,
  messageHydrationIdentity,
  messageHydrationRevision,
  messageNeedsVisibleAttachmentHydration,
} from '../visibleAttachmentHydration.js';
import type { MemeLoopVisibleAttachmentHydrationResult } from '../visibleAttachmentHydration.js';
import { subscribeVisibleAttachmentHydration } from '../visibleAttachmentHydrationStore.js';

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
  const [preview, setPreview] = React.useState<Readonly<{ file: File; url: string }> | undefined>();

  React.useEffect(() => {
    setPreview(undefined);
    if (
      typeof File === 'undefined' || !(file instanceof File) ||
      !isSafeRasterImageMimeType(file.type) || typeof URL.createObjectURL !== 'function'
    ) return;
    try {
      const objectUrl = URL.createObjectURL(file);
      setPreview({ file, url: objectUrl });
      return () => {
        revokePreviewUrls([{ url: objectUrl }]);
      };
    } catch {
      // A local composer preview is optional; allocation failure must not
      // escape the React effect or leave a stale preview visible.
      setPreview(undefined);
    }
  }, [file]);

  const url = preview && preview.file === file ? preview.url : undefined;
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
        cursor: 'default',
      }}
    />
  );
}

function HydratedImagePreviews({
  alt,
  hydration,
  onError,
}: {
  alt: string;
  hydration: MemeLoopVisibleAttachmentHydrationResult | null;
  onError: (error: unknown) => void;
}) {
  const [previews, setPreviews] = React.useState<readonly { key: string; name: string; url: string }[]>([]);

  React.useEffect(() => {
    const created: Array<{ key: string; name: string; url: string }> = [];
    try {
      if (typeof URL.createObjectURL === 'function') {
        for (const attachment of hydration?.attachments ?? []) {
          if (attachment.source.kind !== 'bytes') continue;
          // Use an exact ArrayBuffer copy. It keeps SharedArrayBuffer and mutable
          // host views outside Blob/object-URL lifetime.
          const bytes = new Uint8Array(attachment.source.data);
          const url = URL.createObjectURL(new Blob([bytes.buffer], { type: attachment.reference.mimeType }));
          created.push({ key: attachment.reference.contentHash, name: attachment.reference.filename, url });
        }
      }
      setPreviews(created);
    } catch (error) {
      revokePreviewUrls(created);
      setPreviews([]);
      onError(error);
      return;
    }
    return () => {
      revokePreviewUrls(created);
    };
  }, [hydration, onError]);

  if (previews.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 1 }}>
      {previews.map(preview => (
        <Box
          key={preview.key}
          component='img'
          src={preview.url}
          alt={`${alt}: ${preview.name}`}
          data-testid='message-image-attachment'
          sx={{ maxWidth: '100%', maxHeight: 300, borderRadius: 1, display: 'block', cursor: 'default' }}
        />
      ))}
    </Box>
  );
}

function revokePreviewUrls(previews: readonly { url: string }[]): void {
  for (const preview of previews) {
    try {
      URL.revokeObjectURL(preview.url);
    } catch {
      // Object URL cleanup is best-effort and must not escape a React effect.
    }
  }
}

function useVisibleAttachmentHydration(
  message: MemeLoopMessageProps['message'],
  loader: MemeLoopMessageProps['loadVisibleAttachments'],
  residentRevision: string | undefined,
  enabled: boolean,
  onError: MemeLoopMessageProps['onAttachmentHydrationError'],
) {
  const rootReference = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = React.useState(() => typeof IntersectionObserver === 'undefined');
  const [hydration, setHydration] = React.useState<MemeLoopVisibleAttachmentHydrationResult | null>(null);
  const [error, setError] = React.useState<Error | null>(null);
  const reportError = React.useCallback((value: unknown) => {
    const normalized = value instanceof Error ? value : new Error('attachment hydration failed');
    setError(normalized);
    try {
      onError?.(normalized);
    } catch {
      // Host observers are notifications and cannot reject rendering.
    }
  }, [onError]);

  React.useEffect(() => {
    if (!enabled) {
      setVisible(false);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const node = rootReference.current;
    if (!node) return;
    const observer = new IntersectionObserver(entries => {
      setVisible(entries.some(entry => entry.target === node && entry.isIntersecting));
    }, { threshold: 0 });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [enabled, message.messageId]);

  React.useEffect(() => {
    setHydration(null);
    setError(null);
    if (!loader || !enabled || !visible) return;
    const identity = messageHydrationIdentity(message);
    const revision = messageHydrationRevision(message, residentRevision);
    const references = imageAttachmentReferences(message);
    return subscribeVisibleAttachmentHydration(
      loader,
      {
        message,
        identity,
        revision,
        references,
        referencesOmitted: references.length === 0 && messageNeedsVisibleAttachmentHydration(message),
        maxCount: MEMELOOP_VISIBLE_ATTACHMENT_MAX_COUNT,
        maxBytes: MEMELOOP_VISIBLE_ATTACHMENT_MAX_BYTES,
      },
      {
        result: value => {
          setHydration(value);
        },
        error: reportError,
      },
    );
  }, [enabled, loader, message, reportError, residentRevision, visible]);

  return { error, hydration, reportError, rootReference };
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
  attachmentLoadFailed: string;
  noDetails: string;
  loadDetails: string;
  reloadDetails: string;
  hideDetails: string;
  showDetails: string;
  detailTruncated: string;
  detailLoadFailed: string;
  exportFullMessage: string;
  reasoning: string;
  thinking: string;
  showReasoning: string;
  hideReasoning: string;
  loadMoreReasoning: string;
  reasoningLoadFailed: string;
}

const defaultLabels: MemeLoopMessageLabels = {
  attachmentAlt: 'Attachment',
  attachmentLoadFailed: 'Attachment preview could not be loaded.',
  noDetails: 'No details available.',
  loadDetails: 'Load details',
  reloadDetails: 'Reload details',
  hideDetails: 'Hide details',
  showDetails: 'Show details',
  detailTruncated: 'Only a bounded detail fragment is shown. Export the conversation for complete content.',
  detailLoadFailed: 'Details could not be loaded.',
  exportFullMessage: 'Export full message',
  reasoning: 'Reasoning',
  thinking: 'Thinking…',
  showReasoning: 'Show reasoning',
  hideReasoning: 'Hide reasoning',
  loadMoreReasoning: 'Load more reasoning',
  reasoningLoadFailed: 'Reasoning could not be loaded.',
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

function ReasoningPanel({
  message,
  isStreaming,
  loadMessageReasoning,
  labels,
}: {
  message: MemeLoopMessageProps['message'];
  isStreaming: boolean;
  loadMessageReasoning?: MemeLoopMessageProps['loadMessageReasoning'];
  labels: MemeLoopMessageLabels;
}) {
  const projection = messageReasoningProjection(message);
  const liveText = projection?.text ?? '';
  const totalBytes = projection?.totalBytes ?? 0;
  const [expanded, setExpanded] = React.useState(false);
  const [text, setText] = React.useState(liveText);
  const [loadedBytes, setLoadedBytes] = React.useState(() => new TextEncoder().encode(liveText).byteLength);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);
  const controllerReference = React.useRef<AbortController | undefined>(undefined);

  React.useEffect(() => {
    controllerReference.current?.abort();
    controllerReference.current = undefined;
    setExpanded(false);
    setText(liveText);
    setLoadedBytes(new TextEncoder().encode(liveText).byteLength);
    setLoading(false);
    setLoadError(false);
    return () => {
      controllerReference.current?.abort();
      controllerReference.current = undefined;
    };
    // Message identity owns async paging. Live deltas are merged separately.
  }, [message.messageId]);

  React.useEffect(() => {
    if (liveText.length === 0) return;
    const nextBytes = new TextEncoder().encode(liveText).byteLength;
    setText(previous => nextBytes >= loadedBytes ? liveText : previous);
    setLoadedBytes(previous => Math.max(previous, nextBytes));
  }, [liveText, loadedBytes]);

  if (totalBytes === 0) return null;
  const hasMore = loadedBytes < totalBytes;
  const loadMore = async () => {
    if (!loadMessageReasoning || loading || isStreaming || !hasMore) return;
    controllerReference.current?.abort();
    const controller = new AbortController();
    controllerReference.current = controller;
    setLoading(true);
    setLoadError(false);
    try {
      const page = validateMessageReasoningPage(
        await loadMessageReasoning(message, {
          offset: loadedBytes,
          maxBytes: MEMELOOP_REASONING_PAGE_MAX_BYTES,
          signal: controller.signal,
        }),
        { offset: loadedBytes, maxBytes: MEMELOOP_REASONING_PAGE_MAX_BYTES },
      );
      controller.signal.throwIfAborted();
      if (!page.found) throw new Error('message reasoning not found');
      const next = new TextDecoder('utf-8', { fatal: true }).decode(page.bytes);
      setText(previous => previous + next);
      setLoadedBytes(page.offset + page.bytes.byteLength);
    } catch {
      if (!controller.signal.aborted) setLoadError(true);
    } finally {
      if (controllerReference.current === controller) {
        controllerReference.current = undefined;
        setLoading(false);
      }
    }
  };

  return (
    <Paper variant='outlined' data-testid='message-reasoning' sx={{ mb: 1, overflow: 'hidden' }}>
      <Button
        fullWidth
        size='small'
        aria-expanded={expanded}
        aria-controls={`message-reasoning-${message.messageId}`}
        onClick={() => {
          setExpanded(previous => !previous);
        }}
        endIcon={<ExpandMoreIcon sx={{ transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform 150ms' }} />}
        sx={{ justifyContent: 'space-between', px: 1.5, textTransform: 'none' }}
      >
        {isStreaming ? labels.thinking : labels.reasoning}
        <Box
          component='span'
          sx={{ position: 'absolute', width: 1, height: 1, p: 0, m: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }}
        >
          {expanded ? labels.hideReasoning : labels.showReasoning}
        </Box>
      </Button>
      <Collapse in={expanded}>
        <Box
          id={`message-reasoning-${message.messageId}`}
          data-testid='message-reasoning-text'
          sx={{ px: 1.5, pb: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto' }}
        >
          {text}
          {loadError && <Alert severity='error' sx={{ mt: 1 }}>{labels.reasoningLoadFailed}</Alert>}
          {hasMore && !isStreaming && loadMessageReasoning && (
            <Button size='small' onClick={() => void loadMore()} disabled={loading} sx={{ display: 'flex', mt: 1 }}>
              {loading && <CircularProgress size={14} sx={{ mr: 1 }} />}
              {labels.loadMoreReasoning}
            </Button>
          )}
        </Box>
      </Collapse>
    </Paper>
  );
}

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
  loadMessageReasoning,
  loadVisibleAttachments,
  attachmentRevision,
  onAttachmentHydrationError,
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
  const file = useMemo(() => getFileAttachment(message), [message]);
  const hydrationEnabled = !file && !!loadVisibleAttachments && messageNeedsVisibleAttachmentHydration(message);
  const { error: attachmentHydrationError, hydration, reportError: reportAttachmentHydrationError, rootReference } = useVisibleAttachmentHydration(
    message,
    loadVisibleAttachments,
    attachmentRevision,
    hydrationEnabled,
    onAttachmentHydrationError,
  );
  const displayTruncationAction = resolveDisplayTruncationAction(message, {
    detail: loadMessageDetail !== undefined,
    export: exportMessage !== undefined,
  });

  // Expired detection — uses index 0 as a fallback since we don't have global
  // ordering here; hosts that care about duration should pass renderContent.
  // The expired styling is purely visual; hosts can override it entirely.
  const expired = useMemo(() => isMessageExpired(message, 0, 1), [message]);

  const wikiTiddlers = useMemo(() => getWikiTiddlers(message), [message]);
  const hasAttachments = !!(file || hydration?.attachments.length || wikiTiddlers.length > 0);

  const content = (
    <>
      {hasAttachments && (
        <>
          {file && <ImagePreview file={file} alt={labels.attachmentAlt} />}
          {!file && <HydratedImagePreviews hydration={hydration} alt={labels.attachmentAlt} onError={reportAttachmentHydrationError} />}
          <WikiTiddlerChips tiddlers={wikiTiddlers} onTiddlerClick={onWikiTiddlerClick} />
        </>
      )}
      {attachmentHydrationError && <Alert severity='warning' sx={{ mb: 1 }}>{labels.attachmentLoadFailed}</Alert>}
      {!isUser && (
        <ReasoningPanel
          message={message}
          isStreaming={isStreaming}
          loadMessageReasoning={loadMessageReasoning}
          labels={labels}
        />
      )}
      {(
        isUser || message.content.trim().length > 0 ||
        messageReasoningProjection(message) === undefined
      ) && (
        <Box data-testid={!isUser && isStreaming ? 'assistant-streaming-text' : undefined}>
          {renderContent ? renderContent(message, isUser) : <MessageContent message={message} labels={labels} />}
        </Box>
      )}
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
        ref={rootReference}
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
      ref={rootReference}
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
