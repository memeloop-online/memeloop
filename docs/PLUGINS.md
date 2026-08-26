# Plugins

MemeLoop has two distinct extension systems:

- **Runtime plugins** are trusted JavaScript modules loaded by a host. They register unloadable executable capabilities through a runtime-scoped `PluginLoader`: tools, lifecycle hooks, agent profiles, loop definitions/profiles/plugins, and model providers.
- **Prompt plugins** are `PromptConcatTool` definitions selected from an agent's `agentFrameworkConfig.plugins`. They shape prompts and response handling inside one agent configuration. The older sections of this document describe this system.

Do not put a runtime plugin into `agentFrameworkConfig.plugins`, and do not use the process-global prompt-plugin `Map` as a runtime tool loader.

## Runtime plugins

Runtime plugins execute with the host process's privileges. File discovery is disabled by default in `memeloop-cli`, including ordinary mode. Enabling plugins requires a non-empty allowlist of exact plugin directories; merely entering a repository containing `.memeloop/plugins` never authorizes its code.

CLI configuration:

```yaml
plugins:
  enabled: true
  allowedPaths:
    - /opt/memeloop/plugins/tiddlywiki-tools
```

Each allowed directory contains `memeloop-plugin.json` and an ESM entry file:

```json
{
  "name": "tiddlywiki-tools",
  "version": "1.0.0",
  "description": "TiddlyWiki runtime tools",
  "minMemeloopVersion": ">=0.2.6 <0.3.0",
  "entry": "index.mjs",
  "exports": {
    "tools": ["tiddlywiki.getTiddler"],
    "hooks": ["PreToolUse"]
  }
}
```

The manifest is a strict contract. Unknown fields, invalid semver, control characters, oversized values, and entries escaping the plugin directory are rejected. Every declared export set must exactly match activation: `tools`, `hooks`, `agentProfiles`, `loopDefinitions`, `loopProfiles`, `loopPlugins`, and `modelProviders`.

```javascript
export default {
  name: "tiddlywiki-tools",
  activate(api) {
    api.registerTool("tiddlywiki.getTiddler", async ({ title }) => {
      // Call a host-owned, permission-scoped adapter here.
      return { result: await wiki.getTiddler(title) };
    });
    api.registerHook(
      "PreToolUse",
      async (_context, data) => ({
        allowed: data.toolId !== "tiddlywiki.deleteTiddler",
        reason: "Deletion is not available to this plugin",
      }),
      "protect-delete",
    );

    return async () => {
      await wiki.close();
    };
  },
};
```

Activation is atomic: conflicts, export drift, timeouts, or activation errors roll back registrations. On unload, the loader first closes the plugin to new tool requests, drains calls that already started, bounds asynchronous cleanup, and removes the plugin's tools, schemas, and hooks even when another disposer fails. The default activation, drain, and cleanup budgets are 10 seconds and can be configured on `PluginLoader`. Loader errors are surfaced through the host's `onError`/logger rather than silently ignored.

Executable extension registrations are runtime-owned and disappear on unload. Durable `AgentDefinition` records are deliberately not a plugin export: definitions are user data owned by storage and must not be deleted merely because executable plugin code unloads. A plugin may instead contribute an unloadable `AgentProfile` with `registerAgentProfile`.

Programmatic hosts should create one `PluginLoader` and `PluginRegistryManager` per runtime, inject the host's permission-aware registries through `apiOptions`, and call `await loader.unloadAllPlugins()` during shutdown. There is no process-global plugin loader or registration manager.

`AgentFrameworkContext.tools` is an explicit host-owned service, not one of the registries that `createMemeLoopRuntime` forks. Core neither clones nor disposes it. Do not reuse one mutable tool registry across concurrently active runtimes: plugin collision checks, registration, and unload would otherwise cross ownership domains. Create one registry or narrow facade per runtime, populate it from immutable tool definitions, retain its owned registration disposers, unload its `PluginLoader`, and then dispose those registrations during host shutdown. Sharing immutable implementation functions is fine; sharing their mutable registration map is not.

For TiddlyWiki/Electron integrations, keep wiki IPC, storage, permission, and lifecycle ownership in the host and expose only narrow tool implementations through this API.

