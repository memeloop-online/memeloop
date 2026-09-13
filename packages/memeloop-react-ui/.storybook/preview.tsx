import CssBaseline from '@mui/material/CssBaseline';
import GlobalStyles from '@mui/material/GlobalStyles';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import type { Preview } from '@storybook/react';
import React from 'react';

const theme = createTheme();

const globalStyles = (
  <GlobalStyles
    styles={{
      html: { height: '100%' },
      body: { height: '100%' },
      '#storybook-root': { height: '100%' },
    }}
  />
);

const preview: Preview = {
  decorators: [
    (Story) => (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {globalStyles}
        <Story />
      </ThemeProvider>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
  },
};

export default preview;
