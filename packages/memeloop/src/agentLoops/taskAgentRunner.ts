import type { AgentFrameworkContext, AgentInstanceState } from "../types.js";
import { createTaskAgent } from "./taskAgent.js";
import type { TaskAgentGenerator, TaskAgentInput, TaskAgentStep } from "./taskAgentContract.js";

export interface RunTaskAgentTurnCallbacks {
  onStep?: (step: TaskAgentStep) => void | Promise<void>;
  onProgress?: (
    status: string,
    data: Record<string, unknown>,
    step: TaskAgentStep,
  ) => void | Promise<void>;
  taskAgent?: (input: TaskAgentInput) => TaskAgentGenerator;
}

export interface RunTaskAgentTurnResult {
  state: AgentInstanceState;
  stepCount: number;
}

export function resolveTaskAgentTerminalState(
  step: TaskAgentStep,
  current: AgentInstanceState,
): AgentInstanceState {
  if (step.type !== "thinking") return current;
  const data = step.data as { status?: string };
  if (data.status === "input-required") return "input-required";
  if (data.status === "cancelled") return "canceled";
  if (data.status === "max-iterations") return "completed";
  if (data.status === "blocked") return "failed";
  if (data.status === "calling-llm") return "working";
  return current;
}

export async function runTaskAgentTurn(
  context: AgentFrameworkContext,
  input: TaskAgentInput,
  callbacks: RunTaskAgentTurnCallbacks = {},
): Promise<RunTaskAgentTurnResult> {
  const taskAgent = callbacks.taskAgent ?? createTaskAgent(context);
  let terminalState: AgentInstanceState = "completed";
  let stepCount = 0;

  for await (const step of taskAgent(input)) {
    stepCount += 1;
    terminalState = resolveTaskAgentTerminalState(step, terminalState);
    await callbacks.onStep?.(step);

    if (step.type === "thinking" && step.data && typeof step.data === "object") {
      const data = step.data as Record<string, unknown>;
      const status = data.status;
      if (typeof status === "string") {
        await callbacks.onProgress?.(status, data, step);
      }
    }
  }

  return {
    state:
      terminalState === "working" || terminalState === "submitted" ? "completed" : terminalState,
    stepCount,
  };
}
