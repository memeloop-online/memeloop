import PersonIcon from "@mui/icons-material/Person";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import { Avatar, Box, Paper, styled } from "@mui/material";
import React from "react";

import { MessageContent } from "../content/MessageContent.js";
import type { MemeLoopMessageProps } from "../types.js";

const Root = styled(Box, {
  shouldForwardProp: (property) => property !== "$isUser",
})<{ $isUser: boolean }>`
  display: flex;
  gap: 12px;
  max-width: ${(props) => (props.$isUser ? "80%" : "100%")};
  align-self: ${(props) => (props.$isUser ? "flex-end" : "flex-start")};
`;

const UserBubble = styled(Paper)`
  background-color: ${(props) => props.theme.palette.primary.light};
  color: ${(props) => props.theme.palette.primary.contrastText};
  padding: 12px 16px;
  border-radius: 12px;
`;

const AgentContainer = styled(Box)`
  width: 100%;
  padding: 4px 0;
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

export const MemeLoopMessage: React.FC<MemeLoopMessageProps> = ({ message, renderContent }) => {
  const isUser = message.role === "user";

  return (
    <Root $isUser={isUser} data-testid="message-bubble">
      {isUser ? (
        <>
          <UserBubble elevation={1}>
            {renderContent ? renderContent(message, true) : <MessageContent message={message} />}
          </UserBubble>
          <MessageAvatar isUser />
        </>
      ) : (
        <>
          <MessageAvatar isUser={false} />
          <AgentContainer>
            {renderContent ? renderContent(message, false) : <MessageContent message={message} />}
          </AgentContainer>
        </>
      )}
    </Root>
  );
};
