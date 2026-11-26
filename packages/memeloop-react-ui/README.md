# @memeloop/react-ui

Reusable React UI components and prompt-editor primitives for MemeLoop.

## What is this package?

`@memeloop/react-ui` shares React components across MemeLoop Desktop and Mobile (where React Native is available). It is organized into platform-conditional subpaths:

- `@memeloop/react-ui` – shared types and utilities
- `@memeloop/react-ui/theme` – theme tokens and helpers
- `@memeloop/react-ui/web` – web/Desktop components
- `@memeloop/react-ui/native` – lightweight React Native chat and scheduled-task components
- `@memeloop/react-ui/native/forms` – optional React Native Paper/RJSF form bindings
- `@memeloop/react-ui/chat` – MUI/assistant-ui chat primitives
- `@memeloop/react-ui/chat/core` – platform-neutral chat contracts and resident-window helpers
- `@memeloop/react-ui/agent` – agent chat, host-neutral shell, session, and execution-target UI
- `@memeloop/react-ui/agent/core` – portable `AgentSessionController` adapter with no browser, MUI, RJSF, or React Native dependency
- `@memeloop/react-ui/agent/web` – browser `File` attachment source and Web adapter wrapper
- `@memeloop/react-ui/agent/prompts` – optional RJSF-backed prompt editors
- `@memeloop/react-ui/agent/scheduling` – optional cron/scheduled-task editor
- `@memeloop/react-ui/agent/scheduling/core` – platform-neutral scheduled-task form contracts and timezone validation

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

Prompt editors additionally require the optional RJSF peers. Native consumers
should install React Native, React Native Paper, and React Native Gifted Chat,
then import platform-neutral contracts from `chat/core` so Metro never follows
the Web component graph.

## Usage

```tsx
import { AgentChatShell, useAgentSessionChatAdapter } from "@memeloop/react-ui/agent";
import { resolveAgentRunErrorPresentation } from "@memeloop/react-ui/chat/core";
import type { WebMemeLoopChatAdapter } from "@memeloop/react-ui/chat";

export function App({ adapter }: { adapter: WebMemeLoopChatAdapter }) {
  return (
    <AgentChatShell
      adapter={adapter}
      header={{ title: "Assistant" }}
      resolveErrorPresentation={(value) =>
        resolveAgentRunErrorPresentation(value, {
          localize: () => ({ title: "Agent error", message: "The agent run failed." }),
        })
      }
      genericErrorPresentation={{ title: "Agent error", message: "The operation failed." }}
    />
  );
}
```

Web and Native surfaces use the same revisioned timeline and bounded resident
message-window contracts. The UI keeps at most 50 resident messages and 256 KiB
of projected display content. Timeline pages contain at most 50 bounded markers.
A proportional Web rail represents the complete server-reported entry count
without creating one DOM node per turn. Its focusable markers expose bounded
user/participant previews and host-formatted timestamps; the highlighted band
tracks the resident viewport. Narrow/coarse-pointer surfaces switch to a 44 px
touch target and a bounded marker sheet. Native uses the same page, participant,
revision, seek, and resident limits. Repeated prompt text is never used as an
identity: hosts must project durable `turnId`/attempt lineage into timeline
entries so independent turns are not folded together.

A revision reset performs one bounded absolute retry while retaining the current
page, then atomically swaps in the replacement; a repeated reset rolls back and
reports an error, so revisions are never mixed and the visible tail does not
blank or jump during recovery.

Full-transcript and single-message exports are explicit host-owned streaming/file
operations and are never assembled by the UI. A single-message export receives
only `messageId` and an `AbortSignal`; hosts must keep the implementation
constant-memory and cancel I/O when the signal aborts.

`useAgentSessionCoreAdapter` from `agent/core` is the portable
`AgentSessionController` projection for Web and Native hosts. It accepts an
optional abortable `prepareSendMessage` hook for host-specific attachment work.
Web hosts can use `agent/web`, whose browser `File` source reads cancellable,
bounded chunks and rejects files above 64 MiB. Keep host work limited to platform
services such as file reads, timeline transport, localized typed-error
presentation, settings navigation, and streaming export.

Drag/drop payloads are synchronously snapshotted and validated before any
asynchronous host resolver runs. Multi-item selections must use
`onAttachmentsSelect` so a rejected item cannot partially update host state.
Both the resolver and atomic commit receive a conversation-scoped `AbortSignal`;
hosts must stop work when it aborts. Switching conversations or superseding a
drop fences stale results before commit. The portable
`MemeLoopSelectedAttachmentBatch<TFile>` contract contains no DOM type, while
the Web alias supplies `File` only from the Web entrypoint.

## Development

```bash
pnpm install
pnpm --filter @memeloop/react-ui build
pnpm --filter @memeloop/react-ui test
```

## License

MIT
