# Plugins

Plugins extend MemeLoop's behavior by registering `PromptConcatTool` functions that tap into the hook system. Plugins can modify prompts, intercept responses, execute tools, and transform outputs.

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
import { z } from "zod";

const configSchema = z.object({
  targetPromptId: z.string(),
  injectText: z.string(),
});

defineTool({
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
});
```

### Step 2: Manual Plugin Registration (Alternative)

For simpler cases, you can register a `PromptConcatTool` directly:

```typescript
import { pluginRegistry, getActivePluginRegistry } from "memeloop/tools/pluginRegistry";
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

// Register globally
pluginRegistry.set("myPlugin", myPlugin);

// Or register in an isolated registry
const isolatedReg = new Map<string, PromptConcatTool>();
isolatedReg.set("myPlugin", myPlugin);
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

// Register in global registry
registerBuiltinPromptPlugins();

// Or in a specific registry
const myRegistry = new Map();
registerBuiltinPromptPlugins(myRegistry);
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
registerBuiltinPromptPlugins();
```

## Plugin Installation and Management

### Global Registry

The default plugin registry is a module-level `Map`:

```typescript
import { pluginRegistry, getActivePluginRegistry } from "memeloop/tools/pluginRegistry";

// Register a plugin
pluginRegistry.set("myPlugin", myPlugin);

// Check if registered
console.log(pluginRegistry.has("myPlugin")); // true

// Get active registry (respects runWithPluginRegistry overrides)
const active = getActivePluginRegistry();
```

### Registry Override Isolation

For tests or sandboxed environments:

```typescript
import { runWithPluginRegistry } from "memeloop/tools/pluginRegistry";

const testRegistry = new Map<string, PromptConcatTool>();

runWithPluginRegistry(testRegistry, () => {
  // defineTool registrations go into testRegistry
  defineTool({ toolId: "test-plugin" /* ... */ });

  // getActivePluginRegistry() returns testRegistry inside this block
  const reg = getActivePluginRegistry();
  console.log(reg === testRegistry); // true
});

// Outside the block, global registry is unaffected
```

### Creating Hooks with Plugins

```typescript
import { createHooksWithPlugins, resolvePromptPluginMap } from "memeloop/tools/pluginRegistry";

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
    pluginRegistry: getActivePluginRegistry(),
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

defineTool({
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
});
````

### Secret Redaction Plugin

```typescript
defineTool({
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
});
```

### Conversation Summary Plugin

```typescript
defineTool({
  toolId: "conversationSummarizer",
  displayName: "Conversation Summarizer",
  description: "Summarizes long conversations",
  configSchema: z.object({
    triggerMessageCount: z.number().default(20),
  }),

  onProcessPrompts(ctx) {
    const { triggerMessageCount } = ctx.config;
    const userMessages = ctx.messages.filter((m) => m.role === "user");

    if (userMessages.length >= triggerMessageCount) {
      // Mark for compaction (actual compaction handled by AgentToolLoop autoCompact)
      ctx.agentFrameworkContext.agentToolLoop = {
        ...ctx.agentFrameworkContext.agentToolLoop,
        autoCompact: {
          threshold: triggerMessageCount,
          recentTurnsToKeep: 4,
          maxTokens: 8000,
        },
      };
    }
  },
});
```

## Testing Plugins

```typescript
import { describe, it, expect } from "vitest";
import {
  pluginRegistry,
  createAgentFrameworkHooks,
  runProcessPromptsHooks,
} from "memeloop/tools/pluginRegistry";
import { defineTool } from "memeloop/tools/defineTool";
import { z } from "zod";

describe("Custom Plugin", () => {
  it("injects content into prompts", async () => {
    defineTool({
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
    });

    const hooks = createAgentFrameworkHooks();
    const tool = pluginRegistry.get("test-injector");
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
