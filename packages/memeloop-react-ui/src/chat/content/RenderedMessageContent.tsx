import { Box, useTheme } from '@mui/material';
import type { ConversationMessageListProjection } from 'memeloop';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getDisplayTruncation } from '../displayBounds.js';
import { MarkdownMessage } from './MarkdownMessage.js';
import { MessageContent } from './MessageContent.js';

export interface RenderedMessageContentProps {
  message: ConversationMessageListProjection;
  isStreaming?: boolean;
  /** Host-owned format renderer. undefined means the workspace is unavailable. */
  renderHtml?: (text: string, signal: AbortSignal) => Promise<string | undefined>;
  onInternalLink?: (title: string) => void;
  onRenderError?: (error: unknown) => void;
  messageLabels?: import('./MessageContent.js').MessageContentProps['labels'];
  labels?: { document: string; source?: string; rendered?: string };
}

function contentFormat(content: string, contentType: string | undefined): 'markdown' | 'wiki' | 'html' {
  if (contentType === 'text/html') return 'html';
  if (contentType === 'text/vnd.tiddlywiki') return 'wiki';
  if (contentType === 'text/markdown') return 'markdown';
  // Old conversations store plain-text MIME types for all model output.
  const text = content.replace(/^ {0,3}(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}(?:`{3,}|~{3,})[^\n]*$/gm, '').replace(/`[^\n`]+`/g, '');
  if (/^\s*<(?:!doctype\s|[a-z][a-z\d-]*(?=[\s/>]))/i.test(text)) return 'html';
  if (/^[ \t]*(?:\|[ \t]*)?:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/m.test(text)) return 'markdown';
  return /<\$[\w-]+|<<[^<>\n]+>>|\{\{[^\n{}]+\}\}|\[\[[^\n\]]+\]\]|''[^'\n]+''|^\s*\\(?:define|procedure|function|widget)\b|^\|.*\|[hfc]\s*$/m.test(text)
    ? 'wiki'
    : 'markdown';
}

export function RenderedMessageContent(
  { message, isStreaming = false, renderHtml, onInternalLink, onRenderError, messageLabels, labels = { document: 'Rendered message' } }: RenderedMessageContentProps,
) {
  const theme = useTheme();
  const foreground = message.role === 'user' ? theme.palette.primary.contrastText : theme.palette.text.primary;
  const linkColor = message.role === 'user' ? foreground : theme.palette.mode === 'dark' ? theme.palette.primary.light : theme.palette.primary.main;
  const [result, setResult] = useState<{ text: string; renderer: typeof renderHtml; html: string }>();
  const [height, setHeight] = useState(80);
  const frame = useRef<HTMLIFrameElement>(null);
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const setFrame = useCallback((element: HTMLIFrameElement | null) => {
    resizeObserver.current?.disconnect();
    resizeObserver.current = null;
    frame.current = element;
  }, []);
  const truncation = getDisplayTruncation(message);
  const unsupported = message.role === 'tool' || message.role === 'error' || (message.presentations?.length ?? 0) > 0 ||
    truncation?.contentTruncated === true;
  const format = isStreaming ? 'markdown' : contentFormat(message.content, message.contentType);
  useEffect(() => {
    if (unsupported || format !== 'wiki' || !renderHtml) return;
    const controller = new AbortController();
    void renderHtml(message.content, controller.signal).then(html => {
      if (!controller.signal.aborted && html !== undefined) setResult({ text: message.content, renderer: renderHtml, html });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) onRenderError?.(error);
    });
    return () => {
      controller.abort();
    };
  }, [format, message.content, renderHtml, unsupported]);
  if (unsupported) return <MessageContent message={message} labels={messageLabels} />;
  const html = format === 'html' ? message.content : result?.text === message.content && result.renderer === renderHtml ? result.html : undefined;
  if (format === 'markdown' || html === undefined) return <MarkdownMessage text={message.content} streaming={isStreaming} />;
  return (
    <Box>
      <Box
        ref={setFrame}
        component='iframe'
        title={labels.document}
        data-testid='rendered-message'
        sandbox='allow-same-origin'
        referrerPolicy='no-referrer'
        srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><style>html,body{background:transparent!important;color:${foreground};color-scheme:normal}body{margin:0;font:14px/1.6 system-ui;overflow-wrap:anywhere}body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}pre{white-space:pre-wrap}img{max-width:100%}a{color:${linkColor}}table{border-collapse:collapse;max-width:100%;margin:.75em 0}th,td{border:1px solid color-mix(in srgb,currentColor 35%,transparent);padding:.4em .65em;text-align:left}th{font-weight:600}blockquote{margin:.75em 0;padding-left:1em;border-left:3px solid currentColor}code,pre{font-family:ui-monospace,monospace}</style></head><body>${html}</body></html>`}
        onLoad={() => {
          const document = frame.current?.contentDocument;
          if (!document) return;
          const measure = () => {
            // The root scrollHeight includes the existing iframe viewport and
            // cannot shrink a short reply. Measure the natural body instead.
            setHeight(Math.min(1600, Math.max(24, Math.ceil(document.body.getBoundingClientRect().height))));
          };
          resizeObserver.current?.disconnect();
          if (typeof ResizeObserver !== 'undefined') {
            resizeObserver.current = new ResizeObserver(measure);
            resizeObserver.current.observe(document.body);
          }
          measure();
          document.addEventListener('click', event => {
            const target = event.target as Element | null;
            const link = target?.nodeType === 1 ? target.closest('a') : null;
            if (!link) return;
            event.preventDefault();
            const href = link.getAttribute('href');
            if (href?.startsWith('#') && href.length > 1) {
              try {
                onInternalLink?.(decodeURIComponent(href.slice(1)));
              } catch (error) {
                onRenderError?.(error);
              }
            }
          });
        }}
        sx={{ display: 'block', border: 0, width: '100%', minWidth: 0, height, bgcolor: 'transparent', colorScheme: 'normal' }}
      />
    </Box>
  );
}
