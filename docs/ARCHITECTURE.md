# MemeLoop Core & Node — Architecture Notes

High-level design and operational concerns for the `memeloop` and `memeloop-cli` packages. Implementation details live in source.

## Runtime and AgentToolLoop

- **MemeLoopRuntime** delegates user turns to **AgentToolLoop** when `AgentFrameworkContext.runAgentToolLoop` is set (memeloop-cli wires this after `createAgentToolLoopRunner`). Without it, runtime only persists user messages (library/test mode).
- **Cancellation**: `conversationCancellation` (a `Set<string>`) aligns with `agentToolLoop.isCancelled(conversationId)`. `cancelAgent` adds the id; a new message clears it for that conversation.

## LLM Provider (Node)

- OpenAI-compatible HTTP providers may return **SSE** when the request body sets `stream: true` and the server responds with `text/event-stream`. **AgentToolLoop** unwraps `Promise` results before treating the value as an `AsyncIterable`.

## Peer Sync

- **ChatSyncEngine** runs against **ChatSyncPeer** implementations. For JSON-RPC peers, **memeloop-cli** exposes:
  - `memeloop.sync.exchangeVersionVector`
  - `memeloop.sync.pullMissingMetadata`
  - `memeloop.sync.pullMissingMessages`
- Outbound transport: `createPeerRpcSyncTransport` → `PeerConnectionManager.sendRpcToNode`. A **ChatSyncEngine** instance is created when a peer manager exists; call `syncEngine.syncOnce()` from your host if you want periodic sync (not enabled by default in CLI).

## RPC Surface (Node)

- **File tools** are also available as `memeloop.file.read|write|list|search|tail` when `fileBaseDir` is set on the RPC context (same root as local file tools).
- **Agent definitions** for `memeloop.agent.getDefinitions` come from optional `agents:` in node YAML (`normalizeAgentDefinition` fills defaults).

## Protocol Capabilities

- **NodeCapabilities** includes `wikis: WikiInfo[]` and `imChannels` (channel ids). Consumers should tolerate empty arrays.

## IM Webhooks

- **HTTP**: `createNodeServer` serves `GET` and `POST` under `/im/webhook/<channelId>` (GET used for WeCom URL verification).
- **Platforms**: Telegram (unchanged); Discord (Ed25519 verify, Interaction ping + deferred slash commands); Lark (URL verification + plaintext `im.message.receive_v1`); WeCom (URL verify + JSON body parsing — not full XML/AES).

## Automated testing (Runtime + LLM)

- **Unit (memeloop / Vitest)**: `runtime.agentToolLoop.pipeline.test.ts` wires `createMemeLoopRuntime` with `createAgentToolLoopRunner` (same as memeloop-cli) and a scripted `ILLMProvider`, asserting a full **tool loop** (user → tool → assistant) and `initialMessage` turns.
- **Integration (memeloop-cli / Vitest)**: `nodeRuntime.openaiIntegration.test.ts` starts a local **mock OpenAI** HTTP server (`testing/mockOpenAI.ts`) returning JSON `chat/completions`, uses real **SQLite** storage, and asserts both a simple reply and a **two-step** mock sequence (tool call then final text).
- **E2E (Cucumber)**: `features/agent.feature` drives a real node over WebSocket JSON-RPC; the “tool loop” scenario uses `replySequence` on the mock server plus a test-only `e2eEcho` tool registered on the started node.

## Build Order (Monorepo)

After changing **@memeloop/protocol** or **memeloop** types consumed by memeloop-cli:

1. `pnpm --filter @memeloop/protocol build`
2. `pnpm --filter memeloop build`
3. Then build or typecheck **memeloop-cli**

Stale `dist/*.d.ts` in dependencies will otherwise produce confusing TypeScript errors.

## Multi-Agent Modules

The following modules extend MemeLoop with specialized agent capabilities and extension points:

### Agent System

- **AgentProfileRegistry** (`packages/memeloop/src/agent/agentProfileRegistry.ts`) manages task-delegation profiles pre-seeded with 5 built-in profiles (`build`, `plan`, `explore`, `oracle`, `librarian`).
- **Agent profiles** declare permission rules and optional model overrides for the `task` tool.
- **Task tool** (`memeloop/src/tools/builtins/task.ts`) delegates work synchronously or in the background, applying per-agent permissions and enforcing nesting depth limits.
- See `docs/AGENTS.md` for profile registration, task delegation, and permission configuration.

### Skills

- Core `memeloop` does not expose a runtime skill registry.
- Reusable instructions/capability packs should be distributed as prompt definitions, host wiki/template content, cloud metadata, or prompt plugins.
- See `docs/SKILLS.md` for the current boundary.

### Hooks

- **Agent loop hooks** (`packages/memeloop/src/loopAPI/hooks`) provide lifecycle slots such as `PreToolUse`, `PostToolUse`, `ContextCompaction`, `AgentStart`, and `AgentStop`.
- **Prompt plugin hooks** (`packages/memeloop/src/tools/pluginRegistry.ts`) are still used by prompt plugins and `defineTool`.
- See `docs/HOOKS.md` for lifecycle hook registration patterns.

### Plugins

- **Prompt plugin registry** (`memeloop/src/tools/pluginRegistry.ts`) stores `PromptConcatTool` instances in a global `Map`, with explicit registry override isolation for testing.
- **Plugin API** (`packages/memeloop/src/plugin`) lets host-loaded plugins register tools and agent-loop lifecycle hooks.
- Built-in plugins: `fullReplacement` (character-budget history truncation) and `dynamicPosition` (defer prompts after N user turns).
- Plugins are configured through `agentFrameworkConfig.plugins` and resolved via `createHooksWithPlugins`.
- See `docs/PLUGINS.md` for plugin manifest format, development guide, and approval policies.

### ACP (Agent Communication Protocol)

- Planned JSON-RPC 2.0 server for IDE integration (stdio / TCP / WebSocket).
- Standardizes agent discovery, session management, streaming responses, and tool execution for external clients.
- MCP-compatible method surface: `initialize`, `agents/list`, `agents/start`, `messages/send`, `messages/stream`, `tools/execute`, `tools/list`, `approval/request`.
- See `docs/ACP.md` for protocol reference, VSCode/Zed integration examples, and server startup options.

### Categories

- Planned semantic routing system that maps user requests to categories (`build`, `explore`, `visual-engineering`, `ultrabrain`, etc.).
- Categories contain keywords, preferred agents, fallback agents, and required tools.
- Enables automatic task classification and multi-agent pipeline orchestration.
- See `docs/CATEGORIES.md` for category configuration, keyword routing, and cloud admin management.
