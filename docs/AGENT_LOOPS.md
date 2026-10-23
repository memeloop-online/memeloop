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

The script context deliberately stays primitive. The canonical type is
`AgentAgentLoopScriptArguments` (exported as `AgentAgentScriptContext`) in
`packages/memeloop/src/loopAPI/agent-agent-loop/loop.ts`:

```ts
interface AgentAgentScriptContext {
  /** Parent turn input. `input.message` is the user's original goal. */
  input: AgentLoopInput;
  /** Active profile; scripts read their own workflow metadata from `profile.metadata`. */
  profile?: LoopProfile;
  /** Worker agents normalized from `context.agents` / `profile.metadata.agents`. */
  agents: AgentAgentDescriptor[];
  /** Read raw agent entries from `profile.metadata[key]` (e.g. "workers", "reviewers", "fixers"). */
  getAgentEntries(key?: string): AgentAgentConfigEntry[];

  /** Run one child agent and collect its yielded steps into a text result. */
  runAgent(input: AgentAgentRunAgentInput): Promise<AgentAgentRunAgentResult>;
  /** Run child agents concurrently. */
  runAgents(inputs: AgentAgentRunAgentInput[]): Promise<AgentAgentRunAgentResult[]>;
  /** Run a batch of agents in order, aggregating results and failures. */
  runSequential(input?: AgentAgentBatchRunInput): Promise<AgentAgentBatchRunResult>;
  /** Run a batch of agents concurrently, aggregating results and failures. */
  runParallel(input?: AgentAgentBatchRunInput): Promise<AgentAgentBatchRunResult>;
  /** Format a batch result for final delivery or an intermediate report. */
  formatAgentResults(
    result: AgentAgentBatchRunResult,
    options?: AgentAgentFormatResultsOptions,
  ): string;
  /** Emit a formatted batch result as the loop's final user-visible message. */
  finishAgentResults(
    result: AgentAgentBatchRunResult,
    options?: AgentAgentFormatResultsOptions,
  ): void;

  /** Emit a raw loop step upstream (helpers already emit progress). */
  emit(step: AgentLoopStep): void;
  /** Emit a final user-visible message and end the script's work. */
  finish(message: string | AgentLoopStep): void;
  /** True when the host cancelled this run; long scripts should check this between phases. */
  isCancelled(): boolean;
  log(event: string, data?: Record<string, unknown>): void;
  state: AgentLoopRuntime["state"];
  checkpoint: AgentLoopRuntime["checkpoint"];
}
```

Every member is a **scheduling / state / event primitive**. There is no
`reviewers`, `revisers`, `runQualityLoop`, `review`, `split`, or `verify` method:
those workflow nouns live only inside `.mjs` scripts and profile metadata. This
keeps the loop API generic while letting scripts express higher-level patterns
(review-and-revise, fan-out, quality gate, retry) as regular JavaScript control flow.

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

Hosts (Desktop, CLI, Cloud) create one `MemeLoopRuntime` per ownership domain,
inject host-owned storage/network/model/tool ports, and dispose it during host
shutdown. Core creates runtime-scoped loop, prompt-plugin, hook, schema, profile,
approval, and question-wait registries. A host or trusted runtime plugin may add
platform capabilities to those explicit registries; it must not mutate an
ambient process-global registry or re-implement loop resolution.

Production integration uses the durable runtime boundary:

```ts
import { createMemeLoopRuntime } from "memeloop";

const runtime = createMemeLoopRuntime(context, {
  runStateStore: durableRunStateStore,
});

const handle = await runtime.sendMessage({
  conversationId,
  definitionId,
  message,
  userMessage,
  requestId, // stable idempotency key owned by the caller/work item
  turnId,
});

// Observe handle.runId through getRunStatus/subscribeToUpdates. Cancel that
// exact run when appropriate; do not infer completion from an IPC timeout.
await runtime.dispose();
```

`context` is the host-supplied `AgentFrameworkContext` (`storage`, `llmProvider`,
`tools`, `syncAdapters`, `network`, `logger`, …). `runStateStore` and conversation
events are durable production requirements. The host never re-implements the
tool loop, bounded history projection, message normalization, retry identity, or
turn lifecycle; Core owns those. `createAgentLoopRunner` remains the lower-level
adapter for a managed orchestration driver that already owns those durable
boundaries.

## Contract types

All loop contracts live in `packages/memeloop/src/loopAPI/types.ts`:

- `AgentLoopInput` — standard input (`conversationId`, `message`, `runId`,
  `signal`, frozen `modelRoute`, and either a pending or already-persisted user root)
- `AgentLoopStep` — standard output step (thinking | tool | message | permission_request)
- `AgentLoopGenerator` — `AsyncIterable<AgentLoopStep>`
- `AgentLoopDefinition` — registered loop metadata and factory
- `LoopProfile` — full agent profile
- `LoopPlugin` — capability extension point
- `AgentLoopRuntime` — runtime context passed to loop scripts

No strategy methods (review, split, verify, goal) exist in these types. All orchestration patterns are expressed through script-level control flow and profile configuration.
