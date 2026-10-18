import { Box } from '@mui/material';
import React from 'react';

/** Visibility is controlled by the whole message, including keyboard focus. */
export function MessageToolbar({ children }: { children?: React.ReactNode }) {
  return (
    <Box
      data-testid='message-toolbar'
      sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.5, mt: 0.5, minHeight: 32, color: 'text.secondary' }}
    >
      {children}
    </Box>
  );
}
