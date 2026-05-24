# Hooks System

MemeLoop provides a tapable-style async hook system that allows plugins and custom code to inject behavior at key points in the agent lifecycle.

## Hook Types and Lifecycle

There are **8 hook slots** in the agent framework:

| Hook Slot | Trigger Point | Typical Use |
|-----------|--------------|-------------|
| `processPrompts` | Before prompts are sent to the LLM | Modify message history, inject context, compact history |
| `finalizePrompts` | After prompt processing, before LLM call | Final prompt ordering, attachment injection |
| `postProcess` | After LLM response, before tool execution | Parse structured output, validate response format |
| `userMessageReceived` | When a new user message arrives | Pre-processing, command detection, routing |
| `agentStatusChanged` | When agent state changes (working, completed, failed) | Logging, notifications, metrics |
| `toolExecuted` | After a tool finishes execution | Post-tool validation, side effects, metrics |
| `responseUpdate` | During streaming response chunks | Real-time UI updates, token counting |
| `responseComplete` | After the full response is received | Tool call dispatch, yield control (human/self) |

### Lifecycle Flow

```
User Message
    |
    v
[userMessageReceived] ----> Process / route / log
    |
    v
[processPrompts] ---------> Compact history, inject prompts
    |
    v
[finalizePrompts] --------> Final ordering, attachments
    |
    v
LLM Call
    |
    v
[responseUpdate] ---------> Stream chunks to UI
    |
    v
[responseComplete] -------> Parse tool calls, dispatch
    |
    v
Tool Execution
    |
    v
[toolExecuted] -----------> Log result, validate
    |
    v
[postProcess] ------------> Format output, store results
    |
    v
[agentStatusChanged] -----> Notify completion
```

## Hook Slot API

Hooks follow the tapable `AsyncSeriesHook` pattern:

```typescript
export interface HookSlot {
  tapAsync(name: string, fn: (ctx: any, cb: () => void) => void): void;
  promise(ctx: unknown): Promise<void>;
}
```

- **`tapAsync(name, fn)`** — Register a handler. `name` is for debugging; `fn` receives context and a callback.
- **`promise(ctx)`** — Execute all registered handlers serially in registration order.

## How to Register Hooks

### Creating Hook Instances

```typescript
import { createAgentFrameworkHooks } from "memeloop/tools/pluginRegistry";

const hooks = createAgentFrameworkHooks();

// Now you have all 8 slots:
// hooks.processPrompts
// hooks.finalizePrompts
// hooks.postProcess
// hooks.userMessageReceived
// hooks.agentStatusChanged
// hooks.toolExecuted
// hooks.responseUpdate
// hooks.responseComplete
```

### Registering a Handler

```typescript
// Log every user message
hooks.userMessageReceived.tapAsync("logging", (ctx, callback) => {
  console.log(`[UserMessage] ${ctx.content.text}`);
  callback(); // Must call to continue to next handler
});

// Compact history before LLM call
hooks.processPrompts.tapAsync("compaction", (ctx, callback) => {
  const maxChars = 48_000;
  const msgs = ctx.messages;
  let total = 0;
  const kept: unknown[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const content = typeof msgs[i].content === "string"
      ? msgs[i].content
      : JSON.stringify(msgs[i].content);
    total += content.length;
    if (total > maxChars) break;
    kept.push(msgs[i]);
  }
  ctx.messages = kept.reverse();
  callback();
});
```

### Using `promise()` to Trigger Hooks

```typescript
import { runProcessPromptsHooks, runResponseCompleteHooks } from "memeloop/tools/pluginRegistry";

// Trigger processPrompts hooks
await runProcessPromptsHooks(hooks, {
  messages: [],
  prompts: [],
  toolConfig: { toolId: "my-tool", id: "plugin-1" },
  agentFrameworkContext: frameworkCtx,
});

// Trigger responseComplete hooks
await runResponseCompleteHooks(hooks, {
  agentFrameworkContext: frameworkCtx,
  response: { status: "done", content: "assistant response" },
  agentFrameworkConfig: { plugins: [] },
  requestId: undefined,
  toolConfig: { id: "_memeloop", toolId: "_memeloop" },
});
```

## Hook Examples

### Pre-Tool Use Logging Hook

Log every tool invocation with timing:

```typescript
hooks.toolExecuted.tapAsync("preToolUseLogger", (ctx, callback) => {
  const { toolInfo, toolResult } = ctx as ToolExecutionContext;
  const timestamp = new Date().toISOString();

  console.log(`[${timestamp}] Tool Executed: ${toolInfo.toolId}`);
  console.log(`  Parameters: ${JSON.stringify(toolInfo.parameters)}`);
  console.log(`  Success: ${toolResult.success}`);
  if (toolResult.error) {
    console.log(`  Error: ${toolResult.error}`);
  }

  callback();
});
```

### Post-Tool Use Validation Hook

Validate tool results and flag anomalies:

```typescript
hooks.toolExecuted.tapAsync("postToolValidator", (ctx, callback) => {
  const { toolInfo, toolResult } = ctx as ToolExecutionContext;

  // Flag empty successful results
  if (toolResult.success && (!toolResult.data || toolResult.data.length === 0)) {
    console.warn(`[Validator] Tool ${toolInfo.toolId} returned empty result`);
  }

  // Flag large error outputs
  if (!toolResult.success && toolResult.error && toolResult.error.length > 2000) {
    console.warn(`[Validator] Tool ${toolInfo.toolId} returned oversized error`);
  }

  callback();
});
```

