import type { AgentLoopStep } from "memeloop";
import type { PermissionRequest } from "../../tui/types.js";
import type { ChatHooks } from "../hooks.js";
import type { ChatHookContext } from "../types.js";

export function registerAgentRunnerHandler(hooks: ChatHooks) {
  hooks.onAgentStep.tapAsync("default", (context, callback) => {
    void handleAgentStep(context).then(() => {
      callback();
    }, callback);
  });

  hooks.afterAgentRun.tapAsync("default", (context, callback) => {
    context.tui.addMessage({
      id: `asst-${Date.now()}`,
      role: "assistant",
      content: context.responseContent || "(no response)",
      timestamp: new Date(),
    });
    context.tui.setThinking(false);
    context.tui.setStatus("Ready");
    callback();
  });

  hooks.onAgentError.tapAsync("default", (context, callback) => {
    const error = context.error;
    context.tui.addMessage({
      id: `err-${Date.now()}`,
      role: "system",
      content: `Error: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: new Date(),
    });
    context.tui.setThinking(false);
    context.tui.setStatus("Error");
    callback();
  });
}

async function handleAgentStep(context: ChatHookContext): Promise<void> {
  const step = context.currentStep as AgentLoopStep;
  if (!step) return;

  if (step.type === "message") {
    const data =
      typeof step.data === "string"
        ? step.data
        : ((step.data as { content?: string })?.content ?? "");
    context.responseContent = (context.responseContent ?? "") + data;
  } else if (step.type === "tool") {
    const td = step.data as {
      toolName?: string;
      toolInput?: Record<string, unknown>;
    };
    context.tui.addMessage({
      id: `tool-${Date.now()}`,
      role: "tool",
      content: "",
      timestamp: new Date(),
      toolName: td.toolName,
      toolInput: td.toolInput,
    });
  } else if (step.type === "permission_request") {
    const pd = step.data as {
      requestId?: string;
      toolName?: string;
      toolInput?: Record<string, unknown>;
      message?: string;
    };
    const permRequest: PermissionRequest = {
      id: pd.requestId ?? `perm-${Date.now()}`,
      toolName: pd.toolName ?? "unknown",
      toolInput: pd.toolInput ?? {},
      message: pd.message ?? "Allow this tool?",
      actions: ["allow", "deny"],
    };
    context.tui.setStatus("Waiting for permission...");
    const approved = await context.tui.waitForPermission(permRequest);
    context.tui.setStatus(approved ? "Permission approved" : "Permission denied");
  }
}
