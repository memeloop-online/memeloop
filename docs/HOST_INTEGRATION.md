# Host Integration Guide

This document captures the boundary for every MemeLoop host, including TidGi-Desktop, TidGi-Mobile, memeloop-cli, and memeloop-cloud.

The rule is simple: **MemeLoop core owns the agent model and runtime. Hosts only adapt storage, transport, platform services, and UI composition.**

## Loop Registry integration

Since the migration to plugin-driven agent loops, hosts must now:

1. Initialize the built-in loops and plugins at startup via `registerBuiltinLoops()`, `registerBuiltinToolPlugins()`, and `registerBuiltinPromptPlugins(...)` (all register into the global `getLoopRegistry()`)
2. Register their own platform plugins (e.g. Desktop wiki tools) as loop/tool/prompt plugins, and any custom profiles via `loopRegistry.registerProfile()`
3. Obtain a runner through the **registry-backed** core entry `createAgentLoopRunner(context, { definitionId, conversationId })`, which resolves the profile and calls `loopRegistry.createRunnerForProfile(profile, context)` internally — hosts must not re-implement loop resolution or call a loop factory directly
4. Drive each turn through the core turn controller `runAgentToolLoopTurn(context, input, { agentToolLoop: runner })`

See [AGENT_LOOPS.md](AGENT_LOOPS.md) for the full architecture and contract types.

## Current integration status (verified)

Snapshot of where each host stands against the heavily-refactored core (`loopAPI/` + `loops/` + `loopProfiles/`, registry-driven, two loops `agent-tool-loop` / `agent-agent-loop`, primitives-only script API, single built-in `agent-agent-loop` script `quality-gate`).

- **memeloop core** — fully migrated. `index.ts` exports only from `loopAPI/`; no `agentLoops/` references and no stale `taskAgent` / `taskAgentContract` / `memeloopTaskAgent` / `basicPromptConcatHandler` symbols remain. Empty leftover directories `src/agentLoops/` have been removed.
- **memeloop-cli** — the most complete host. Boots a real libp2p node, registers `capabilities.agentLoop = true`, wires `createAgentRuntimeDeviceRpcHandler`, and runs chat/print through the registry-backed runner with SQLite storage + an `ai`-SDK LLM provider. This is the reference integration.
- **TidGi-Desktop** — runtime is on the registry-backed core: `MemeLoopDesktopRuntime` calls `registerBuiltinLoops()` / `registerBuiltinToolPlugins()` / `registerBuiltinPromptPlugins()` and resolves runners via `createAgentLoopRunner`, then drives turns with `runAgentToolLoopTurn`. Host adapters exist: `MemeLoopDesktopStorage`, `MemeLoopDesktopLLMProvider`, `MemeLoopDesktopToolRegistry`. Status:
  - ✅ `network` field wired to `DeviceNetworkService`
  - ✅ default `agentFrameworkID` aligned to `'agent-tool-loop'` (`AGENT_TOOL_LOOP_ID`)
  - ✅ legacy `src/services/agentDefinitionService.ts` deleted
  - ✅ `wikiOperation` test fixed for ReAct streaming workflow
  - ✅ `ResizeObserver` polyfill added to vitest setup (jsdom)
  - ✅ All 57 test files, 438 tests pass (0 failures, 3 skipped)
  - ⚠ `src/services/agentDefinition` still exists as a persistence/IPC scaffold
  - ⚠ `@memeloop/react-ui` is a dependency and the prompt editor is partially on the shared lib, but the chat shell is still Desktop-local
  - ⚠ e2e is blocked by Rolldown failing to resolve `expo-sqlite` from TypeORM's `ExpoDriver`
