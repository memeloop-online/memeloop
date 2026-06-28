# @memeloop/react-ui

Reusable React UI components and prompt-editor primitives for MemeLoop.

## What is this package?

`@memeloop/react-ui` shares React components across MemeLoop Desktop and Mobile (where React Native is available). It is organized into platform-conditional subpaths:

- `@memeloop/react-ui` – shared types and utilities
- `@memeloop/react-ui/theme` – theme tokens and helpers
- `@memeloop/react-ui/web` – web/Desktop components
- `@memeloop/react-ui/native` – React Native components
- `@memeloop/react-ui/chat` – chat UI primitives
- `@memeloop/react-ui/agent` – agent loop visualizers and prompt editor building blocks

## Install

```bash
pnpm add @memeloop/react-ui
# or
npm install @memeloop/react-ui
```

Peer dependencies depend on which subpaths you use. Typical web usage:

```bash
pnpm add react react-dom @mui/material @mui/icons-material @assistant-ui/react
```

## Usage

```tsx
import { ThemeProvider } from "@memeloop/react-ui/theme";
import { AgentChat } from "@memeloop/react-ui/web";

export function App() {
  return (
    <ThemeProvider>
      <AgentChat />
    </ThemeProvider>
  );
}
```

## Development

```bash
pnpm install
pnpm --filter @memeloop/react-ui build
pnpm --filter @memeloop/react-ui test
```

## License

MIT
