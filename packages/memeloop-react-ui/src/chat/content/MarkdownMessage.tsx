import { Box } from '@mui/material';
import Markdown from 'markdown-to-jsx/react';
import React, { memo } from 'react';

const markdownOptions = {
  disableParsingRawHTML: true,
  forceWrapper: true,
  overrides: { img: ({ alt }: { alt?: string }) => <>{alt}</> },
};
const streamingOptions = { ...markdownOptions, optimizeForStreaming: true };

export const MarkdownMessage = memo(function MarkdownMessage({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Box
      data-testid='markdown-message'
      sx={{
        minWidth: 0,
        overflowX: 'auto',
        overflowWrap: 'anywhere',
        '& p, & ul, & ol, & blockquote, & pre': { my: 1 },
        '& p:first-of-type': { mt: 0 },
        '& p:last-child': { mb: 0 },
        '& table': { width: '100%', borderCollapse: 'collapse', my: 1, overflowWrap: 'normal' },
        '& th, & td': { border: 1, borderColor: 'divider', px: 1.25, py: 0.75, textAlign: 'start' },
        '& th': { bgcolor: 'action.hover' },
        '& pre': { overflowX: 'auto', bgcolor: 'action.hover', p: 1, borderRadius: 1 },
        '& blockquote': { borderInlineStart: 2, borderColor: 'divider', mx: 0, paddingInlineStart: 1.5 },
        '& a': { color: 'inherit', textDecoration: 'underline' },
      }}
    >
      <Markdown options={streaming ? streamingOptions : markdownOptions}>{text}</Markdown>
    </Box>
  );
});