- **TidGi-Mobile** — `DeviceNetworkService` (libp2p, Expo SecureStore identity) and `@memeloop/react-ui/native` are wired, but Mobile **does not run the core loop**: `capabilities.agentLoop = false`, and the local execution target returns a demo echo. Real conversations only work by delegating `memeloop.agent.runTurn` to a paired Desktop/CLI and pulling results via `memeloop.chat.pullAgentRunLog`.
- **memeloop-cloud** — provides account, device directory, connection grants, private-relay admission, and the LLM proxy only. It does **not** run a loop runtime and must not become a second agent runtime (no `getLoopRegistry` usage). This is correct per the boundary below.

## What lives in core

Core should define the canonical shapes and behavior once, then every host should reuse them by upgrading `memeloop`.

- Agent definitions and runtime config: `AgentDefinition`, `AgentFrameworkConfig`, `AgentDefinitionToolConfig`
- Conversation messages: `ChatMessage` and `ConversationMeta`
- The agent loop: `createAgentToolLoopRunner`
- Prompt and plugin plumbing: `promptConcatStream`, `defineTool`, plugin registry, hooks, and permission gates
- Reusable UI pieces that are meant to be shared across hosts: `@memeloop/react-ui`

If a new feature belongs to the agent domain, it should be implemented in core once and consumed everywhere.

## What a host may own

A host may provide:

- persistence backends
- OS and IPC integrations
- API clients and transport adapters
- local auth / permission surfaces
- app shell, layout, routing, and composition of reusable UI

A host may not become a second agent runtime.

## Current Desktop migration target

TidGi-Desktop is the first large host being moved onto this boundary. Its final shape should be:

- `src/services/agentInstance` keeps IPC registration, lifecycle entry points, and calls into MemeLoop core.
- `src/services/agentDefinition` keeps only Desktop persistence and IPC for saved definitions until a core repository abstraction replaces it.
- Desktop database entities may use TypeORM decorators and local table names, but their runtime values should implement MemeLoop types directly.
- Desktop platform integrations such as Electron IPC, file attachments, wiki access, external AI providers, and OS services should be adapters passed into core interfaces.
- Prompt editor schema helpers may stay in Desktop only when they are UI form helpers, not as type export barrels.

The final Desktop service layer should not contain a host-owned agent loop, message model, agent definition model, or prompt/tool orchestration model. If a directory such as `agentInstance/runtime` contains turn orchestration, assistant draft publication, tool loop control, or message normalization rules, treat it as migration scaffolding and move that behavior into `memeloop` before considering the refactor complete.

The only acceptable Desktop adapters are concrete platform adapters:

- TypeORM-backed storage implementing `IAgentStorage`
- `IExternalAPIService` wrapped as an `ILLMProvider`
- Desktop/wiki/file/MCP tool implementations registered through MemeLoop's tool and plugin interfaces
- IPC methods that expose core operations to the renderer

These adapters must use MemeLoop domain types at their public boundary. They should not introduce aliases, DTO wrappers, or bidirectional conversion layers just to preserve old Desktop field names.

## Desktop audit after the first cleanup

The first Desktop cleanup removed the largest obvious forks: Desktop no longer keeps local copies of `defineTool`, `defineToolTypes`, `toolRegistry`, or the old `agentInstance/schema.ts` barrel. Tool implementations now register through MemeLoop core and the database message entity uses the canonical `ChatMessage` identity fields directly.

That cleanup is necessary but not sufficient. The remaining Desktop code still shows several migration scaffolds that should not become permanent architecture:

- `src/services/agentDefinition` still acts as a Desktop service boundary for agent definitions. It may keep TypeORM-backed persistence and IPC temporarily, but it should not re-export `AgentDefinition` or look like the canonical source for definition types.
  - ✅ Removed `export type { AgentDefinition }` barrel from `interface.ts`.
  - ✅ 9 consumer files migrated from `@services/agentDefinitionService` to `memeloop` for `AgentDefinition` imports.
  - ✅ `agentDefinitionService.ts` no longer re-exports `AgentDefinition`.
