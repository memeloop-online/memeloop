import { Box, Button, useTheme } from '@mui/material';
import type { ConversationMessageListProjection } from 'memeloop';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getDisplayTruncation } from '../displayBounds.js';
import { MessageToolbarAction } from '../thread/MessageToolbar.js';
import { MessageContent } from './MessageContent.js';

export interface RenderedMessageContentProps {
  message: ConversationMessageListProjection;
  /** Host-owned format renderer. undefined means the workspace is unavailable. */
  renderHtml?: (text: string, signal: AbortSignal) => Promise<string | undefined>;
  onInternalLink?: (title: string) => void;
  onRenderError?: (error: unknown) => void;
  messageLabels?: import('./MessageContent.js').MessageContentProps['labels'];
  labels?: { source: string; rendered: string; document: string };
}

/** HTML never executes in the privileged host document. Stale render results are fenced. */
export function RenderedMessageContent(
  { message, renderHtml, onInternalLink, onRenderError, messageLabels, labels = { source: 'Source', rendered: 'Rendered', document: 'Rendered message' } }:
    RenderedMessageContentProps,
) {
  const theme = useTheme();
  const foreground = message.role === 'user' ? theme.palette.primary.contrastText : theme.palette.text.primary;
  const linkColor = message.role === 'user' ? foreground : theme.palette.primary.main;
  const [result, setResult] = useState<{ text: string; renderer: typeof renderHtml; html: string }>();
  const [showSource, setShowSource] = useState(false);
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
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    if (unsupported) {
      return () => {
        controller.abort();
      };
    }
    void (async () => {
      const html = message.contentType === 'text/html'
        ? message.content
        : await renderHtml?.(message.content, controller.signal);
      if (!controller.signal.aborted && html !== undefined) setResult({ text: message.content, renderer: renderHtml, html });
    })().catch((error: unknown) => {
      // Source text remains readable when the selected wiki stops or rendering fails.
      if (!controller.signal.aborted) onRenderError?.(error);
    });
    return () => {
      controller.abort();
    };
  }, [message.content, message.contentType, renderHtml, unsupported]);
  const html = result?.text === message.content && result.renderer === renderHtml ? result.html : undefined;
  if (unsupported || html === undefined) return <MessageContent message={message} labels={messageLabels} />;
  return (
    <Box>
      {showSource
        ? <MessageContent message={message} labels={messageLabels} />
        : (
          <Box
            ref={setFrame}
            component='iframe'
            title={labels.document}
            data-testid='rendered-message'
            sandbox='allow-same-origin'
            referrerPolicy='no-referrer'
            srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><style>html,body{background:transparent!important;color:${foreground};color-scheme:normal}body{margin:0;font:14px/1.6 system-ui;overflow-wrap:anywhere}body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}pre{white-space:pre-wrap}img{max-width:100%}a{color:${linkColor}}</style></head><body>${html}</body></html>`}
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
        )}
      <MessageToolbarAction>
        <Button
          size='small'
          data-testid='message-render-toggle'
          onClick={() => {
            setShowSource(value => !value);
          }}
        >
          {showSource ? labels.rendered : labels.source}
        </Button>
      </MessageToolbarAction>
    </Box>
  );
}
