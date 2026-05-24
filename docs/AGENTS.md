# Agent System

MemeLoop's agent system enables specialized AI agents to handle different tasks through a unified registry, permission model, and task delegation framework.

## Overview

The agent system consists of:

- **Agent Registry** — Central registry for agent definitions
- **Built-in Agent Types** — Five pre-defined specialized agents
- **TaskAgent** — ReAct loop runtime that executes agent tasks with tool calling
- **Task Tool** — Delegate work to other agents (sync or background)
- **Permission Layering** — Fine-grained tool access control per agent

## Agent Types and Their Purposes

### Built-in Agents

| Agent ID | Type | Purpose | Default Permissions |
|----------|------|---------|---------------------|
| `memeloop:build` | `build` | Execute tasks, write code, run commands | Full access (`allow`) |
| `memeloop:plan` | `plan` | Analyze requirements, decompose tasks | Read-only (`deny` + selective `allow`) |
| `memeloop:explore` | `explore` | Fast codebase search and discovery | Read + search + LSP |
| `memeloop:oracle` | `oracle` | Architecture analysis, code review | Read-only |
| `memeloop:librarian` | `librarian` | External docs lookup, web search | Read + web search |

### Agent Type Details

**Build Agent** (`memeloop:build`)
- Primary executor for writing files, running terminal commands, and making changes
- Full tool access by default
- Used when no specific specialization is needed

**Plan Agent** (`memeloop:plan`)
- Read-only agent for task decomposition and planning
- Allowed tools: `file.read`, `file.search`, `file.list`, `grep.search`, `glob.*`
- Cannot write files or execute commands

**Explore Agent** (`memeloop:explore`)
- Fast search and codebase exploration without modification
- Additional LSP tools allowed (`lsp.*`)
- Ideal for finding relevant code before changes

**Oracle Agent** (`memeloop:oracle`)
- Architecture consultation and constraint verification
- Read access only
- Used for code review and expert guidance

**Librarian Agent** (`memeloop:librarian`)
- External documentation lookup and context gathering
- Web search tools allowed (`web.*`)
- Does not modify local files

## Agent Registry

The `AgentRegistry` class manages agent definitions. It is pre-seeded with built-in agents and supports custom registrations.

### Basic Usage

```typescript
import { AgentRegistry, getAgentRegistry, resetAgentRegistry } from "memeloop/agent/agentRegistry";
import type { AgentRegistryEntry } from "memeloop/agent/agentTypes";

// Use the singleton registry (pre-seeded with 5 built-in agents)
const registry = getAgentRegistry();

// List all agents
const allAgents = registry.listAgents();
console.log(allAgents.map((a) => a.id));
// => ['memeloop:build', 'memeloop:plan', 'memeloop:explore', 'memeloop:oracle', 'memeloop:librarian']

// Get a specific agent
const buildAgent = registry.getAgent("memeloop:build");
if (buildAgent) {
  console.log(buildAgent.name); // "Build Agent"
  console.log(buildAgent.permissions.default); // "allow"
}

// Filter by type
const readOnlyAgents = registry.listAgentsByType("plan");
```

## How to Register Custom Agents

### Custom Agent Definition

```typescript
import { AgentRegistry, getAgentRegistry } from "memeloop/agent/agentRegistry";
import type { AgentRegistryEntry } from "memeloop/agent/agentTypes";

const myAgent: AgentRegistryEntry = {
  id: "myteam:reviewer",
  name: "Code Reviewer",
  type: "oracle",
  prompt:
    "You are a security-focused code reviewer. Analyze code for vulnerabilities, anti-patterns, and performance issues. Provide actionable recommendations.",
  permissions: {
    default: "deny",
    rules: [
      { pattern: "file.read", action: "allow" },
      { pattern: "file.search", action: "allow" },
      { pattern: "grep.search", action: "allow" },
      { pattern: "lsp.*", action: "allow" },
      { pattern: "terminal.*", action: "deny" },
    ],
  },
  model: "openai/gpt-4o", // optional model override
  skills: ["security-audit", "performance-review"], // optional skill identifiers
  protocolDef: {
    id: "myteam:reviewer",
    name: "Code Reviewer",
    description: "Security-focused code reviewer",
    systemPrompt:
      "You are a security-focused code reviewer. Analyze code for vulnerabilities, anti-patterns, and performance issues.",
    tools: [],
    version: "1.0.0",
    modelConfig: {
      provider: "openai",
      model: "gpt-4o",
    },
  },
};

const registry = getAgentRegistry();
registry.registerAgent(myAgent);

// Verify registration
const reviewer = registry.getAgent("myteam:reviewer");
console.log(reviewer?.name); // "Code Reviewer"
```