- `src/services/agentInstance/interface.ts` still exposes a large host-owned agent runtime service: create/send/cancel, message persistence, prompt preview, tool approval, ask-question resolution, rollback, changed-file inspection, background tasks, and scheduled-task CRUD. This should shrink to IPC facades over core runtime commands plus Desktop-only operational commands.
- `src/services/agentInstance/runtime` is now a thinner bridge into `runAgentToolLoopTurn`, but it still constructs the runtime context, merges framework/tool config, owns cancellation wiring, maps progress into Desktop status, and routes storage back through `IAgentInstanceService`. Treat it as temporary until core owns the conversation controller and turn lifecycle.
- `src/services/agentInstance/utilities.ts` still owns canonical-looking factories and field lists such as message fields, agent instance fields, and initial instance construction. These helpers belong in MemeLoop core or in a TypeORM repository adapter with no exported domain significance.
  - ✅ `createAgentMessage` and `createAgentInstanceData` removed from `utilities.ts` (consumers use core `createChatMessage` / `createAgentInstanceFromDefinition`).
  - 🔲 `MESSAGE_FIELDS`, `AGENT_INSTANCE_FIELDS`, `toDatabaseCompatible*` are TypeORM-specific and may stay in Desktop as concrete database adapters.
- Desktop renderer state still owns chat orchestration through Zustand stores, message maps, streaming flags, and subscriptions. `@memeloop/react-ui` already provides shared chat rendering primitives, but the shared state/controller layer is not yet upstreamed.
- Core itself needs cleanup before it becomes the stable upstream API: repeated interface declarations in `packages/memeloop/src/types.ts` should be deduplicated, and the runtime API should expose the host integration points that Desktop currently reconstructs locally.

## Next Desktop migration plan

The next phase should move behavior upward before deleting Desktop folders. Deleting `agentInstance` first would only force another host-local wrapper to reappear somewhere else.

1. Stabilize MemeLoop core contracts.
   - ✅ Deduplicate `packages/memeloop/src/types.ts` — removed duplicate `IToolRegistry`, `IChatSyncAdapter`, `INetworkService`, `AgentToolLoopRuntimeOptions`.
   - ✅ Fix pre-existing DTS build error (`agentToolLoop.ts` resolveAgentRuntimeView fallback type intersection).
   - ✅ Add core factories (`createChatMessage`, `createAgentInstanceFromDefinition`) — Desktop now imports from `memeloop` instead of defining its own.
   - 🔲 Move `mergeAgentToolsIntoFrameworkConfig`, definition resolution, runtime agent view construction, cancellation, and status/progress event semantics behind a core runtime controller.

2. Replace Desktop runtime scaffolding with core runtime composition.
   - Introduce a core `AgentRuntimeController` or equivalent API that exposes create conversation, send message, cancel, subscribe, resolve approval, resolve ask-question, delete/retry turn, and prompt preview.
   - Move the logic currently split across Desktop `MemeLoopDesktopRuntime`, `MemeLoopDesktopStorage`, `MemeLoopDesktopLLMProvider`, and `AgentInstanceService` into that controller where it is domain behavior.
   - Keep Desktop implementations only for TypeORM storage, external AI provider bridging, Electron/wiki/file/MCP tools, rollback/changelog operations, and IPC publication.

3. Collapse Desktop services to adapters and IPC.
   - Change `src/services/agentDefinition` into a repository adapter or merge it into a broader Desktop MemeLoop host adapter. Remove type re-exports from Desktop service paths.
   - Shrink `IAgentInstanceService` to the methods the renderer must call over IPC. Domain commands should mirror core runtime methods instead of inventing Desktop-specific service semantics.
   - Remove circular paths where core storage calls back into `IAgentInstanceService`; the TypeORM adapter should talk directly to repositories/entities.

4. Upstream reusable UI and state.
   - Move the generic chat controller/store from Desktop into `@memeloop/react-ui` or a companion package, using a host adapter for IPC/network transport.
   - Keep Desktop UI responsible only for shell composition: tab management, window integrations, wiki attachment picker, local preferences dialogs, and platform-specific menus.
   - Make memeloop-cloud web consume the same chat controller and reusable editor/rendering components instead of copying Desktop Zustand state.

