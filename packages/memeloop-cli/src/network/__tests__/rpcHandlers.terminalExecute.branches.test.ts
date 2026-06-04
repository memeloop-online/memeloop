import { MEMELOOP_TERMINAL_OUTPUT_NOTIFICATION } from "../../../../memeloop/src/protocol/index.js";
import { describe, expect, it, vi } from "vitest";

import type { TerminalOutputChunk } from "../../terminal/types.js";
import { handleRpc, type RpcHandlerContext } from "../rpcHandlers.js";

function mkStorage() {
  return {
    upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
    appendMessage: vi.fn().mockResolvedValue(undefined),
    listConversations: vi.fn(),
    getMessages: vi.fn(),
    insertMessagesIfAbsent: vi.fn(),
    upsertConversationMetadataIfAbsent: vi.fn(),
    getAgentDefinition: vi.fn(),
    saveAgentInstance: vi.fn(),
    getConversationMeta: vi.fn(),
    readAttachmentData: vi.fn(),
    getAttachment: vi.fn(),
    saveAttachment: vi.fn(),
  } as any;
}

describe("rpcHandlers memeloop.terminal.execute branches", () => {
  it("detached returns early (no follow/cancel) with empty chunks", async () => {
    const storage = mkStorage();
    const terminalManager = {
      start: vi.fn().mockResolvedValue({ sessionId: "s-detached" }),
      follow: vi.fn(),
      cancel: vi.fn(),
      get: vi.fn().mockReturnValue({ sessionId: "s-detached", status: "running" }),
      list: vi.fn(),
      respond: vi.fn(),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onStatusUpdate: vi.fn().mockReturnValue(() => {}),
      onInteractionPrompt: vi.fn().mockReturnValue(() => {}),
    } as any;

    const ctx: RpcHandlerContext = {
      runtime: {
        createAgent: vi.fn(),
        sendMessage: vi.fn(),
        cancelAgent: vi.fn(),
        subscribeToUpdates: vi.fn().mockReturnValue(() => {}),
      } as any,
      storage,
      terminalManager,
      wikiManager: undefined,
      toolRegistry: undefined,
      nodeId: "node-self",
    };

    const r = (await handleRpc(ctx, "memeloop.terminal.execute", {
      command: "echo hi",
      waitMode: "detached",
      timeoutMs: 1000,
      stream: true,
    })) as any;

    expect(terminalManager.follow).not.toHaveBeenCalled();
    expect(terminalManager.cancel).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      sessionId: "s-detached",
      status: "running",
      exitCode: null,
      done: false,
      timedOut: false,
      chunks: [],
      nextSeq: 1,
    });
    expect(terminalManager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "echo",
        args: ["hi"],
        env: undefined,
      }),
    );
  });

  it("passes explicit args and env through memeloop.terminal.execute without splitting command", async () => {
    const storage = mkStorage();
    const terminalManager = {
      start: vi.fn().mockResolvedValue({ sessionId: "s-explicit" }),
      follow: vi.fn().mockResolvedValue({
        sessionId: "s-explicit",
        status: "exited",
        exitCode: 0,
        nextSeq: 1,
        done: true,
        chunks: [],
      }),
      cancel: vi.fn(),
      get: vi.fn().mockReturnValue({ sessionId: "s-explicit", status: "running" }),
      list: vi.fn(),
      respond: vi.fn(),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onStatusUpdate: vi.fn().mockReturnValue(() => {}),
      onInteractionPrompt: vi.fn().mockReturnValue(() => {}),
    } as any;

    const ctx: RpcHandlerContext = {
      runtime: {
        createAgent: vi.fn(),
        sendMessage: vi.fn(),
        cancelAgent: vi.fn(),
        subscribeToUpdates: vi.fn().mockReturnValue(() => {}),
      } as any,
      storage,
      terminalManager,
      wikiManager: undefined,
      toolRegistry: undefined,
      nodeId: "node-self",
    };

    await handleRpc(ctx, "memeloop.terminal.execute", {
      command: "C:/Program Files/node.exe",
      args: ["-e", "console.log(process.env.TEST_FLAG)"],
      env: { TEST_FLAG: "1" },
      waitMode: "until-exit",
      timeoutMs: 1000,
    });

    expect(terminalManager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "C:/Program Files/node.exe",
        args: ["-e", "console.log(process.env.TEST_FLAG)"],
        env: { TEST_FLAG: "1" },
      }),
    );
  });

  it("returns validation errors for invalid explicit args or env", async () => {
    const storage = mkStorage();
    const terminalManager = {
      start: vi.fn(),
      follow: vi.fn(),
      cancel: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      respond: vi.fn(),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onStatusUpdate: vi.fn().mockReturnValue(() => {}),
      onInteractionPrompt: vi.fn().mockReturnValue(() => {}),
    } as any;

    const ctx: RpcHandlerContext = {
      runtime: {
        createAgent: vi.fn(),
        sendMessage: vi.fn(),
        cancelAgent: vi.fn(),
        subscribeToUpdates: vi.fn().mockReturnValue(() => {}),
      } as any,
      storage,
      terminalManager,
      wikiManager: undefined,
      toolRegistry: undefined,
      nodeId: "node-self",
    };

    const badArgs = (await handleRpc(ctx, "memeloop.terminal.execute", {
      command: "node",
      args: ["-e", 1] as any,
    })) as any;
    expect(badArgs.error).toContain("Invalid 'args'");

    const badEnv = (await handleRpc(ctx, "memeloop.terminal.execute", {
      command: "node",
      env: { TEST_FLAG: 1 } as any,
    })) as any;
    expect(badEnv.error).toContain("Invalid 'env'");
    expect(terminalManager.start).not.toHaveBeenCalled();
  });

  it("until-timeout timedOut=true cancels, and notify covers output/prompt/status branches", async () => {
    let outputListener: ((chunk: TerminalOutputChunk) => void) | undefined;
    let onStatusListener: ((status: any) => void) | undefined;
    let onPromptListener: ((prompt: any) => void) | undefined;

    const unsubOutput = vi.fn();
    const unsubStatus = vi.fn();
    const unsubPrompt = vi.fn();

    const notify = vi.fn();

    const storage = mkStorage();
    storage.appendMessage.mockImplementation(async () => {
      // Keep it resolved to allow persistQueue to settle.
      return undefined;
    });

    const terminalManager = {
      start: vi.fn().mockResolvedValue({ sessionId: "s1" }),
      follow: vi.fn().mockImplementation(async () => {
        // Trigger wireTerminalOutputToStorage listener:
        outputListener?.({
          sessionId: "other",
          seq: 1,
          stream: "stdout",
          data: "IGNORED",
          ts: 1,
        } as any);
        outputListener?.({ sessionId: "s1", seq: 2, stream: "stdout", data: "OUT", ts: 2 } as any);
        outputListener?.({ sessionId: "s1", seq: 3, stream: "stderr", data: "ERR", ts: 3 } as any);

        // Trigger prompt/status listeners:
        onPromptListener?.({
          sessionId: "other",
          promptText: "nope",
          patternName: "p",
          timestamp: 1,
        });
        onPromptListener?.({
          sessionId: "s1",
          promptText: "Password:",
          patternName: "pw",
          timestamp: 2,
        });

        onStatusListener?.({ sessionId: "other", status: "running", exitCode: null, ts: 1 });
        onStatusListener?.({ sessionId: "s1", status: "exited", exitCode: 0, ts: 2 });

        return {
          sessionId: "s1",
          status: "running",
          exitCode: null,
          nextSeq: 4,
          done: false,
          chunks: [
            { sessionId: "s1", seq: 2, stream: "stdout", data: "OUT", ts: 2 },
            { sessionId: "s1", seq: 3, stream: "stderr", data: "ERR", ts: 3 },
          ],
        };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockReturnValue({ sessionId: "s1", status: "exited" }),
      list: vi.fn(),
      respond: vi.fn(),
      onOutput: vi.fn().mockImplementation((listener: any) => {
        outputListener = listener;
        return unsubOutput;
      }),
      onStatusUpdate: vi.fn().mockImplementation((listener: any) => {
        onStatusListener = listener;
        return unsubStatus;
      }),
      onInteractionPrompt: vi.fn().mockImplementation((listener: any) => {
        onPromptListener = listener;
        return unsubPrompt;
      }),
    } as any;

    const ctx: RpcHandlerContext = {
      runtime: {
        createAgent: vi.fn(),
        sendMessage: vi.fn(),
        cancelAgent: vi.fn(),
        subscribeToUpdates: vi.fn().mockReturnValue(() => {}),
      } as any,
      storage,
      terminalManager,
      wikiManager: undefined,
      toolRegistry: undefined,
      nodeId: "node-self",
      notify,
    };

    const r = (await handleRpc(ctx, "memeloop.terminal.execute", {
      command: "cmd",
      waitMode: "until-timeout",
      maxWaitMs: 100,
      timeoutMs: 1000,
      stream: true,
    })) as any;

    expect(terminalManager.cancel).toHaveBeenCalledWith("s1");
    expect(r.timedOut).toBe(true);
    expect(r.chunks).toHaveLength(2);
    expect(r.stdout).toBe("OUT");
    expect(r.stderr).toBe("ERR");
    expect(r.output).toContain("OUT");
    expect(r.output).toContain("[stderr]");

    // output delta notify only for matching sessionId
    expect(notify).toHaveBeenCalledWith(
      MEMELOOP_TERMINAL_OUTPUT_NOTIFICATION,
      expect.objectContaining({ sessionId: "s1" }),
    );
    expect(notify).not.toHaveBeenCalledWith(
      MEMELOOP_TERMINAL_OUTPUT_NOTIFICATION,
      expect.objectContaining({ sessionId: "other" }),
    );

    // prompt/status notify only for matching sessionId
    expect(notify).toHaveBeenCalledWith(
      "memeloop.terminal.interaction.prompt",
      expect.objectContaining({ sessionId: "s1", promptText: "Password:" }),
    );
    expect(notify).toHaveBeenCalledWith(
      "memeloop.terminal.status.update",
      expect.objectContaining({ sessionId: "s1", status: "exited" }),
    );

    // unsub called via status.status !== "running" path, plus get() status !== "running" path
    expect(unsubOutput).toHaveBeenCalled();
    expect(unsubStatus).toHaveBeenCalled();
    expect(unsubPrompt).toHaveBeenCalled();
  });

  it("until-exit with stream=false returns empty chunks and does not cancel", async () => {
    const storage = mkStorage();
    const terminalManager = {
      start: vi.fn().mockResolvedValue({ sessionId: "s2" }),
      follow: vi.fn().mockResolvedValue({
        sessionId: "s2",
        status: "exited",
        exitCode: 0,
        nextSeq: 2,
        done: true,
        chunks: [
          { sessionId: "s2", seq: 1, stream: "stdout", data: "OK", ts: 1 },
          { sessionId: "s2", seq: 2, stream: "stderr", data: "WARN", ts: 2 },
        ],
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockReturnValue({ sessionId: "s2", status: "running" }),
      list: vi.fn(),
      respond: vi.fn(),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onStatusUpdate: vi.fn().mockReturnValue(() => {}),
      onInteractionPrompt: vi.fn().mockReturnValue(() => {}),
    } as any;

    const ctx: RpcHandlerContext = {
      runtime: {
        createAgent: vi.fn(),
        sendMessage: vi.fn(),
        cancelAgent: vi.fn(),
        subscribeToUpdates: vi.fn().mockReturnValue(() => {}),
      } as any,
      storage,
      terminalManager,
      wikiManager: undefined,
      toolRegistry: undefined,
      nodeId: "node-self",
      notify: undefined,
    };

    const r = (await handleRpc(ctx, "memeloop.terminal.execute", {
      command: "cmd",
      waitMode: "until-exit",
      timeoutMs: 1000,
      stream: false,
    })) as any;

    expect(terminalManager.follow).toHaveBeenCalledWith(
      "s2",
      expect.objectContaining({ untilExit: true }),
    );
    expect(terminalManager.cancel).not.toHaveBeenCalled();
    expect(r.timedOut).toBe(false);
    expect(r.chunks).toEqual([]);
    expect(r.stdout).toBe("OK");
    expect(r.stderr).toBe("WARN");
  });
});
