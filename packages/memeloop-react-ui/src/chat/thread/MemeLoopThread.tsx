import { AuiIf, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { Box, styled } from "@mui/material";
import type { ChatMessage } from "memeloop";
import React from "react";

import { MemeLoopComposer } from "../composer/MemeLoopComposer.js";
import type { MemeLoopThreadProps } from "../types.js";
import { MemeLoopMessage } from "./MemeLoopMessage.js";

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

function MessageRenderer({
  renderMessageContent,
}: {
  renderMessageContent?: (message: ChatMessage, isUser: boolean) => React.ReactNode;
}) {
  // ThreadPrimitive.Messages renders this inside a MessageProvider.
  // The original ChatMessage was bound to metadata.custom.memeloop in convertMessage.
  const message = useAuiState(
    (s) => s.message.metadata?.custom?.memeloop as ChatMessage | undefined,
  );
  if (!message) return null;
  return <MemeLoopMessage message={message} renderContent={renderMessageContent} />;
}

export const MemeLoopThread: React.FC<MemeLoopThreadProps> = ({
  header,
  footer,
  empty,
  messageComponent: MessageComponent = MemeLoopMessage,
  composerComponent: ComposerComponent = MemeLoopComposer,
  renderMessageContent,
}) => {
  return (
    <ThreadPrimitive.Root>
      <Root>
        {header}
        <ThreadPrimitive.Viewport asChild>
          <MessagesList id="messages-container">
            {empty && <AuiIf condition={(s) => s.thread.isEmpty}>{empty}</AuiIf>}
            <ThreadPrimitive.Messages>
              {() => (
                <MessageRenderer
                  renderMessageContent={
                    MessageComponent === MemeLoopMessage ? renderMessageContent : undefined
                  }
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