### Validation Rules

The registry validates definitions on registration:

```typescript
// Throws: "Agent definition must have a non-empty id"
registry.registerAgent({ ...myAgent, id: "" });

// Throws: "Agent definition must have a name"
registry.registerAgent({ ...myAgent, name: "" });

// Throws: "Agent definition must have a type"
registry.registerAgent({ ...myAgent, type: "" as never });

// Throws: "Agent definition must have a prompt"
registry.registerAgent({ ...myAgent, prompt: "" });

// Throws: "Agent definition must have valid permissions"
registry.registerAgent({ ...myAgent, permissions: { default: "invalid" as never, rules: [] } });
```

### Overriding Built-in Agents

```typescript
import { buildAgent } from "memeloop/agent/agentTypes";

// Override the build agent with a custom prompt
const customBuild: AgentRegistryEntry = {
  ...buildAgent,
  prompt: "You are a specialized frontend build agent. Prefer TypeScript and React patterns.",
};

registry.registerAgent(customBuild);
const updated = registry.getAgent("memeloop:build");
console.log(updated?.prompt); // Custom prompt
```

### Resetting the Registry

```typescript
// Remove all custom agents and restore built-in defaults
registry.reset();

// Or reset the global singleton entirely
resetAgentRegistry();
```

## Task Delegation Examples

The `task` tool delegates work to registered agents synchronously or in the background.

### Synchronous Task Delegation

```typescript
// Inside a tool implementation or agent context
const result = await taskToolImpl(
  {
    agent: "memeloop:explore",
    prompt: "Find all files that use the deprecated `useLegacyHook` function",
  },
  context,
);

// result shape:
// {
//   result: "Found 3 files: src/app.tsx, src/hooks.ts, src/utils.ts",
//   conversationId: "memeloop:explore:a1b2c3",
//   agentId: "memeloop:explore",
//   [MEMELOOP_STRUCTURED_TOOL_KEY]: {
//     summary: "Found 3 files...",
//     detailRef: { type: "sub-agent", conversationId: "...", nodeId: "local" }
//   }
// }
```

### Background Task Delegation

```typescript
const bgResult = await taskToolImpl(
  {
    agent: "memeloop:build",
    prompt: "Run the full test suite and report failures",
    background: true,
  },
  context,
);

// bgResult shape:
// {
//   background: true,
//   taskId: "memeloop:build:d4e5f6",
//   agentId: "memeloop:build",
//   conversationId: "memeloop:build:d4e5f6",
//   summary: "Background task launched..."
// }
```

### Agent Nesting Limits

Task delegation has a nesting depth limit to prevent runaway recursion:

```typescript
// Conversation IDs track nesting depth via colon segments
// "agent:sub:timestamp" = depth 2 (max allowed)
// Attempting to delegate from depth 2 returns an error:
// { error: "Maximum agent nesting depth exceeded. Cannot delegate further." }
```

### Per-Agent Permission Application

When delegating to an agent, the task tool automatically applies that agent's permission rules to the framework context:

```typescript
// Delegating to plan agent automatically restricts tools
await taskToolImpl({ agent: "memeloop:plan", prompt: "Plan the refactor" }, context);

// The context.taskAgent.toolPermissions.perAgent now includes:
// {
//   "memeloop:plan": {
//     default: "deny",
//     rules: [
//       { pattern: "file.read", action: "allow" },
//       { pattern: "file.search", action: "allow" },
//       ...
//     ]
//   }
// }
```

## Permission Configuration Per Agent

Permissions are resolved through a layered system (lowest to highest priority):

