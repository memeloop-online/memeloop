# Agent Loops

MemeLoop core provides a plugin-driven agent loop architecture. An **agent loop** is the runtime that drives a conversation forward. Instead of a single hard-coded loop, MemeLoop supports multiple loop types, each registered and loaded through a central `LoopRegistry`.

## Two built-in loop types

### `LLM_IO_Loop` (default, `loopId: "llm-io"`)

The LLM I/O loop is the default agent loop that most agents run. It implements the classic ReAct cycle:

1. Build messages from conversation history (plus prompt plugins)
2. Call the LLM and stream the response
3. Parse tool calls from the assistant output
4. Gate each tool through the permission system (PreToolUse hooks, layered rules)
5. Execute allowed tools and persist results
6. Continue until completion or max iterations

This loop is equivalent to the former `TaskAgent`. It is registered under loop id `"llm-io"` and used by all built-in profiles such as `memeloop:general-assistant`, `memeloop:code-assistant`, and `memeloop:playwright`.

**Source:** `packages/memeloop/src/agentLoops/llm-io/`

### `SubAgent_Loop` (`loopId: "sub-agent"`)

The SubAgent loop orchestrates child agents. It does NOT call the LLM directly. Instead, a script drives the coordination logic:

- Run a child agent and pass its result to another child agent for review
- Split a task across multiple parallel child agents
- Loop back to a child agent with feedback when a reviewer rejects the output

The loop is controlled by an `.mjs` script that receives a runtime `ctx` object:

```js
// Example: multi-review workflow expressed purely as control flow
export default async function run(ctx) {
  const { objective } = ctx.input;

  // Phase 1: parallel research
  const results = await Promise.all([
    ctx.runAgent({ profile: "memeloop:explore", prompt: objective }),
    ctx.runAgent({ profile: "memeloop:explore", prompt: objective }),
    ctx.runAgent({ profile: "memeloop:explore", prompt: objective }),
  ]);

  // Phase 2: review each result
  const reviews = await Promise.all(
    results.map((r) => ctx.runAgent({ profile: "memeloop:oracle", prompt: `Review: ${r.text}` })),
  );

  // Aggregate and return
  ctx.finish(reviews.map((r) => r.text).join("\n\n"));
}
```

No review/split/verify API methods exist — these are all plain JavaScript.

**Source:** `packages/memeloop/src/agentLoops/sub-agent/`

## LoopRegistry

The `LoopRegistry` (in `packages/memeloop/src/agentLoops/registry.ts`) is a singleton that holds:

- **Loop definitions** — registered via `registerLoop({ id, name, description, createRunner })`
- **Loop profiles** — registered via `registerProfile(profile)`, each describing which loop, which `.mjs` script, which prompts, and which plugins to use
- **Loop plugins** — registered via `registerPlugin(plugin)`, each adding tools, hooks, or other capabilities

### Resolution order

```
AgentDefinition / LoopProfile
  → profile.loopId (default: "llm-io")
  → loopRegistry.getLoop(loopId)
  → loop.createRunner(context)
  → runner(input) → AsyncIterable<AgentLoopStep>
```

## LoopProfile

A `LoopProfile` is a JSON-serializable configuration that fully describes an agent:

```json
{
  "id": "memeloop:general-assistant",
  "name": "通用助手",
  "loopId": "llm-io",
  "systemPrompt": "You are a helpful assistant...",
  "modelConfig": { "provider": "memeloop", "model": "claude-opus-4.6" },
  "plugins": [
    { "id": "builtin:ask-question", "enabled": true },
    { "id": "builtin:task", "enabled": true }
  ],
  "hookPlugins": [{ "id": "builtin:full-replacement", "enabled": true }]
}
```

Profiles are stored under `packages/memeloop/src/loopProfiles/`. Built-in profiles are loaded by `getBuiltinLoopProfiles()`.

## LoopPlugins

A `LoopPlugin` is a capability extension point:

```ts
interface LoopPlugin {
  id: string; // Unique id, e.g. "builtin:spawn-agent"
  targetLoopId?: string; // "*" for all loops
  install?: (context, config?) => void; // Mutates the runtime context
}
```

Plugins are registered with the loop registry. When a profile is loaded, the registry calls `installPluginsForProfile(profile)` to install only the plugins the profile requested.

## Host integration

Hosts (Desktop, CLI, Cloud) integrate by:

1. Initializing the loop registry at startup
2. Registering their own platform plugins (e.g. wiki tools for Desktop)
3. Registering their own profiles
4. Using `loopRegistry.createRunner(loopId)` to obtain a runner for an agent

Desktop runtime example (from `MemeLoopDesktopRuntime`):

```ts
import { registerBuiltinTools, createTaskAgent } from "memeloop";

// Register core builtin tools as plugins
registerBuiltinTools(toolRegistry, {
  ...context,
  runLocalAgent,
  localNodeId: "tidgi-desktop",
});

// Create a local agent runner for sub-agent delegation
const runLocalAgent = createTaskAgent(context);
context.runTaskAgent = runLocalAgent;
```

## Contract types

All loop contracts live in `packages/memeloop/src/agentLoops/types.ts`:

- `AgentLoopInput` — standard input (conversationId, message, userMessage, resumeSession)
- `AgentLoopStep` — standard output step (thinking | tool | message | permission_request)
- `AgentLoopGenerator` — `AsyncIterable<AgentLoopStep>`
- `AgentLoopDefinition` — registered loop metadata and factory
- `LoopProfile` — full agent profile
- `LoopPlugin` — capability extension point
- `AgentLoopRuntime` — runtime context passed to loop scripts

No strategy methods (review, split, verify, goal) exist in these types. All orchestration patterns are expressed through script-level control flow and profile configuration.
