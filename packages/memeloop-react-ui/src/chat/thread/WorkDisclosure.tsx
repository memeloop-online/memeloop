import { ThreadPrimitive, useAuiState } from '@assistant-ui/react';
import { Box, styled } from '@mui/material';
import type { ConversationMessageListProjection } from 'memeloop';
import React from 'react';

import { useMemeLoopChatContext } from '../runtime/MemeLoopChatContext.js';
import type { MemeLoopMessageLabels } from './MemeLoopMessage.js';
import { buildWorkDisclosure, type WorkNode } from './workDisclosureModel.js';

const StyledDetails = styled('details')(({ theme }) => ({
  minWidth: 0,
  borderInlineStart: `2px solid ${theme.palette.divider}`,
  paddingInlineStart: 12,
  '& > summary': {
    cursor: 'pointer',
    color: theme.palette.text.secondary,
    paddingBlock: 8,
    minHeight: 36,
    overflowWrap: 'anywhere',
    '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 },
  },
  '&[open] > summary': { marginBottom: 4 },
}));

export function WorkDetails(props: React.ComponentProps<'details'>) {
  return <StyledDetails {...props} />;
}

const MessageRendererContext = React.createContext<React.ReactNode>(null);
function ResidentMessage() {
  return React.useContext(MessageRendererContext);
}
const messageComponents = { Message: ResidentMessage };

export function WorkDisclosureMessages({ children, labels }: {
  children: React.ReactNode;
  labels?: Partial<MemeLoopMessageLabels>;
}) {
  const { adapter, isSubmitting } = useMemeLoopChatContext();
  const messages = useAuiState(state => state.thread.messages);
  const rows = messages.flatMap((message, index) => {
    const projected = message.metadata?.custom?.memeloop as ConversationMessageListProjection | undefined;
    return projected ? [{ message: projected, index }] : [];
  });
  const nodes = buildWorkDisclosure(rows, {
    isRunning: adapter.isRunning || isSubmitting === true,
    hasMoreAfter: adapter.hasMoreAfter === true || adapter.isAtLiveTail === false,
  });
  const renderNode = (node: WorkNode): React.ReactNode =>
    node.kind === 'message'
      ? <ThreadPrimitive.MessageByIndex key={node.key} index={node.row.index} components={messageComponents} />
      : (
        <WorkDetails key={node.key} data-testid={node.kind === 'work' ? 'work-disclosure' : 'tool-group-disclosure'}>
          <summary>
            {node.kind === 'work'
              ? (labels?.workSteps?.(node.steps) ?? `Worked ${node.steps} steps`)
              : (labels?.toolSteps?.(node.steps) ?? `${node.steps} tool calls`)}
          </summary>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>{node.children.map(renderNode)}</Box>
        </WorkDetails>
      );
  return <MessageRendererContext.Provider key={adapter.conversationId} value={children}>{nodes.map(renderNode)}</MessageRendererContext.Provider>;
}
