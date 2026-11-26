import { Box, useTheme } from '@mui/material';
import morphdom from 'morphdom';
import React, { useLayoutEffect, useRef, useState } from 'react';

const frameDocument = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">
<style>
html,body{background:transparent!important;color:var(--message-color);color-scheme:normal}
body{margin:0;font:14px/1.6 system-ui;overflow-wrap:anywhere}
main>:first-child{margin-top:0}main>:last-child{margin-bottom:0}
pre{white-space:pre-wrap}img{max-width:100%}a{color:var(--message-link-color)}
table{border-collapse:collapse;width:100%;margin:.75em 0}
th,td{border:1px solid color-mix(in srgb,currentColor 35%,transparent);padding:.4em .65em;text-align:start}
th{font-weight:600}blockquote{margin:.75em 0;padding-inline-start:1em;border-inline-start:3px solid currentColor}
code,pre{font-family:ui-monospace,monospace}
</style></head><body><main id="message-body"></main></body></html>`;

interface MessageHtmlFrameProps {
  html: string;
  title: string;
  isUser: boolean;
  onInternalLink?: (title: string) => void;
  onRenderError?: (error: unknown) => void;
}

export function MessageHtmlFrame({ html, title, isUser, onInternalLink, onRenderError }: MessageHtmlFrameProps) {
  const theme = useTheme();
  const foreground = isUser ? theme.palette.primary.contrastText : theme.palette.text.primary;
  const linkColor = isUser ? foreground : theme.palette.mode === 'dark' ? theme.palette.primary.light : theme.palette.primary.main;
  const [height, setHeight] = useState(24);
  const [content, setContent] = useState<HTMLElement | null>(null);
  const linkHandlers = useRef({ onInternalLink, onRenderError });

  useLayoutEffect(() => {
    linkHandlers.current = { onInternalLink, onRenderError };
  }, [onInternalLink, onRenderError]);

  useLayoutEffect(() => {
    if (!content) return;
    const measure = () => {
      setHeight(Math.min(1600, Math.max(24, Math.ceil(content.ownerDocument.body.getBoundingClientRect().height))));
    };
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(content);
    const openLink = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const link = target?.nodeType === 1 ? target.closest('a') : null;
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute('href');
      if (!href?.startsWith('#') || href.length < 2) return;
      try {
        linkHandlers.current.onInternalLink?.(decodeURIComponent(href.slice(1)));
      } catch (error) {
        linkHandlers.current.onRenderError?.(error);
      }
    };
    content.addEventListener('click', openLink);
    measure();
    return () => {
      observer?.disconnect();
      content.removeEventListener('click', openLink);
    };
  }, [content]);

  useLayoutEffect(() => {
    const style = content?.ownerDocument.documentElement.style;
    style?.setProperty('--message-color', foreground);
    style?.setProperty('--message-link-color', linkColor);
  }, [content, foreground, linkColor]);

  useLayoutEffect(() => {
    if (!content) return;
    const template = content.ownerDocument.createElement('template');
    template.innerHTML = html;
    const nextContent = template.content.ownerDocument.createElement('main');
    nextContent.append(template.content);
    try {
      morphdom(content, nextContent, {
        childrenOnly: true,
        getNodeKey: () => undefined,
        onBeforeElUpdated: (current, next) => !current.isEqualNode(next),
      });
    } catch (error) {
      linkHandlers.current.onRenderError?.(error);
    }
  }, [content, html]);

  return (
    <Box
      component='iframe'
      title={title}
      data-testid='rendered-message'
      sandbox='allow-same-origin'
      referrerPolicy='no-referrer'
      srcDoc={frameDocument}
      onLoad={event => {
        setContent(event.currentTarget.contentDocument?.getElementById('message-body') ?? null);
      }}
      sx={{ display: 'block', border: 0, width: '100%', minWidth: 0, height, bgcolor: 'transparent', colorScheme: 'normal' }}
    />
  );
}
