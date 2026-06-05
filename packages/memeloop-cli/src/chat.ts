/**
 * chat.ts — Interactive REPL chat command powered by Ink TUI
 *
 * Usage: memeloop chat [--model <modelId>] [--mode chat|plan|autopilot] [--print --prompt "..."]
 */
import { createInterface } from "node:readline";
import React from "react";
import { render } from "ink";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNodeRuntime } from "./runtime/nodeRuntime.js";
import type { NodeRuntimeResult } from "./runtime/nodeRuntime.js";
import type { TaskAgentGenerator, TaskAgentInput } from "memeloop";

import { TUIApp, createTUIDispatcher } from "./tui/index.js";
import type { TUIMessage, PermissionRequest } from "./tui/types.js";

/**
 * Simple TUI prompt asking user whether to open config when no provider is found.
 */
function askProviderNotFound(providerName: string): Promise<"config" | "exit"> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const label =
      providerName ?
        `"${providerName}"` :
        "default";
    console.log(
      `\n⚠️  No LLM provider found for ${label}.`,
    );
    console.log(
      `   Run "memeloop config" to add a provider.\n`,
    );
    rl.question(
      "   Open configuration TUI now? [Y/n] ",
      (answer: string) => {
        rl.close();
        const trimmed = answer.trim().toLowerCase();
        if (trimmed === "" || trimmed === "y" || trimmed === "yes") {
          resolve("config");
        } else {
          console.log(
            "   Skipping. Run memeloop config later to configure a provider.\n",
          );
          resolve("exit");
        }
      },
    );
  });
}

export interface ChatOptions {
  model?: string;
  mode?: "chat" | "plan" | "autopilot";
  dataDir?: string;
  config?: Record<string, unknown>;
  print?: boolean;
  prompt?: string;
  localNodeId?: string;
  /** Resume the most recent session */
  continueLast?: boolean;
  /** Resume a specific session by ID */
  resumeSessionId?: string;
}

/**
 * Access injected task agent runner from context (added by createNodeRuntime).
 */
function getTaskRunner(
  runtime: NodeRuntimeResult,
): ((input: TaskAgentInput) => TaskAgentGenerator) | undefined {
  // createNodeRuntime injects runTaskAgent on context (not in AgentFrameworkContext type)
  return (runtime.context as unknown as Record<string, unknown>).runTaskAgent as
    | ((input: TaskAgentInput) => TaskAgentGenerator)
    | undefined;
}

/**
 * Launch the interactive TUI chat.
 */
export async function launchChat(options: ChatOptions = {}): Promise<void> {
  if (options.print) {
    // If no prompt given, read from stdin
    if (!options.prompt) {
      options.prompt = await readStdin();
    }
    await runPrintMode(options);
    return;
  }

  const tui = createTUIDispatcher();
  const dataDir = options.dataDir ?? path.join(os.homedir(), ".memeloop");
  mkdirSync(dataDir, { recursive: true });

  let runtime: NodeRuntimeResult;
  while (true) {
    try {
      runtime = createNodeRuntime({
        localNodeId: options.localNodeId ?? "memeloop-cli",
        dataDir,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
        config: options.config as any,
      });
      break;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Provider not found")) {
        const providerName = message.replace("Provider not found: ", "").trim();
        const answer = await askProviderNotFound(providerName);
        if (answer === "config") {
          try {
            const { launchConfigTUI } = await import("./providers/ConfigTUI.js");
            await launchConfigTUI();
          } catch (error: unknown) {
            // If config TUI fails, just fall through to retry
            const message = error instanceof Error ? error.message : String(error);
            console.error("[memeloop] Config TUI failed:", message);
          }
          continue;
        }
      }
      // Re-throw any other error
      throw error;
    }
  }

  // Handle --continue / --resume
  let initialMessages: TUIMessage[] = [];
  if (options.continueLast || options.resumeSessionId) {
    const { listSessions, resumeSession } = await import("./sessions.js");

    let sessionId = options.resumeSessionId;
    if (!sessionId) {
      const sessions = await listSessions(runtime);
      if (sessions.length > 0) {
        sessionId = sessions[0].id;
        initialMessages.push({
          id: `sys-resume-${Date.now()}`,
          role: "system",
          content: `Resuming session: ${sessions[0].title} (${sessions[0].messageCount} messages)`,
          timestamp: new Date(),
        });
      }
    }

    if (sessionId) {
      const resumed = await resumeSession(runtime, sessionId);
      if (resumed?.messages) {
        initialMessages = [
          ...initialMessages,
          ...resumed.messages.map((m) => ({
            id: (m.messageId ?? m.id ?? `hist-${Date.now()}-${Math.random().toString(36).slice(2)}`),
            role: (m.role as TUIMessage["role"]) ?? "assistant",
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            timestamp: m.timestamp ? new Date(m.timestamp as number) : new Date(),
          })),
        ];
      }
    }
  }

  const { waitUntilExit } = render(
    React.createElement(TUIApp, {
      initialMessages,
      onSubmit: async (text: string) => {
        await handleUserMessage(text, runtime, tui);
      },
      onPermissionResponse: (_requestId: string, approved: boolean) => {
        tui.resolvePermission(approved);
      },
      onExit: () => {
        tui.setStatus("Shutting down...");
      },
    }),
  );

  await waitUntilExit;
}

