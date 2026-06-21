import LibraryBooksIcon from '@mui/icons-material/LibraryBooks';
import PersonIcon from '@mui/icons-material/Person';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import { Avatar, Box, Chip, Paper, styled } from '@mui/material';
import React, { useMemo } from 'react';

import { MessageContent } from '../content/MessageContent.js';
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

function ImagePreview({ file }: { file: unknown }) {
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
      alt='Attachment'
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

// ── Main component ───────────────────────────────────────────────────────────

export const MemeLoopMessage: React.FC<MemeLoopMessageProps> = ({
  message,
  renderContent,
  renderTurnActions,
  onWikiTiddlerClick,
}) => {
  const isUser = message.role === 'user';

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
          {file && <ImagePreview file={file} />}
          <WikiTiddlerChips tiddlers={wikiTiddlers} onTiddlerClick={onWikiTiddlerClick} />
        </>
      )}
      {renderContent ? renderContent(message, isUser) : <MessageContent message={message} />}
      {!isUser && renderTurnActions?.(message)}
    </>
  );

  if (isUser) {
    return (
      <Root $isUser data-testid='message-bubble'>
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
    <Root $isUser={false} data-testid='message-bubble'>
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
