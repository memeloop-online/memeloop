/**
 * Terminal tools for Agent: execute (start and wait/timeout), list sessions, respond (stdin).
 * Register with node ToolRegistry and pass ITerminalSessionManager.
 */

import type { ChatMessage } from "memeloop";
import type { IAgentStorage, IToolRegistry } from "memeloop";
import { MEMELOOP_STRUCTURED_TOOL_KEY } from "memeloop";

import type { ITerminalSessionManager } from "../terminal/index.js";
import {
  prepareTerminalSessionStorage,
  wireTerminalOutputToStorage,
} from "../terminal/sessionStorage";
import { createThrottledTerminalOutputNotify } from "../terminal/throttleOutputNotify.js";
import type { TerminalSessionInfo } from "../terminal/types.js";

const EXECUTE_ID = "terminal.execute";
const START_ID = "terminal.start";
const LIST_ID = "terminal.list";
const RESPOND_ID = "terminal.respond";
const FOLLOW_ID = "terminal.follow";
const CANCEL_ID = "terminal.cancel";
const SIGNAL_ID = "terminal.signal";
const GET_OUTPUT_ID = "terminal.getOutput";

/** Plan §16.4.1 default `promptPatterns` for `mode: interactive`. */
export const DEFAULT_INTERACTIVE_PROMPT_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "yn_confirm", regex: /\(y\/n\)\s*$|\(Y\/N\)\s*$/im },
  { name: "approval", regex: /\[.*\]\s*\(.*approve.*\)/im },
  { name: "question", regex: /\?\s*$/m },
  { name: "password", regex: /password[:\s]*$/im },
  { name: "shell_prompt", regex: /[$#>%]\s*$/m },
  { name: "claude_tool", regex: /Do you want to proceed\?/im },
  { name: "copilot_confirm", regex: /\(Y\)es.*\(N\)o/im },
];

export interface RegisterTerminalToolsOptions {
  /** When set, stream chunks into `terminal:<sessionId>` for pullTerminalSession. */
  storage?: IAgentStorage;
  /** Message `originNodeId` and `DetailRef.nodeId` */
  nodeId?: string;
  /** Used when `terminal.start` runs with `mode: interactive`. */
  askQuestion?: (question: string) => Promise<string>;
  /**
   * JSON-RPC WS：推送 `memeloop.terminal.output.delta`（`MEMELOOP_TERMINAL_OUTPUT_NOTIFICATION`，内部按 1s 节流合并）。
   * 与 `storage` 同时存在时，输出既落库也推送。
   */
  terminalWsNotify?: (method: string, parameters: unknown) => void;
}

export interface NormalizedTerminalCommandRequest {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  commandLine: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((item) => typeof item === "string")
  );
}

export function normalizeTerminalCommandRequest(
  arguments_: Record<string, unknown>,
  source: "terminal.start" | "terminal.execute",
): { ok: true; value: NormalizedTerminalCommandRequest } | { ok: false; error: string } {
  const commandRaw = arguments_.command;
  if (typeof commandRaw !== "string" || !commandRaw.trim()) {
    return {
      ok: false,
      error:
        source === "terminal.start"
          ? "Missing 'command' for terminal.start"
          : "Missing or invalid 'command'. Example: { command: 'npm run build', timeoutMs?: 60000, cwd?: '.' }",
    };
  }

  const command = commandRaw.trim();

  const rawArguments = arguments_.args;
  if (rawArguments !== undefined && !isStringArray(rawArguments)) {
    return { ok: false, error: "Invalid 'args'. Expected string[]" };
  }

  const rawEnvironment = arguments_.env;
  if (rawEnvironment !== undefined && !isStringRecord(rawEnvironment)) {
    return { ok: false, error: "Invalid 'env'. Expected Record<string, string>" };
  }

  if (rawArguments !== undefined) {
    const explicitArguments = [...rawArguments];
    return {
      ok: true,
      value: {
        command,
        args: explicitArguments,
        env: rawEnvironment ? { ...rawEnvironment } : undefined,
        commandLine: [command, ...explicitArguments].join(" "),
      },
    };
  }

  const parts = command.split(/\s+/);
  const cmd = parts[0];
  const cmdArguments = parts.slice(1);

  return {
    ok: true,
    value: {
      command: cmd,
      args: cmdArguments.length ? cmdArguments : undefined,
      env: rawEnvironment ? { ...rawEnvironment } : undefined,
      commandLine: command,
    },
  };
}

