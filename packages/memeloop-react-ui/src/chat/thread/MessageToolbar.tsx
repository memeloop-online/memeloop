import { Box } from '@mui/material';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Scope portals by the message DOM, also across separately bundled CJS entry points. */
export function MessageToolbarAction({ children }: { children: React.ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<Element | null>(null);
  useLayoutEffect(() => {
    setTarget(anchor.current?.closest('[data-memeloop-message-id]')?.querySelector('[data-message-render-actions]') ?? null);
  }, []);
  return (
    <>
      <span ref={anchor} hidden />
      {target ? createPortal(children, target) : children}
    </>
  );
}

/** Visibility is controlled by the whole message, including keyboard focus. */
export function MessageToolbar({ children }: { children?: React.ReactNode }) {
  return (
    <Box
      data-testid='message-toolbar'
      sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.5, mt: 0.5, minHeight: 32, color: 'text.secondary' }}
    >
      {children}
      <Box data-message-render-actions sx={{ display: 'flex', alignItems: 'center' }} />
    </Box>
  );
}
