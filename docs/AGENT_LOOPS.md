# Loop API

MemeLoop core provides a plugin-driven loop architecture. A **loop** is the runtime that drives a conversation forward. Instead of a single hard-coded loop, MemeLoop supports multiple loop types, each registered and loaded through a central `LoopRegistry`.

## Two built-in loop types

### `AgentToolLoop` (default, `loopId: "agent-tool-loop"`)

The LLM I/O loop is the default agent loop that most agents run. It implements the classic ReAct cycle:

1. Build messages from conversation history (plus prompt plugins)
2. Call the LLM and stream the response
3. Parse tool calls from the assistant output
4. Gate each tool through the permission system (PreToolUse hooks, layered rules)
5. Execute allowed tools and persist results
6. Continue until completion or max iterations

This loop is the default agent/tool loop. It is registered under loop id `"agent-tool-loop"` and used by built-in profiles such as `memeloop:general-assistant`, `memeloop:code-assistant`, and `memeloop:playwright`.

**Source:** `packages/memeloop/src/loopAPI/agent-tool-loop/` and `packages/memeloop/src/loops/agent-tool-loop/`

### `AgentAgentLoop` (`loopId: "agent-agent-loop"`)

The AgentAgent loop orchestrates child agents. It does NOT call the LLM directly. Instead, a script drives the coordination logic:

- Run worker agents on the original goal
- Run reviewer agents against the candidate output
- Send failed reviews back to workers or fixers until the work is approved or the iteration budget is exhausted

The loop is controlled by an `.mjs` script that receives a runtime `ctx` object.
Scripts may be `async` functions that call `ctx.finish(...)`, or async generators that yield `AgentLoopStep` values directly.

The bundled AgentAgent workflow is `builtin:agent-agent-loop/quality-gate`. It implements a goal-driven work/review/fix loop:

```js
export default async function run(ctx) {
  let attempt;
  const history = [];

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    attempt = await ctx.runParallel({
      agents: workersFor(iteration),
      prompt: workPrompt(ctx.input.message, attempt, history),
    });

    const review = await ctx.runParallel({
      agents: reviewers,
      prompt: reviewPrompt(ctx.input.message, attempt, history),
    });

    history.push({ iteration, attempt, review });
    if (review.results.every((result) => /^APPROVED\b/im.test(result.text))) {
      ctx.finish(attempt.text);
      return;
    }
  }

  ctx.finish(finalUnapprovedAttemptWithReviewTrail(attempt, history));
}
```

Profiles configure `metadata.workers`, `metadata.reviewers`, optional `metadata.fixers`, and `metadata.maxIterations`. The base API only provides run/state/checkpoint primitives; approval policy and retry behavior live in the `.mjs` workflow.

No review/split/verify API methods exist in the base runtime — these are all plain JavaScript.

The script context deliberately stays small:

```ts
interface AgentAgentScriptContext {
  input: AgentLoopInput;
  profile?: LoopProfile;
  runAgent(input: {
    profileId?: string;
    profile?: string;
    prompt: string;
    conversationId?: string;
  }): Promise<{ profileId: string; conversationId: string; steps: AgentLoopStep[]; text: string }>;
  runAgents(
    inputs: Array<Parameters<AgentAgentScriptContext["runAgent"]>[0]>,
  ): Promise<Awaited<ReturnType<AgentAgentScriptContext["runAgent"]>>[]>;
  emit(step: AgentLoopStep): void;
  finish(message: string | AgentLoopStep): void;
  isCancelled(): boolean;
  log(event: string, data?: Record<string, unknown>): void;
  state: AgentLoopRuntime["state"];
  checkpoint: AgentLoopRuntime["checkpoint"];
}
```

This keeps the **loop API** generic while letting scripts express higher-level patterns (`review`, `split`, `verify`, `retry`) as regular JavaScript control flow.

**Source:** `packages/memeloop/src/loopAPI/agent-agent-loop/` and `packages/memeloop/src/loops/agent-agent-loop/`

## LoopRegistry

The `LoopRegistry` (in `packages/memeloop/src/loopAPI/registry.ts`) is a singleton that holds:

- **Loop definitions** — registered via `registerLoop({ id, name, description, createRunner })`
- **Loop profiles** — registered via `registerProfile(profile)`, each describing which loop, which `.mjs` script, which prompts, and which plugins to use
- **Loop plugins** — registered via `registerPlugin(plugin)`, each adding tools, hooks, or other capabilities

### Resolution order

```
AgentDefinition / LoopProfile
  → profile.loopId (default: "agent-tool-loop")
  → loopRegistry.getLoop(loopId)
  → loop.createRunner(context)
  → runner(input) → AsyncIterable<AgentLoopStep>
```

## LoopProfile

A `LoopProfile` is a JSON-serializable configuration that fully describes an agent:

```json
{
  "id": "memeloop:general-assistant",
  "name": "General Assistant",
  "loopId": "agent-tool-loop",
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
import { registerBuiltinTools, createAgentToolLoopRunner } from "memeloop";

// Register core builtin tools as plugins
registerBuiltinTools(toolRegistry, {
  ...context,
  runLocalAgent,
  localNodeId: "tidgi-desktop",
});

// Create a local agent runner for AgentAgentLoop delegation
const runLocalAgent = createAgentToolLoopRunner(context);
context.runAgentToolLoop = runLocalAgent;
```

## Contract types

All loop contracts live in `packages/memeloop/src/loopAPI/types.ts`:

- `AgentLoopInput` — standard input (conversationId, message, userMessage, resumeSession)
- `AgentLoopStep` — standard output step (thinking | tool | message | permission_request)
- `AgentLoopGenerator` — `AsyncIterable<AgentLoopStep>`
- `AgentLoopDefinition` — registered loop metadata and factory
- `LoopProfile` — full agent profile
- `LoopPlugin` — capability extension point
- `AgentLoopRuntime` — runtime context passed to loop scripts

No strategy methods (review, split, verify, goal) exist in these types. All orchestration patterns are expressed through script-level control flow and profile configuration.
