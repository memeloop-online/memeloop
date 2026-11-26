import { Skeleton } from '@mui/material';
import type { ConversationMessageListProjection } from 'memeloop';
import React from 'react';
import { getDisplayTruncation } from '../displayBounds.js';
import { MarkdownMessage } from './MarkdownMessage.js';
import { MessageContent } from './MessageContent.js';
import { MessageHtmlFrame } from './MessageHtmlFrame.js';
import { useWikiTextPreview, type WikiTextRenderer } from './useWikiTextPreview.js';

export type MessageRenderFormat = 'wikitext' | 'markdown';

export interface RenderedMessageContentProps {
  message: ConversationMessageListProjection;
  isStreaming?: boolean;
  preferredFormat?: MessageRenderFormat;
  renderHtml?: WikiTextRenderer;
  wikiRevision?: number;
  onInternalLink?: (title: string) => void;
  onRenderError?: (error: unknown) => void;
  messageLabels?: import('./MessageContent.js').MessageContentProps['labels'];
  labels?: { document: string };
}

function declaredFormat(contentType: string | undefined): MessageRenderFormat | 'html' | undefined {
  if (contentType === 'text/html') return 'html';
  if (contentType === 'text/vnd.tiddlywiki') return 'wikitext';
  if (contentType === 'text/markdown') return 'markdown';
}

export function RenderedMessageContent(
  {
    message,
    isStreaming = false,
    preferredFormat = 'markdown',
    renderHtml,
    wikiRevision = 0,
    onInternalLink,
    onRenderError,
    messageLabels,
    labels = { document: 'Rendered message' },
  }: RenderedMessageContentProps,
) {
  const truncation = getDisplayTruncation(message);
  const useMessagePresentation = message.role === 'tool' || message.role === 'error' || (message.presentations?.length ?? 0) > 0 ||
    truncation?.contentTruncated === true;
  if (useMessagePresentation) return <MessageContent message={message} labels={messageLabels} />;
  const format = declaredFormat(message.contentType) ?? preferredFormat;
  if (format === 'markdown') return <MarkdownMessage text={message.content} streaming={isStreaming} />;
  const frameProps = { isUser: message.role === 'user', title: labels.document, onInternalLink, onRenderError };
  if (format === 'html') return <MessageHtmlFrame html={message.content} {...frameProps} />;
  return (
    <WikiTextMessage
      text={message.content}
      streaming={isStreaming}
      render={renderHtml}
      revision={wikiRevision}
      frame={frameProps}
      source={<MessageContent message={message} labels={messageLabels} />}
    />
  );
}

function WikiTextMessage({ text, streaming, render, revision, frame, source }: {
  text: string;
  streaming: boolean;
  render: WikiTextRenderer | undefined;
  revision: number;
  frame: Omit<React.ComponentProps<typeof MessageHtmlFrame>, 'html'>;
  source: React.ReactNode;
}) {
  const preview = useWikiTextPreview(render, text, streaming, revision, frame.onRenderError);
  if (preview?.html !== undefined) return <MessageHtmlFrame html={preview.html} {...frame} />;
  if (render && preview === undefined) return <Skeleton aria-busy='true' width='60%' animation={false} />;
  return source;
}