export function registerTerminalTools(
  registry: IToolRegistry,
  sessionManager: ITerminalSessionManager,
  options?: RegisterTerminalToolsOptions,
): void {
  registry.registerTool(EXECUTE_ID, (arguments_: Record<string, unknown>) =>
    executeImpl(arguments_, sessionManager, options),
  );
  registry.registerTool(LIST_ID, (arguments_: Record<string, unknown>) =>
    listImpl(arguments_, sessionManager),
  );
  registry.registerTool(RESPOND_ID, (arguments_: Record<string, unknown>) =>
    respondImpl(arguments_, sessionManager),
  );
  registry.registerTool(FOLLOW_ID, (arguments_: Record<string, unknown>) =>
    followImpl(arguments_, sessionManager),
  );
  registry.registerTool(CANCEL_ID, (arguments_: Record<string, unknown>) =>
    cancelImpl(arguments_, sessionManager),
  );
  registry.registerTool(START_ID, (arguments_: Record<string, unknown>) =>
    runTerminalStart(arguments_, sessionManager, options),
  );
  registry.registerTool(SIGNAL_ID, (arguments_: Record<string, unknown>) =>
    runTerminalSignal(arguments_, sessionManager),
  );
  registry.registerTool(GET_OUTPUT_ID, (arguments_: Record<string, unknown>) =>
    runTerminalGetOutput(arguments_, sessionManager),
  );
}

/** Shared by JSON-RPC `memeloop.terminal.start` and the `terminal.start` tool. */
export async function runTerminalStart(
  arguments_: Record<string, unknown>,
  manager: ITerminalSessionManager,
  options?: RegisterTerminalToolsOptions,
): Promise<unknown> {
  const cwd = arguments_.cwd as string | undefined;
  const modeRaw = (arguments_.mode as string) ?? "background";
  const mode =
    modeRaw === "await" ||
    modeRaw === "background" ||
    modeRaw === "interactive" ||
    modeRaw === "service"
      ? modeRaw
      : "background";
  const parentConversationId =
    typeof arguments_.parentConversationId === "string"
      ? arguments_.parentConversationId
      : undefined;
  const label = typeof arguments_.label === "string" ? arguments_.label : undefined;
  const idleTimeoutMs =
    typeof arguments_.idleTimeoutMs === "number" && arguments_.idleTimeoutMs > 0
      ? arguments_.idleTimeoutMs
      : mode === "interactive"
        ? 15_000
        : mode === "service"
          ? undefined
          : 15_000;

  const normalized = normalizeTerminalCommandRequest(arguments_, "terminal.start");
  if (!normalized.ok) {
    return { error: normalized.error };
  }
  const { command, args: cmdArguments, env, commandLine } = normalized.value;

  const customPatterns = arguments_.promptPatterns as { name: string; regex: RegExp }[] | undefined;
  const promptPatterns =
    mode === "interactive"
      ? Array.isArray(customPatterns) && customPatterns.length > 0
        ? customPatterns
        : DEFAULT_INTERACTIVE_PROMPT_PATTERNS
      : [{ name: "generic", regex: /[?%]\s*$|>\s*$|:\s*$/m }];

  const { sessionId } = await manager.start({
    command,
    args: cmdArguments,
    cwd,
    env,
    mode,
    parentConversationId,
    label,
    promptPatterns,
    idleTimeoutMs,
    askQuestion: mode === "interactive" ? options?.askQuestion : undefined,
  });

  const storage = options?.storage;
  const nodeId = options?.nodeId ?? "local";

  let unsubSessionComplete: (() => void) | undefined;

  if (storage) {
    const { terminalCid } = await prepareTerminalSessionStorage(storage, nodeId, sessionId);
    const throttled =
      typeof options?.terminalWsNotify === "function"
        ? createThrottledTerminalOutputNotify(options.terminalWsNotify, 1000)
        : undefined;
    const wired = wireTerminalOutputToStorage(
      storage,
      nodeId,
      terminalCid,
      sessionId,
      manager,
      throttled
        ? (chunk) => {
            throttled.push(chunk);
          }
        : undefined,
    );

    if (parentConversationId && mode !== "await") {
      unsubSessionComplete = manager.onSessionComplete(async (sid, info, truncatedOutput) => {
        if (sid !== sessionId) return;
        unsubSessionComplete?.();
        unsubSessionComplete = undefined;
        try {
          await appendTerminalCompleteToolMessageToParent(storage, {
            parentConversationId,
            originNodeId: nodeId,
            mode,
            commandLine,
            sessionId,
            nodeId,
            info,
            truncatedOutput,
          });
        } catch {
          /* ignore persistence errors */
        }
      });
    }

    const unsubStatus = manager.onStatusUpdate((status) => {
      if (status.sessionId !== sessionId) return;
      throttled?.flush();
      if (status.status !== "running") {
        wired.unsubOutput();
        unsubStatus();
        unsubSessionComplete?.();
        unsubSessionComplete = undefined;
      }
    });
    const info = manager.get(sessionId);
    if (info?.status !== "running") {
      throttled?.flush();
      wired.unsubOutput();
      unsubStatus();
      unsubSessionComplete?.();
      unsubSessionComplete = undefined;
    }
  }

  const detailReference = {
    type: "terminal-session" as const,
    sessionId,
    nodeId,
  };

  const terminalConversationId = `terminal:${sessionId}`;

  const base = {
    sessionId,
    terminalConversationId,
    status: "running" as const,
    mode,
    [MEMELOOP_STRUCTURED_TOOL_KEY]: {
      summary:
        mode === "await"
          ? `[terminal.start await] ${commandLine}\nsessionId=${sessionId}`
          : `[terminal.start ${mode}] ${commandLine}\nsessionId=${sessionId}`,
      detailRef: detailReference,
      ...(mode === "await" ? { awaitSessionId: sessionId } : {}),
    },
  };

  return base;
}