### User Message Routing Hook

Route messages to different agents based on content prefix:

```typescript
hooks.userMessageReceived.tapAsync("router", (ctx, callback) => {
  const { content } = ctx as UserMessageContext;
  const text = content.text;

  if (text.startsWith("/plan ")) {
    ctx.actions = { yieldNextRoundTo: "agent:memeloop:plan" };
  } else if (text.startsWith("/explore ")) {
    ctx.actions = { yieldNextRoundTo: "agent:memeloop:explore" };
  }

  callback();
});
```

### Agent Status Notification Hook

Send notifications when agent state changes:

```typescript
hooks.agentStatusChanged.tapAsync("notifier", (ctx, callback) => {
  const { status } = ctx as AgentStatusContext;

  if (status.state === "failed") {
    // Send alert to monitoring
    sendAlert(`Agent failed at ${status.modified.toISOString()}`);
  }

  if (status.state === "completed") {
    // Update UI badge
    updateUiBadge("done");
  }

  callback();
});
```

### Response Streaming Hook

Count tokens and throttle if needed:

```typescript
let tokenCount = 0;

hooks.responseUpdate.tapAsync("tokenCounter", (ctx, callback) => {
  const { response } = ctx as AIResponseContext;
  if (response.status === "update" && typeof response.content === "string") {
    tokenCount += estimateTokens(response.content);
  }

  if (tokenCount > 100_000) {
    console.warn("Token budget exceeded");
  }

  callback();
});
```

## Hook Context Types

### PromptConcatHookContext

Used by `processPrompts`, `finalizePrompts`, and `postProcess`:

```typescript
interface PromptConcatHookContext extends BaseToolContext {
  messages: ChatMessage[];
  prompts: IPrompt[];
  toolConfig: FrameworkPluginToolConfig;
  pluginIndex?: number;
}
```

### PostProcessContext

Extends `PromptConcatHookContext` with LLM response:

```typescript
interface PostProcessContext extends PromptConcatHookContext {
  llmResponse: string;
  responses?: AgentResponse[];
}
```

### AIResponseContext

Used by `responseUpdate` and `responseComplete`:

```typescript
interface AIResponseContext extends BaseToolContext {
  toolConfig: FrameworkPluginToolConfig;
  agentFrameworkConfig?: { plugins?: FrameworkPluginToolConfig[] };
  response: AIStreamResponseSubset; // { status: "update" | "done"; content: string }
  requestId?: string;
  isFinal?: boolean;
}
```

### UserMessageContext

Used by `userMessageReceived`:

```typescript
interface UserMessageContext extends BaseToolContext {
  content: {
    text: string;
    file?: unknown;
    wikiTiddlers?: Array<{ workspaceName: string; tiddlerTitle: string }>;
  };
  messageId: string;
  timestamp: Date;
}
```

### AgentStatusContext

Used by `agentStatusChanged`:

```typescript
interface AgentStatusContext extends BaseToolContext {
  status: {
    state: "working" | "completed" | "failed" | "canceled";
    modified: Date;
  };
}
```

### ToolExecutionContext

Used by `toolExecuted`:

```typescript
interface ToolExecutionContext extends BaseToolContext {
  toolResult: {
    success: boolean;
    data?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  };
  toolInfo: {
    toolId: string;
    parameters: Record<string, unknown>;
    originalText?: string;
  };
  requestId?: string;
}
```

## Hook Integration with `defineTool`

The `defineTool` API automatically registers handlers on the hooks passed to a plugin:

```typescript
import { defineTool } from "memeloop/tools/defineTool";
import { z } from "zod";

const configSchema = z.object({
  maxHistoryChars: z.number().default(48_000),
});

defineTool({
  toolId: "historyCompactor",
  displayName: "History Compactor",
  description: "Truncates old messages by character budget",
  configSchema,
  onProcessPrompts(ctx) {
    const { maxHistoryChars } = ctx.config;
    const msgs = ctx.messages;
    let total = 0;
    const kept: unknown[] = [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const c = typeof msgs[i].content === "string" ? msgs[i].content : JSON.stringify(msgs[i].content);
      total += c.length;
      if (total > maxHistoryChars) break;
      kept.push(msgs[i]);
    }
    ctx.messages = kept.reverse();
  },
});
```

The tool above automatically taps into `hooks.processPrompts` when the plugin is activated.

## AsyncLocalStorage Isolation

Hooks and plugins support test isolation via `AsyncLocalStorage`:

```typescript
import { runWithPluginRegistry, createAgentFrameworkHooks } from "memeloop/tools/pluginRegistry";

const isolatedRegistry = new Map();

runWithPluginRegistry(isolatedRegistry, () => {
  // All plugin registrations and hook lookups inside this block
  // use the isolated registry instead of the global one
  const hooks = createAgentFrameworkHooks();
  // ... test code
});
```

## Best Practices

1. **Always call `callback()`** — Forgetting the callback will hang the hook chain
2. **Wrap in try/catch** — Errors in hooks should not crash the agent loop
3. **Keep handlers focused** — One hook, one concern
4. **Use descriptive names** — The `name` in `tapAsync` appears in debug logs
5. **Avoid side effects in `processPrompts`** — This runs every LLM turn; keep it fast
6. **Mutate context carefully** — Hooks receive shared context objects; document mutations