5. Delete Desktop scaffolding in dependency order.
   - Remove Desktop type barrels and import all core types from `memeloop` directly.
   - Delete `agentInstance/runtime` after the core controller handles turn lifecycle.
   - Delete or reduce `agentInstance/utilities.ts` after core factories and TypeORM mappers exist.
   - Keep `agentInstance/tools` only as Desktop platform tool implementations registered through core, or move host-neutral tools into `memeloop`.

Each phase should end with `memeloop` build/tests, then Desktop check/lint. Do not add compatibility aliases or deprecated shims while migrating; update call sites to the new core contract and delete the old Desktop surface in the same batch.

## What a host should not define

Avoid adding host-local copies of these concepts:

- wrapper types for agent messages or definitions
- compatibility aliases such as `id` for `messageId` or `agentId` for `conversationId`
- local copies of the tool loop, prompt loop, or agent turn orchestration
- per-host mapping layers that only exist to keep outdated host code compiling
- duplicated UI logic that should be shared through a reusable package
- type re-export barrels that make host paths look like the canonical source
- `as unknown as MemeLoopType` casts used to hide a real host/core mismatch

The goal is to remove host-specific drift, not preserve it.

## Handoff rules for mechanical cleanup

Simple follow-up agents should treat this document as the contract, not as background reading.

When cleaning remaining Desktop compile errors:

1. Prefer changing import sites to import canonical types from `memeloop` directly.
2. Prefer updating MemeLoop core types or helpers when the same concept will be needed by Desktop, Mobile, CLI, and Cloud.
3. Delete Desktop-only compatibility aliases instead of adding deprecation comments.
4. Keep host adapters narrow and concrete; do not rename a wrapper to make it look like an adapter.
5. Avoid `as unknown as ...` except at a database or third-party boundary with a clear reason.
6. Do not add new `AgentInstanceMessage`, `DesktopAgentFrameworkConfig`, or `DesktopAgentDefinition` shapes in Desktop.
7. Do not fix type errors by making required core fields optional unless the field is genuinely optional across all hosts.

If a task seems to require rebuilding an agent-domain abstraction in Desktop, stop and move or design that abstraction in `memeloop` instead.

## Integration contract

A host should construct a core runtime context and hand control to MemeLoop.

The host supplies:

- `storage`
- `llmProvider`
- `tools`
- `syncAdapters`
- `network`
- optional host callbacks such as `resolveAgentDefinition`, `persistAgentMessage`, `normalizeMessage`, or `runAgentToolLoop` when the host truly needs them

The core then owns the agent turn, message persistence flow, tool execution flow, and lifecycle hooks.

## External protocol adapters (ACP)

The MemeLoop host contract above is an **in-process engine port**: storage, LLM
provider, tools, message model, sync, and network are dependency-injected so that
Desktop, Mobile, CLI, and Cloud share one agent loop.

The Agent Client Protocol (`@agentclientprotocol/sdk`) solves a different problem:
it is a cross-process JSON-RPC protocol for "editor/client ↔ external coding-agent
process" (sessions, prompts, permission requests, file system, terminal). It is
**not** a replacement for the in-process host contract, and it must **not** be
added to the `memeloop` core package dependencies. Forcing core onto an ACP
session/file/terminal model would degrade the Mobile, Cloud, IM, and TiddlyWiki
scenarios.

If MemeLoop should be drivable by Zed / VS Code / other ACP clients, add a
**separate** adapter (e.g. a `memeloop-acp` package or a CLI subcommand) that maps
ACP sessions onto core runtime calls. Borrow ACP's concept naming and event
boundaries where useful, but keep the core storage/LLM/tool/plugin contract free of
ACP schema.

## Message model

The canonical message identity is:

- `messageId`
- `conversationId`
- `originNodeId`
- `timestamp`
- `lamportClock`

Hosts should map their local database or UI needs at a single boundary, not by reintroducing aliases throughout the codebase.

That means:

- do not keep `message.id` as a parallel message identity inside host code
- do not keep `message.agentId` as a second conversation identifier inside host code
- do not keep `created` / `modified` as the source of truth when the core already provides a canonical clock and timestamp

If a host database needs a different column name, convert it in the repository or persistence adapter and keep the rest of the app on core types.

## Versioning policy

When core changes, the preferred workflow is:

1. change the core API or runtime once
2. remove obsolete host-specific code
3. upgrade each host to the new core version
4. delete compatibility shims instead of preserving them indefinitely

We do not keep forward-compatibility wrappers in each host just in case another host has not been upgraded yet.

## UI reuse

UI should follow the same principle as runtime code.

If a view, editor, renderer, or control can be shared, it should live in a reusable package and be consumed by the hosts.

Host code should compose reusable UI, not fork it.

## Future capabilities

This boundary matters for features that should arrive everywhere through a single core upgrade, for example:

- LLM agents that execute JavaScript against MemeLoop APIs
- multi-agent orchestration flows
- shared tool permissions and approval policies
- new runtime hooks or prompt modifiers

Those capabilities belong in core, not repeated separately in every host.

## Practical rule of thumb

If you feel the need to introduce a host-local type, wrapper, or adapter just to keep the host compiling, stop and check whether the core API should change instead.

If the answer is yes, change core once and let the hosts consume the new shape directly.

## Re-integration plan (current phase)

The core was heavily refactored (loop framework redesign: `agentLoops` → `loopAPI` + `loops`, `TaskAgent` → `AgentToolLoop`, primitives-only script API, quality-gate-only built-in). The current phase re-attaches that core to every host. memeloop-cli is the reference; bring the others to parity.

0. **Core hygiene (prerequisite).** Delete the empty leftover dirs `packages/memeloop/src/agentLoops/{llm-io,sub-agent,plugins}`. Build hosts against the branch that actually contains the loop redesign (the working checkout currently sits on a device-network branch; the loop redesign is on `master`).
1. **Desktop.**
   - Replace the empty `network: { start(){}, stop(){} }` stub in the runtime context with the real `DeviceNetworkService`, so remote execution placement, sync, and `pullAgentRunLog` work from Desktop.
   - Reconcile the default `agentFrameworkID: 'memeloopTaskAgent'` with a real core profile/loop id (or map it inside the definition repository adapter) and remove the stale literal from `agentDefinition` and tests.
   - Decide the fate of `src/services/agentDefinition`: collapse it into a TypeORM repository adapter and drop any type re-exports.
   - Fix e2e: resolve the TypeORM `ExpoDriver` → `expo-sqlite` Rolldown failure (mark `expo-sqlite` external in `vite.main.config.ts`) without leaking Expo into the Desktop runtime.
   - Fix the two known unit-test breakages: the `wikiOperation` test mocks the old LLM path instead of the core loop, and `@memeloop/react-ui/web` Form pulls a second React instance (needs `server.deps.inline` in the vitest config).
2. **Mobile.**
   - Stand up a real local loop: register built-in loops/plugins, provide React Native storage + LLM provider + tool adapters, set `capabilities.agentLoop = true`, and replace the demo-echo local execution target with `createAgentLoopRunner` + `runAgentToolLoopTurn`.
   - Keep remote delegation (`memeloop.agent.runTurn` + `pullAgentRunLog`) as a selectable execution target alongside local.
3. **CLI.** Keep as the reference integration; lift any host-neutral helpers that Desktop/Mobile would otherwise reinvent back into core.
4. **Cloud.** No loop runtime. Keep device directory, connection grants, relay admission, and the LLM proxy only.
5. **Shared UI.** Upstream the chat controller/store into `@memeloop/react-ui` so Desktop, Mobile, and Cloud web compose it instead of forking Zustand state.

Each host phase ends with: `memeloop` build/tests green, then that host's check/lint/tests. Do not add compatibility shims — update call sites to the current core contract and delete the old host surface in the same batch.