export async function runTerminalSignal(
  arguments_: Record<string, unknown>,
  manager: ITerminalSessionManager,
): Promise<unknown> {
  const sessionId = arguments_.sessionId as string | undefined;
  const sig = (arguments_.signal as string) ?? "SIGINT";
  if (!sessionId) {
    return { error: "Missing sessionId" };
  }
  const allowed = new Set(["SIGINT", "SIGTERM", "SIGKILL"]);
  if (!allowed.has(sig)) {
    return { error: "Invalid signal (use SIGINT, SIGTERM, SIGKILL)" };
  }
  await manager.signal(sessionId, sig as NodeJS.Signals);
  return { ok: true, sessionId, signal: sig };
}

export async function runTerminalGetOutput(
  arguments_: Record<string, unknown>,
  manager: ITerminalSessionManager,
): Promise<unknown> {
  const sessionId = arguments_.sessionId as string | undefined;
  if (!sessionId) {
    return { error: "Missing sessionId" };
  }
  const tailLines = typeof arguments_.tailLines === "number" ? arguments_.tailLines : undefined;
  const tailChars = typeof arguments_.tailChars === "number" ? arguments_.tailChars : undefined;
  const text = manager.getOutputText(sessionId, { tailLines, tailChars });
  return { sessionId, output: text };
}