1. **Default** — `toolPermissions.default` (e.g., `"allow"`)
2. **Agent** — `toolPermissions.perAgent[definitionId]`
3. **User** — Persisted in SQLite via permission storage
4. **Session** — `toolPermissions.rules` (global rules, highest priority)

### Permission Actions

| Action | Behavior |
|--------|----------|
| `allow` | Tool executes immediately |
| `ask` | Yields a permission request; awaits user decision |
| `deny` | Tool is blocked with "Denied by tool permission" |

### Wildcard Patterns

Patterns support wildcards for flexible matching:

```typescript
const permissions = {
  default: "deny",
  rules: [
    { pattern: "file.*", action: "allow" },      // allow all file tools
    { pattern: "terminal.*", action: "ask" },    // ask for all terminal commands
    { pattern: "shell(rm)", action: "deny" },     // deny shell(rm) specifically
    { pattern: "*", action: "deny" },             // deny everything else
  ],
};
```

### Framework Context Configuration

```typescript
import { createMemeLoopRuntime } from "memeloop";

const runtime = createMemeLoopRuntime({
  storage,
  llmProvider,
  tools,
  taskAgent: {
    maxIterations: 50,
    toolPermissions: {
      default: "allow",
      perAgent: {
        "memeloop:plan": {
          default: "deny",
          rules: [
            { pattern: "file.read", action: "allow" },
            { pattern: "file.search", action: "allow" },
          ],
        },
        "memeloop:build": {
          default: "allow",
          rules: [{ pattern: "terminal.rm", action: "ask" }],
        },
      },
      rules: [
        // Session-level overrides
        { pattern: "file.write", action: "ask" },
      ],
    },
  },
});
```

## Agent Definition Protocol

Agent definitions are serialized via `@memeloop/protocol` for cross-node sharing:

```typescript
import type { AgentDefinition, AgentInstanceMeta } from "@memeloop/protocol";

// Protocol-level agent definition
const def: AgentDefinition = {
  id: "myteam:reviewer",
  name: "Code Reviewer",
  description: "Security-focused code reviewer",
  systemPrompt: "You are a security-focused code reviewer...",
  tools: [],
  version: "1.0.0",
  modelConfig: {
    provider: "openai",
    model: "gpt-4o",
    temperature: 0.2,
    maxTokens: 4096,
  },
  // Framework-specific config (prompt trees, plugins, maxIterations)
  agentFrameworkConfig: {
    prompts: [],
    plugins: [],
    response: [],
  },
};

// Instance metadata when an agent is running
const instance: AgentInstanceMeta = {
  instanceId: "inst-123",
  definitionId: "myteam:reviewer",
  nodeId: "node-abc",
  conversationId: "conv-456",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
```

## Testing Agents

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { AgentRegistry, getAgentRegistry, resetAgentRegistry } from "memeloop/agent/agentRegistry";

beforeEach(() => {
  resetAgentRegistry();
});

it("registers and retrieves a custom agent", () => {
  const registry = new AgentRegistry();
  const customAgent = {
    id: "test:agent",
    name: "Test Agent",
    type: "build" as const,
    prompt: "You are a test agent.",
    permissions: { default: "allow" as const, rules: [] },
    protocolDef: {
      id: "test:agent",
      name: "Test Agent",
      description: "Test",
      systemPrompt: "You are a test agent.",
      tools: [],
      version: "1.0.0",
    },
  };

  registry.registerAgent(customAgent);
  expect(registry.getAgent("test:agent")).toBe(customAgent);
});
```

## Best Practices

1. **Use descriptive IDs** — Prefix with your team/org namespace (`myteam:agent-name`)
2. **Set minimal permissions** — Start with `deny` and explicitly allow only needed tools
3. **Provide clear prompts** — Agent prompts should define scope, constraints, and behavior
4. **Leverage task delegation** — Use `memeloop:plan` before `memeloop:build` for complex tasks
5. **Monitor nesting depth** — Avoid deep agent chains; flatten when possible
6. **Override built-ins sparingly** — Prefer custom agent IDs over overriding `memeloop:*` defaults
