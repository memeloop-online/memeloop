# Hooks System

MemeLoop has two hook surfaces:

- **Agent loop lifecycle hooks** in `packages/memeloop/src/loopAPI/hooks`. These are global/registry hooks used by `AgentToolLoop`, the tool-use gate, tool-call runner, and compaction.
- **Prompt plugin hooks** in `packages/memeloop/src/tools/pluginRegistry.ts`. These support `defineTool` and `agentFrameworkConfig.plugins` during prompt assembly and response handling.

This document describes the agent loop lifecycle hooks.

## Hook Types

| Hook Type          | Trigger Point                                                     | Typical Use                              |
| ------------------ | ----------------------------------------------------------------- | ---------------------------------------- |
| `AgentStart`       | When `AgentToolLoop` begins a run                                 | logging, metrics, setup                  |
| `UserPromptSubmit` | When a user prompt enters the loop                                | routing, validation, auditing            |
| `PreToolUse`       | Before a tool call executes                                       | permission override, argument mutation   |
| `PostToolUse`      | After a tool call completes                                       | logging, result inspection, side effects |
| `AgentStop`        | When the agent completes, errors, cancels, or hits max iterations | cleanup, notifications                   |

## API

```typescript
import {
  clearHooks,
  executeHooks,
  registerHook,
  unregisterHook,
  type HookContext,
  type HookResult,
} from "memeloop";

registerHook(
  "PreToolUse",
  async (_context: HookContext, data): Promise<HookResult> => {
    if (data.toolId === "terminal.rm") {
      return { allowed: true, permissionAction: "ask" };
    }
    return { allowed: true };
  },
  "ask-before-rm",
);

const result = await executeHooks("PreToolUse", context, {
  toolId: "file.read",
  parameters: { path: "README.md" },
  conversationId: "c1",
});

unregisterHook("PreToolUse", "ask-before-rm");
clearHooks();
```

Hooks run in registration order. If a hook returns `{ allowed: false }`, execution stops and the result is returned to the caller. `modified` values are merged into later hook data, and `permissionAction` may be used by `PreToolUse` callers to force `allow`, `ask`, or `deny`.

## Source Map

- Hook types: `packages/memeloop/src/loopAPI/hooks/types.ts`
- Hook registry: `packages/memeloop/src/loopAPI/hooks/registry.ts`
- Tool-use gate integration: `packages/memeloop/src/loopAPI/toolUseGate.ts`
- Tool-call runner integration: `packages/memeloop/src/loopAPI/toolCallRunner.ts`
- Compaction integration: `packages/memeloop/src/loopAPI/historyCompaction.ts`
