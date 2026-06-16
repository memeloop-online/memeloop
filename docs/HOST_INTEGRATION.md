# Host Integration Guide

This document captures the boundary for every MemeLoop host, including TidGi-Desktop, TidGi-Mobile, memeloop-cli, and memeloop-cloud.

The rule is simple: **MemeLoop core owns the agent model and runtime. Hosts only adapt storage, transport, platform services, and UI composition.**

## What lives in core

Core should define the canonical shapes and behavior once, then every host should reuse them by upgrading `memeloop`.

- Agent definitions and runtime config: `AgentDefinition`, `AgentFrameworkConfig`, `AgentDefinitionToolConfig`
- Conversation messages: `ChatMessage` and `ConversationMeta`
- The agent loop: `createTaskAgent`
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
- optional host callbacks such as `resolveAgentDefinition`, `persistAgentMessage`, `normalizeMessage`, or `runTaskAgent` when the host truly needs them

The core then owns the agent turn, message persistence flow, tool execution flow, and lifecycle hooks.

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
