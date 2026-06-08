# Agent System

MemeLoop separates agent definitions, agent profiles, and the agent loop runtime.

- **Agent definitions** are serializable descriptions of available agents (`AgentDefinition`). They are loaded from built-in prompt JSON files, node YAML, or remote node RPC.
- **Agent profiles** are local task-delegation presets. They define a profile id, prompt, model override, and tool permission rules for the `task` tool.
- **TaskAgent** is the ReAct-style loop that runs messages, LLM calls, tool calls, compaction, and lifecycle hooks.
- **Task tool** delegates work to an agent profile synchronously or in the background.

## Built-In Profiles

| Profile ID           | Type        | Purpose                                  | Default Permissions                     |
| -------------------- | ----------- | ---------------------------------------- | --------------------------------------- |
| `memeloop:build`     | `build`     | Execute tasks, edit files, run commands  | `allow`                                 |
| `memeloop:plan`      | `plan`      | Analyze requirements and decompose tasks | `deny` plus read/search allow rules     |
| `memeloop:explore`   | `explore`   | Fast codebase search and discovery       | `deny` plus read/search/LSP allow rules |
| `memeloop:oracle`    | `oracle`    | Architecture analysis and review         | `deny` plus read/search/LSP allow rules |
| `memeloop:librarian` | `librarian` | External documentation lookup            | `deny` plus read/search/web allow rules |

## Agent Profile Registry

Use `AgentProfileRegistry` when you need to customize local delegation profiles.

```typescript
import {
  AgentProfileRegistry,
  getAgentProfileRegistry,
  resetAgentProfileRegistry,
  type AgentProfile,
} from "memeloop";

const registry = getAgentProfileRegistry();

const profiles = registry.listAgentProfiles();
const build = registry.getAgentProfile("memeloop:build");
const readOnly = registry.listAgentProfilesByType("plan");

const reviewer: AgentProfile = {
  id: "myteam:reviewer",
  name: "Code Reviewer",
  type: "oracle",
  prompt: "Review code for security, correctness, and maintainability.",
  permissions: {
    default: "deny",
    rules: [
      { pattern: "file.read", action: "allow" },
      { pattern: "file.search", action: "allow" },
      { pattern: "grep.search", action: "allow" },
      { pattern: "lsp.*", action: "allow" },
    ],
  },
  protocolDef: {
    id: "myteam:reviewer",
    name: "Code Reviewer",
    description: "Security-focused code reviewer",
    systemPrompt: "Review code for security, correctness, and maintainability.",
    tools: [],
    version: "1.0.0",
  },
};

registry.registerAgentProfile(reviewer);
registry.unregisterAgentProfile("myteam:reviewer");
resetAgentProfileRegistry();
```

Validation requires non-empty `id`, `name`, `type`, `prompt`, and a valid `permissions.default`.

## Task Delegation

The built-in `task` tool resolves `arguments.agent` through `getAgentProfileRegistry()`.

```typescript
const result = await taskToolImpl(
  {
    agent: "memeloop:explore",
    prompt: "Find every call site of createTaskAgent",
  },
  context,
);
```

On success, the result includes the delegated `conversationId`, `agentId`, and a structured `detailRef` of type `sub-agent`.

Background delegation returns immediately with a `taskId`:

```typescript
await taskToolImpl(
  {
    agent: "memeloop:build",
    prompt: "Run the focused tests and summarize failures",
    background: true,
  },
  context,
);
```

The task tool also applies the selected profile's permission rules to `taskAgent.toolPermissions.perAgent[profile.id]` before invoking the local runner.

## Runtime Permissions

Tool permissions are layered from broadest to narrowest:

1. `toolPermissions.default`
2. `toolPermissions.perAgent[profileId]`
3. persisted user/session permissions
4. `toolPermissions.rules`

Wildcard patterns such as `file.*`, `grep.search`, and `lsp.*` are matched by the agent loop permission gate.

## Source Map

- Agent profile registry: `packages/memeloop/src/agent/agentProfileRegistry.ts`
- Built-in profiles: `packages/memeloop/src/agent/agentProfiles.ts`
- Serializable agent types: `packages/memeloop/src/agent/types.ts`
- Agent loop runtime: `packages/memeloop/src/agentLoops/taskAgent.ts`
- Task delegation tool: `packages/memeloop/src/tools/builtins/task.ts`