function terminalExecuteSummary(options: {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): string {
  const combined = options.stdout + (options.stderr ? `\n[stderr]\n${options.stderr}` : "");
  const tail = combined.length > 1200 ? combined.slice(-1200) : combined;
  let body = `[terminal.execute] ${options.command}\nexitCode: ${options.exitCode ?? "null"}${options.timedOut ? "\ntimedOut: true" : ""}\n---\n${tail}`;
  if (body.length > 2000) body = body.slice(0, 1997) + "...";
  return body;
}

async function executeImpl(
  arguments_: Record<string, unknown>,
  manager: ITerminalSessionManager,
  options?: RegisterTerminalToolsOptions,
): Promise<unknown> {
  const timeoutMs = (arguments_.timeoutMs as number) ?? 60_000;
  const cwd = arguments_.cwd as string | undefined;
  const waitMode =
    arguments_.waitMode === "until-exit" ||
    arguments_.waitMode === "until-timeout" ||
    arguments_.waitMode === "detached"
      ? arguments_.waitMode
      : "until-timeout";
  const maxWaitMsRaw = arguments_.maxWaitMs as number | undefined;
  const maxWaitMs = typeof maxWaitMsRaw === "number" ? maxWaitMsRaw : timeoutMs;
  const stream = arguments_.stream === true;

  const normalized = normalizeTerminalCommandRequest(arguments_, "terminal.execute");
  if (!normalized.ok) {
    return { error: normalized.error };
  }
  const { command, args: cmdArguments, env, commandLine } = normalized.value;

  const { sessionId } = await manager.start({
    command,
    args: cmdArguments,
    cwd,
    env,
    promptPatterns: [{ name: "generic", regex: /[?%]\s*$|>\s*$|:\s*$/m }],
    idleTimeoutMs: Math.min(15_000, timeoutMs),
  });

  const storage = options?.storage;
  const nodeId = options?.nodeId ?? "local";
  let persistQueue: Promise<void> = Promise.resolve();
  let unsubOutput: (() => void) | undefined;
  let unsubStatus: (() => void) | undefined;

  if (storage) {
    const { terminalCid } = await prepareTerminalSessionStorage(storage, nodeId, sessionId);
    const wired = wireTerminalOutputToStorage(storage, nodeId, terminalCid, sessionId, manager);
    persistQueue = wired.persistQueue;
    unsubOutput = wired.unsubOutput;
    unsubStatus = manager.onStatusUpdate((status) => {
      if (status.sessionId !== sessionId) return;
      if (status.status !== "running") {
        wired.unsubOutput();
        unsubStatus?.();
      }
    });
    const info = manager.get(sessionId);
    if (info?.status !== "running") {
      wired.unsubOutput();
      unsubStatus?.();
    }
  }

  const structuredPayload = (
    exitCode: number | null,
    timedOut: boolean,
    stdout: string,
    stderr: string,
  ) => ({
    [MEMELOOP_STRUCTURED_TOOL_KEY]: {
      summary: terminalExecuteSummary({ command: commandLine, exitCode, timedOut, stdout, stderr }),
      ...(storage
        ? {
            detailRef: {
              type: "terminal-session" as const,
              sessionId,
              nodeId,
              exitCode: exitCode ?? undefined,
            },
          }
        : {}),
    },
  });

  if (waitMode === "detached") {
    return {
      sessionId,
      status: "running",
      exitCode: null,
      timedOut: false,
      done: false,
      nextSeq: 1,
      chunks: [],
      ...structuredPayload(null, false, "", ""),
    };
  }

  try {
    const follow = await manager.follow(sessionId, {
      fromSeq: 1,
      untilExit: waitMode === "until-exit",
      maxWaitMs,
    });
    await persistQueue;
    const timedOut = waitMode === "until-timeout" && !follow.done;
    if (timedOut) await manager.cancel(sessionId);
    const stdout = follow.chunks
      .filter((c) => c.stream === "stdout")
      .map((c) => c.data)
      .join("");
    const stderr = follow.chunks
      .filter((c) => c.stream === "stderr")
      .map((c) => c.data)
      .join("");
    return {
      sessionId,
      status: follow.status,
      exitCode: follow.exitCode,
      timedOut,
      done: follow.done,
      nextSeq: follow.nextSeq,
      chunks: stream ? follow.chunks : undefined,
      stdout,
      stderr,
      output: stdout + (stderr ? `\n[stderr]\n${stderr}` : ""),
      ...structuredPayload(follow.exitCode, timedOut, stdout, stderr),
    };
  } catch (error) {
    await persistQueue;
    throw error;
  } finally {
    await persistQueue;
    unsubOutput?.();
    unsubStatus?.();
  }
}

async function listImpl(
  _arguments: Record<string, unknown>,
  manager: ITerminalSessionManager,
): Promise<unknown> {
  const list = await manager.list();
  return { sessions: list };
}

async function respondImpl(
  arguments_: Record<string, unknown>,
  manager: ITerminalSessionManager,
): Promise<unknown> {
  const sessionId = arguments_.sessionId as string | undefined;
  const input = arguments_.input as string | undefined;

  if (!sessionId || typeof input !== "string") {
    return {
      error: "Missing sessionId or input. Example: { sessionId: 'uuid', input: 'yes' }",
    };
  }

  try {
    await manager.respond(sessionId, input);
    return { ok: true };
  } catch (error) {
    return { error: String(error) };
  }
}

async function followImpl(
  arguments_: Record<string, unknown>,
  manager: ITerminalSessionManager,
): Promise<unknown> {
  const sessionId = arguments_.sessionId as string | undefined;
  if (!sessionId || typeof sessionId !== "string") {
    return {
      error:
        "Missing sessionId. Example: { sessionId: 'uuid', fromSeq?: 1, untilExit?: true, maxWaitMs?: 30000 }",
    };
  }
  const fromSeq = typeof arguments_.fromSeq === "number" ? arguments_.fromSeq : 1;
  const untilExit = arguments_.untilExit === true;
  const maxWaitMs = typeof arguments_.maxWaitMs === "number" ? arguments_.maxWaitMs : 30_000;
  try {
    return await manager.follow(sessionId, { fromSeq, untilExit, maxWaitMs });
  } catch (error) {
    return { error: String(error) };
  }
}

async function cancelImpl(
  arguments_: Record<string, unknown>,
  manager: ITerminalSessionManager,
): Promise<unknown> {
  const sessionId = arguments_.sessionId as string | undefined;
  if (!sessionId || typeof sessionId !== "string") {
    return { error: "Missing sessionId. Example: { sessionId: 'uuid' }" };
  }
  await manager.cancel(sessionId);
  const info = manager.get(sessionId);
  return {
    ok: true,
    sessionId,
    finalStatus: info?.status ?? "killed",
  };
}

/** 计划 §16.4 模式 C/D/E：进程退出时向父会话追加摘要 + detailRef（await 模式由 taskAgent 单独处理）。 */
async function appendTerminalCompleteToolMessageToParent(
  storage: IAgentStorage,
  options: {
    parentConversationId: string;
    originNodeId: string;
    mode: "background" | "service" | "interactive";
    commandLine: string;
    sessionId: string;
    nodeId: string;
    info: TerminalSessionInfo;
    truncatedOutput: string;
  },
): Promise<void> {
  const {
    parentConversationId,
    originNodeId,
    mode,
    commandLine,
    sessionId,
    nodeId,
    info,
    truncatedOutput,
  } = options;
  const tail = truncatedOutput.length > 1800 ? truncatedOutput.slice(-1800) : truncatedOutput;
  let header: string;
  if (mode === "service") {
    header = `[Service process exited]\nCommand: ${commandLine}\nSession: ${sessionId}\nExit code: ${info.exitCode ?? "null"}\nLong-running service stopped (unexpected).\n`;
  } else if (mode === "interactive") {
    header = `[Interactive terminal completed]\nCommand: ${commandLine}\nSession: ${sessionId}\nExit code: ${info.exitCode ?? "null"}\nOutput (truncated):\n`;
  } else {
    header = `[Background task completed]\nCommand: ${commandLine}\nSession: ${sessionId}\nExit code: ${info.exitCode ?? "null"}\nOutput (truncated):\n`;
  }
  let content = header + tail;
  if (content.length > 2000) content = content.slice(0, 1997) + "...";
  const message: ChatMessage = {
    messageId: `term-done-${sessionId}-${Date.now()}`,
    conversationId: parentConversationId,
    originNodeId,
    timestamp: Date.now(),
    lamportClock: Date.now(),
    role: "tool",
    content,
    detailRef: {
      type: "terminal-session",
      sessionId,
      nodeId,
      exitCode: info.exitCode ?? undefined,
    },
  };
  await storage.appendMessage(message);
}

export const terminalExecuteSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to run (e.g. 'npm run build')" },
    args: {
      type: "array",
      items: { type: "string" },
      description:
        "Explicit argv array. When provided, command is executed directly without splitting the command string.",
    },
    env: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Environment variable overrides merged with the current process environment.",
    },
    timeoutMs: { type: "number", description: "Max wait in ms (default 60000)" },
    waitMode: { type: "string", enum: ["until-exit", "until-timeout", "detached"] },
    maxWaitMs: { type: "number", description: "0 means no proactive timeout" },
    stream: { type: "boolean", description: "Include chunks array in response" },
    cwd: { type: "string", description: "Working directory" },
  },
  required: ["command"],
} as const;

export const terminalListSchema = {
  type: "object",
  properties: {},
} as const;

export const terminalRespondSchema = {
  type: "object",
  properties: {
    sessionId: { type: "string", description: "Terminal session ID" },
    input: { type: "string", description: "Line to send to stdin" },
  },
  required: ["sessionId", "input"],
} as const;

export const terminalFollowSchema = {
  type: "object",
  properties: {
    sessionId: { type: "string", description: "Terminal session ID" },
    fromSeq: { type: "number", description: "Read chunks from this sequence (inclusive)" },
    untilExit: { type: "boolean", description: "Wait until process exits" },
    maxWaitMs: { type: "number", description: "Max wait time in milliseconds" },
  },
  required: ["sessionId"],
} as const;
