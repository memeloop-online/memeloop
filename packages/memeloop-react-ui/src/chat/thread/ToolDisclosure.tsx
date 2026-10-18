import { Box, Typography } from '@mui/material';
import { type ConversationMessageListProjection, readConversationToolActivity } from 'memeloop';
import React from 'react';

import type { MemeLoopMessageLabels } from './MemeLoopMessage.js';
import { WorkDetails } from './WorkDisclosure.js';
import { hasToolCommentary, isToolMessage, requiresAttention } from './workDisclosureModel.js';

export function ToolDisclosure({ message, labels, children }: {
  message: ConversationMessageListProjection;
  labels: MemeLoopMessageLabels;
  children: React.ReactNode;
}) {
  if (!isToolMessage(message) || requiresAttention(message)) return <>{children}</>;
  const activity = readConversationToolActivity(message.metadata?.toolActivity);
  const names = [...new Set(activity.map(item => item.name))];
  if (names.length === 0) names.push(...new Set(message.presentations?.map(item => item.toolName) ?? []));
  const isResult = message.role === 'tool' || message.metadata?.originalRole === 'tool';
  const hasCommentary = hasToolCommentary(message);
  return (
    <>
      {hasCommentary && children}
      <WorkDetails data-testid='tool-disclosure'>
        <summary>{names.length > 0 ? labels.toolCall(names.join(', ')) : labels.toolResult}{isResult ? ` · ${labels.toolOutput ?? 'Result'}` : ''}</summary>
        {activity.map((item, index) => (
          <React.Fragment key={`${item.callId ?? item.name}:${index}`}>
            {(item.input !== undefined || item.inputTruncated) && (
              <Box sx={{ mb: 1 }}>
                <Typography variant='caption' color='text.secondary'>{labels.toolInput ?? 'Command / arguments'}</Typography>
                {item.input !== undefined && <Box component='pre' sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', m: 0 }}>{item.input}</Box>}
                {item.inputTruncated && <Typography variant='caption'>{labels.toolInputTruncated ?? 'Arguments exceed the preview limit. Open details for more.'}</Typography>}
              </Box>
            )}
          </React.Fragment>
        ))}
        {!hasCommentary && children}
      </WorkDetails>
    </>
  );
}