## Embedding MemeLoop UI from a host plugin

An application plugin should compose the shared session and UI layers; it must not create a second message cache, paging state machine, or session lifecycle. The supported boundary is:

- Create one headless `AgentSessionController` from `memeloop` for the active conversation. Supply host-owned `AgentInstanceClient` and `AgentConversationClient` ports that perform IPC/storage/network work.
- Use `@memeloop/react-ui/agent/core` for platform-neutral React bindings and `useAgentSessionCoreAdapter`. It owns the bounded resident window, revision invalidation, anchors, directional paging, streaming state, and send cancellation.
- Browser hosts add `@memeloop/react-ui/agent/web` for DOM `File` attachment mapping. Full web views may use `@memeloop/react-ui/agent`; React Native hosts use `@memeloop/react-ui/native`.
- Keep only narrow host policy ports outside the shared layer: attachment preparation, ID allocation, execution-target selection, message-detail loading, export, and error presentation. The host owns controller `start()`/`stop()` at its view or worker lifecycle boundary.

Do not let a runtime plugin or TiddlyWiki widget call storage paging directly, retain an unbounded message array, poll independently, or reconstruct delete/retry semantics. Those paths split revision and cancellation ownership and make the UI inconsistent across full, sidebar, web, and native surfaces.

TidGi-Desktop's current downstream embedding is tracked by [PR #743](https://github.com/tiddly-gittly/TidGi-Desktop/pull/743) under `src/services/wiki/plugin/memeloopAgentUI`. Its full and sidebar entries are `tw-react` shells over the shared MemeLoop session/UI packages; they are host adapters, not separate agent runtimes. Link to the canonical `master` source only after that PR is merged, so this document never advertises a path that does not exist yet.

## Prompt plugins

Prompt plugins extend MemeLoop's agent behavior by registering `PromptConcatTool` functions that tap into the prompt/response hook system. They can modify prompts, intercept responses, execute agent-configured tools, and transform outputs.

## Plugin Manifest Format

A plugin is identified by a `toolId` and configured through the agent framework config:

```typescript
interface FrameworkPluginToolConfig {
  id: string; // Unique plugin instance ID
  toolId: string; // References the registered PromptConcatTool
  enabled?: boolean; // Whether this plugin instance is active
  approval?: ToolApprovalConfig; // Optional approval rules
  [key: string]: unknown; // Tool-specific config (e.g., `${toolId}Param`)
}
```

### Minimal Plugin Config

```json
{
  "agentFrameworkConfig": {
    "plugins": [
      {
        "id": "compactor-1",
        "toolId": "fullReplacement",
        "enabled": true
      }
    ]
  }
}
```

## How to Develop a Plugin

### Step 1: Define the Plugin with `defineTool`

The `defineTool` API is the recommended way to create plugins. It handles hook registration, config parsing, and context injection.

```typescript
import { defineTool } from "memeloop/tools/defineTool";
import type { PromptConcatTool } from "memeloop/tools/types";
import { z } from "zod";

const promptPlugins = new Map<string, PromptConcatTool>();

const configSchema = z.object({
  targetPromptId: z.string(),
  injectText: z.string(),
});

defineTool(
  {
    toolId: "contentInjector",
    displayName: "Content Injector",
    description: "Injects custom text into a target prompt",
    configSchema,

    // Called during prompt preparation
    onProcessPrompts(ctx) {
      const { targetPromptId, injectText } = ctx.config;

      ctx.injectContent({
        targetId: targetPromptId,
        content: injectText,
        position: "after", // "before" | "after" | "child"
        caption: "Injected by contentInjector",
      });
    },

    // Called after the LLM responds
    async onResponseComplete(ctx) {
      if (ctx.toolCall?.toolId === "contentInjector") {
        ctx.addToolResult({
          toolName: "contentInjector",
          parameters: ctx.toolCall.parameters,
          result: "Content injected successfully",
          isError: false,
        });
        ctx.yieldToSelf();
      }
    },
  },
  { pluginRegistry: promptPlugins },
);
```

### Step 2: Manual Plugin Registration (Alternative)

For simpler cases, you can register a `PromptConcatTool` directly:

```typescript
import type { PromptConcatTool, PromptConcatHooks } from "memeloop/tools/types";

const myPlugin: PromptConcatTool = (hooks: PromptConcatHooks) => {
  hooks.processPrompts.tapAsync("myPlugin-process", (ctx, callback) => {
    // Modify ctx.messages or ctx.prompts
    console.log("Processing prompts...");
    callback();
  });

  hooks.responseComplete.tapAsync("myPlugin-response", (ctx, callback) => {
    // Inspect or modify the response
    console.log("Response complete.");
    callback();
  });
};

const promptPlugins = new Map<string, PromptConcatTool>();
promptPlugins.set("myPlugin", myPlugin);
```

### Step 3: Configuring Plugins in Agent Definitions

```typescript
const agentDefinition: AgentDefinition = {
  id: "myteam:custom",
  name: "Custom Agent",
  description: "Agent with plugins",
  systemPrompt: "You are a custom agent.",
  tools: [],
  version: "1.0.0",
  agentFrameworkConfig: {
    plugins: [
      {
        id: "compactor-1",
        toolId: "fullReplacement",
        enabled: true,
      },
      {
        id: "injector-1",
        toolId: "contentInjector",
        enabled: true,
        contentInjectorParam: {
          targetPromptId: "system",
          injectText: "Remember to use TypeScript strict mode.",
        },
      },
    ],
  },
};
```

## Built-in Plugins Reference

### `fullReplacement`

Truncates message history by a character budget to prevent context overflow.

**Behavior:**

- Iterates messages from newest to oldest
- Keeps messages until `maxChars` exceeded
- Reverses the kept slice to maintain order

**Configuration (env):**

```bash
export MEMELOOP_FULL_REPLACEMENT_MAX_CHARS=48000
```

**Registration:**

```typescript
import { registerBuiltinPromptPlugins } from "memeloop/prompt/builtinPromptPlugins";

const promptPlugins = new Map();
registerBuiltinPromptPlugins(promptPlugins);
```

### `dynamicPosition`

Defers prompts marked with `dynamicPosition: "deferToEnd"` to the end of the prompt list after 2+ user turns.

**Use case:** Move reminder prompts or policy updates to the end of the context window after the conversation has started.

**Prompt node configuration:**

```typescript
const promptNode = {
  id: "reminder",
  text: "Remember to ask for clarification if requirements are ambiguous.",
  enabled: true,
  dynamicPosition: "deferToEnd", // Moved to end after 2 user turns
};
```

**Registration:**

```typescript
import { registerBuiltinPromptPlugins } from "memeloop/prompt/builtinPromptPlugins";
registerBuiltinPromptPlugins(promptPlugins);
```

## Plugin Installation and Management

### Runtime-owned registry

Create one prompt-plugin map per runtime and pass it to registration and execution APIs. Set the same map on `AgentFrameworkContext.promptPlugins`, or expose it through `context.tools.getPromptPlugins()`. Missing runtime ownership is a configuration error; production prompt resolution does not fall back to the compatibility global map.

Prompt-plugin maps are also explicit runtime dependencies; there is no ambient process-global registry or async override.

### Creating Hooks with Plugins

```typescript
import { createHooksWithPlugins } from "memeloop/tools/pluginRegistry";

const { hooks, pluginConfigs } = await createHooksWithPlugins(
  {
    plugins: [
      { toolId: "fullReplacement", id: "compactor" },
      {
        toolId: "contentInjector",
        id: "injector",
        contentInjectorParam: {
          /* ... */
        },
      },
    ],
  },
  {
    pluginRegistry: promptPlugins,
  },
);

// `hooks` now has all plugin handlers tapped in
// `pluginConfigs` is the array of plugin configurations
```

## Plugin Approval

Plugins can define approval policies for tool execution:

```typescript
const pluginConfig: FrameworkPluginToolConfig = {
  id: "dangerous-tool",
  toolId: "terminalExec",
  enabled: true,
  approval: {
    mode: "confirm", // "auto" | "confirm"
    allowPatterns: ["ls", "pwd"],
    denyPatterns: ["rm -rf", "sudo"],
    timeoutMs: 30_000,
  },
};
```

Approval evaluation:

```typescript
import { evaluateApproval } from "memeloop/tools/approval";

const decision = evaluateApproval(pluginConfig.approval, "terminalExec", { command: "ls -la" });
// decision: "allow" | "deny" | "pending"
```

## Plugin Examples

### Markdown Formatter Plugin

````typescript
import { defineTool } from "memeloop/tools/defineTool";
import { z } from "zod";

const promptPlugins = new Map();

defineTool(
  {
    toolId: "markdownFormatter",
    displayName: "Markdown Formatter",
    description: "Formats assistant responses as markdown",
    configSchema: z.object({}),

    onPostProcess(ctx) {
      const { llmResponse } = ctx;
      if (!llmResponse.includes("```")) {
        // Wrap plain code in markdown fences if missing
        ctx.llmResponse = llmResponse.replace(
          /(^|\n)(function|const|import|export)\s/g,
          "$1\`\`\`typescript\n$2 ",
        );
      }
    },
  },
  { pluginRegistry: promptPlugins },
);
````

### Secret Redaction Plugin

```typescript
defineTool(
  {
    toolId: "secretRedactor",
    displayName: "Secret Redactor",
    description: "Redacts secrets from tool results",
    configSchema: z.object({
      patterns: z.array(z.string()).default(["password", "token", "secret", "api_key"]),
    }),

    onProcessPrompts(ctx) {
      // No-op during prompt phase
    },

    onResponseComplete(ctx) {
      // Redact from any tool results in the response
      const patterns = ctx.config.patterns;
      for (const msg of ctx.messages) {
        if (msg.role === "tool" && typeof msg.content === "string") {
          for (const pattern of patterns) {
            const regex = new RegExp(`${pattern}[:=]\\s*[^\\s]+`, "gi");
            msg.content = msg.content.replace(regex, `${pattern}: [REDACTED]`);
          }
        }
      }
    },
  },
  { pluginRegistry: promptPlugins },
);
```

### Long-conversation compaction

Plugins must not replace conversation history or trigger compaction from
`onProcessPrompts`. Core loads the same persistent, bounded causal context for
both real execution and prompt preview before prompt plugins run. A host may
choose `agentToolLoop.autoCompact.recentTurnsToKeep` and `maxTokens` when it
assembles the runtime; every setting remains subject to Core's hard message and
byte ceilings. This keeps audit history append-only and prevents a plugin from
silently changing what another host or device sees.

## Testing Plugins

```typescript
import { describe, it, expect } from "vitest";
import { createAgentFrameworkHooks, runProcessPromptsHooks } from "memeloop/tools/pluginRegistry";
import { defineTool } from "memeloop/tools/defineTool";
import { z } from "zod";

describe("Custom Plugin", () => {
  it("injects content into prompts", async () => {
    const promptPlugins = new Map();
    defineTool(
      {
        toolId: "test-injector",
        displayName: "Test Injector",
        description: "Injects test content",
        configSchema: z.object({ text: z.string() }),
        onProcessPrompts(ctx) {
          ctx.prompts.push({
            id: "injected",
            text: ctx.config.text,
            enabled: true,
          });
        },
      },
      { pluginRegistry: promptPlugins },
    );

    const hooks = createAgentFrameworkHooks();
    const tool = promptPlugins.get("test-injector");
    if (tool) tool(hooks);

    const result = await runProcessPromptsHooks(hooks, {
      prompts: [],
      messages: [],
      toolConfig: { toolId: "test-injector", id: "t1", "test-injectorParam": { text: "hello" } },
      agentFrameworkContext: {} as any,
    });

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].text).toBe("hello");
  });
});
```

## Best Practices

1. **Use `defineTool`** — Prefer `defineTool` over manual hook tapping for type safety and standard patterns
2. **Namespace toolIds** — Use `mycompany:pluginName` to avoid collisions
3. **Make plugins idempotent** — Running the same plugin twice should not corrupt state
4. **Validate configs** — Use Zod schemas in `defineTool` to catch config errors early
5. **Enable/disable gracefully** — Respect the `enabled` flag; skip processing when disabled
6. **Keep hooks fast** — `processPrompts` runs every LLM turn; avoid heavy computation
7. **Document mutations** — Clearly document what context properties your plugin modifies