async function handleUserMessage(
  text: string,
  runtime: NodeRuntimeResult,
  tui: ReturnType<typeof createTUIDispatcher>,
): Promise<void> {
  // Check for slash commands first
  if (text.startsWith("/")) {
    const { executeCommand } = await import("./commands.js");
    const ctx = {
      messages: tui.getMessages(),
      mode: tui.getMode(),
      statusText: "",
    };
    const result = await executeCommand(text, ctx);
    if (result) {
      if (result.exit) {
        tui.setStatus("Goodbye!");
        process.exit(0);
      }
      if (result.clearMessages) {
        // Clear is handled by reload — for now just add system message
        tui.addMessage({
          id: `sys-${Date.now()}`,
          role: "system",
          content: "Conversation cleared.",
          timestamp: new Date(),
        });
        return;
      }
      if (result.messages) {
        for (const msg of result.messages) {
          tui.addMessage(msg);
        }
      }
      if (result.statusText) {
        tui.setStatus(result.statusText);
      }
      return;
    }
  }
  try {
    const runTaskAgent = getTaskRunner(runtime);
    if (!runTaskAgent) {
      tui.addMessage({
        id: `err-${Date.now()}`,
        role: "system",
        content: "Error: Local agent runner not configured.",
        timestamp: new Date(),
      });
      tui.setThinking(false);
      tui.setStatus("Error");
      return;
    }

    const conversationId = `cli-chat-${Date.now().toString(36)}`;
    tui.setStatus("Agent running...");

    const gen = runTaskAgent({ conversationId, message: text });

    let responseContent = "";
    for await (const step of gen) {
      if (step.type === "message") {
        const data =
          typeof step.data === "string"
            ? step.data
            : (step.data as { content?: string })?.content ?? "";
        responseContent += data;
      } else if (step.type === "tool") {
        const td = step.data as { toolName?: string; toolInput?: Record<string, unknown> };
        tui.addMessage({
          id: `tool-${Date.now()}`,
          role: "tool",
          content: "",
          timestamp: new Date(),
          toolName: td.toolName,
          toolInput: td.toolInput,
        });
      } else if (step.type === "permission_request") {
        const pd = step.data as { requestId?: string; toolName?: string; toolInput?: Record<string, unknown>; message?: string };
        const permReq: PermissionRequest = {
          id: pd.requestId ?? `perm-${Date.now()}`,
          toolName: pd.toolName ?? "unknown",
          toolInput: pd.toolInput ?? {},
          message: pd.message ?? "Allow this tool?",
          actions: ["allow", "deny"],
        };
        tui.setStatus("Waiting for permission...");
        const approved = await tui.waitForPermission(permReq);
        tui.setStatus(approved ? "Permission approved" : "Permission denied");
        // TODO: send approval/denial back to agent loop
      }
    }

    tui.addMessage({
      id: `asst-${Date.now()}`,
      role: "assistant",
      content: responseContent || "(no response)",
      timestamp: new Date(),
    });
    tui.setThinking(false);
    tui.setStatus("Ready");
  } catch (err) {
    tui.addMessage({
      id: `err-${Date.now()}`,
      role: "system",
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      timestamp: new Date(),
    });
    tui.setThinking(false);
    tui.setStatus("Error");
  }
}

/**
 * Non-interactive "print" mode — pipe-friendly plain text output.
 */
async function runPrintMode(options: ChatOptions): Promise<void> {
  const prompt = options.prompt;
  if (!prompt) {
    process.stderr.write("Error: --print requires --prompt or piped stdin\n");
    process.exit(1);
  }

  const dataDir = options.dataDir ?? path.join(os.homedir(), ".memeloop");
  mkdirSync(dataDir, { recursive: true });
  const runtime = createNodeRuntime({
    localNodeId: "memeloop-cli-print",
    dataDir,
    config: options.config as any,
  });

  const runTaskAgent = getTaskRunner(runtime);
  if (!runTaskAgent) {
    process.stderr.write("Error: Local agent runner not configured.\n");
    process.exit(1);
  }

  const conversationId = `cli-print-${Date.now().toString(36)}`;
  const gen = runTaskAgent({ conversationId, message: prompt });

  for await (const step of gen) {
    if (step.type === "message") {
      const data =
        typeof step.data === "string"
          ? step.data
          : (step.data as { content?: string })?.content ?? "";
      process.stdout.write(data);
    }
  }

  process.stdout.write("\n");
}

/**
 * Read all data from stdin (for pipe mode).
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    // Check if stdin has data (is TTY or not)
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { data += chunk; });
    process.stdin.on("end", () => { resolve(data.trim()); });
    // Resolve immediately if stdin already ended
    if (process.stdin.readableEnded) {
      resolve(data.trim());
    }
  });
}
