import { AuiIf, ThreadPrimitive, useAuiState } from '@assistant-ui/react';
import { Box, styled } from '@mui/material';
import type { ChatMessage } from 'memeloop';
import React from 'react';

import { MemeLoopComposer } from '../composer/MemeLoopComposer.js';
import type { MemeLoopThreadProps } from '../types.js';
import { MemeLoopMessage } from './MemeLoopMessage.js';

const Root = styled(Box)`
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
`;

const MessagesList = styled(Box)`
  flex: 1;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background-color: ${(props) => props.theme.palette.background.default};
`;

const ViewportFooter = styled(ThreadPrimitive.ViewportFooter)`
  border-top: 1px solid ${(props) => props.theme.palette.divider};
  background-color: ${(props) => props.theme.palette.background.paper};
`;

/**
 * Internal component that reads the current ChatMessage from assistant-ui context
 * and delegates to MemeLoopMessage with all slots.
 */
function ThreadMessage({
  renderMessageContent,
  renderTurnActions,
  onWikiTiddlerClick,
  loadMessageDetail,
}: {
  renderMessageContent?: (message: ChatMessage, isUser: boolean) => React.ReactNode;
  renderTurnActions?: (message: ChatMessage) => React.ReactNode;
  onWikiTiddlerClick?: (tiddler: {
    workspaceId: string;
    workspaceName: string;
    tiddlerTitle: string;
    renderedContent?: string;
  }) => void;
  loadMessageDetail?: (message: ChatMessage) => Promise<import('../types.js').MessageDetailPayload>;
}) {
  const message = useAuiState(
    (s) => s.message.metadata?.custom?.memeloop as ChatMessage | undefined,
  );
  if (!message) return null;
  return (
    <MemeLoopMessage
      message={message}
      renderContent={renderMessageContent}
      renderTurnActions={renderTurnActions}
      onWikiTiddlerClick={onWikiTiddlerClick}
      loadMessageDetail={loadMessageDetail}
    />
  );
}

export const MemeLoopThread: React.FC<MemeLoopThreadProps> = ({
  header,
  footer,
  empty,
  composerComponent: ComposerComponent = MemeLoopComposer,
  renderMessageContent,
  renderTurnActions,
  onWikiTiddlerClick,
  loadMessageDetail,
}) => {
  return (
    <ThreadPrimitive.Root>
      <Root>
        {header}
        <ThreadPrimitive.Viewport asChild>
          <MessagesList id='messages-container'>
            {empty && <AuiIf condition={(s) => s.thread.isEmpty}>{empty}</AuiIf>}
            <ThreadPrimitive.Messages>
              {() => (
                <ThreadMessage
                  renderMessageContent={renderMessageContent}
                  renderTurnActions={renderTurnActions}
                  onWikiTiddlerClick={onWikiTiddlerClick}
                  loadMessageDetail={loadMessageDetail}
                />
              )}
            </ThreadPrimitive.Messages>
          </MessagesList>
        </ThreadPrimitive.Viewport>
        <ViewportFooter>
          {footer}
          <ComposerComponent />
        </ViewportFooter>
      </Root>
    </ThreadPrimitive.Root>
  );
};
