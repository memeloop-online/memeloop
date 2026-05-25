/**
 * ACP Server — transports JSON-RPC over stdio or TCP.
 */
import { createInterface } from "node:readline";
import type { Socket, Server as TcpServer } from "node:net";
import { createServer } from "node:net";

import type { JsonRpcRequest, JsonRpcResponse } from "@memeloop/protocol";
import { isJsonRpcRequest } from "@memeloop/protocol";
import type { MemeLoopRuntime } from "memeloop";

import {
  ACP_ERROR_CODES,
  createError,
  createNotification,
  createSuccess,
  type AcpCreateSessionParams,
  type AcpMethod,
  type AcpSendPromptParams,
  type AcpSendPromptResult,
} from "./protocol.js";
import { AcpSessionManager } from "./sessionManager.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AcpServerOptions {
  /** Transport mode. */
  mode: "stdio" | "tcp";
  /** TCP port (only used in tcp mode). */
  port?: number;
  /** MemeLoop runtime instance. */
  runtime: MemeLoopRuntime;
  /** Logger (defaults to stderr). */
  logger?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Server entry
// ---------------------------------------------------------------------------

export async function startAcpServer(options: AcpServerOptions): Promise<void> {
  const log = options.logger ?? (() => {});
  const sessionManager = new AcpSessionManager(options.runtime);

  if (options.mode === "stdio") {
    await runStdioServer(sessionManager, log);
  } else {
    const port = options.port ?? 3000;
    await runTcpServer(sessionManager, port, log);
  }
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

async function dispatch(
  request: JsonRpcRequest,
  sessionManager: AcpSessionManager,
): Promise<JsonRpcResponse> {
  const { method, id, params } = request;

  switch (method as AcpMethod) {
    // ---- initialize ----
    case "acp/initialize": {
      return createSuccess(id, {
        serverInfo: {
          name: "memeloop-acp",
          version: "0.1.0",
          protocolVersion: "0.1.0",
        },
      });
    }

    // ---- createSession ----
    case "acp/createSession": {
      const p = (params ?? {}) as AcpCreateSessionParams;
      const info = await sessionManager.createSession(p.agentId, p.resumeId);
      return createSuccess<"acp/createSession">(id, info);
    }

    // ---- sendPrompt (streaming via notifications) ----
    case "acp/sendPrompt": {
      const p = (params ?? {}) as AcpSendPromptParams;
      if (!p.sessionId || !p.prompt) {
        return createError(id, ACP_ERROR_CODES.INVALID_PARAMS, "Missing sessionId or prompt");
      }

      let chunkCount = 0;
      try {
        for await (const chunk of sessionManager.sendPrompt(p.sessionId, p.prompt)) {
          chunkCount++;
          emitNotification(`acp/stream/${p.sessionId}`, { chunk });
        }
      } catch (err) {
        return createError(
          id,
          ACP_ERROR_CODES.INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
        );
      }

      const result: AcpSendPromptResult = { sessionId: p.sessionId, chunkCount };
      return createSuccess<"acp/sendPrompt">(id, result);
    }

    // ---- getSession ----
    case "acp/getSession": {
      const p = params as Record<string, string> | undefined;
      const sessionId = p?.["sessionId"];
      if (!sessionId) {
        return createError(id, ACP_ERROR_CODES.INVALID_PARAMS, "Missing sessionId");
      }
      const session = sessionManager.getSession(sessionId);
      return createSuccess<"acp/getSession">(id, { session });
    }

    // ---- listSessions ----
    case "acp/listSessions": {
      const sessions = sessionManager.listSessions();
      return createSuccess<"acp/listSessions">(id, { sessions });
    }

    // ---- cancelSession ----
    case "acp/cancelSession": {
      const p = params as Record<string, string> | undefined;
      const sessionId = p?.["sessionId"];
      if (!sessionId) {
        return createError(id, ACP_ERROR_CODES.INVALID_PARAMS, "Missing sessionId");
      }
      const ok = await sessionManager.cancelSession(sessionId);
      if (!ok) {
        return createError(
          id,
          ACP_ERROR_CODES.SESSION_NOT_FOUND,
          `Session not found: ${sessionId}`,
        );
      }
      return createSuccess<"acp/cancelSession">(id, { ok: true });
    }

    default:
      return createError(id, ACP_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

/**
 * Notification emitter – overridden by transport layer.
 * In stdio mode it writes to stdout; in TCP mode it writes to the active socket.
 */
let emitNotification: (method: string, params?: unknown) => void = () => {};

async function runStdioServer(
  sessionManager: AcpSessionManager,
  log: (msg: string) => void,
): Promise<void> {
  const rl = createInterface({ input: process.stdin });

  emitNotification = (method, params) => {
    const notif = createNotification(method, params);
    process.stdout.write(JSON.stringify(notif) + "\n");
  };

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let request: unknown;
    try {
      request = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        JSON.stringify(createError(null, ACP_ERROR_CODES.PARSE_ERROR, "Parse error")) + "\n",
      );
      continue;
    }

    if (!isJsonRpcRequest(request)) {
      process.stdout.write(
        JSON.stringify(createError(null, ACP_ERROR_CODES.INVALID_REQUEST, "Invalid Request")) + "\n",
      );
      continue;
    }

    // Notifications (id = null) are handled silently.
    if (request.id === null) {
      log(`[acp/stdio] notification: ${request.method}`);
      continue;
    }

    try {
      const response = await dispatch(request, sessionManager);
      process.stdout.write(JSON.stringify(response) + "\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(
        JSON.stringify(createError(request.id, ACP_ERROR_CODES.INTERNAL_ERROR, message)) + "\n",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// TCP transport
// ---------------------------------------------------------------------------

async function runTcpServer(
  sessionManager: AcpSessionManager,
  port: number,
  log: (msg: string) => void,
): Promise<void> {
  let server: TcpServer | undefined;

  return new Promise<void>((_resolveServer, _rejectServer) => {
    server = createServer((socket: Socket) => {
      const rl = createInterface({ input: socket });

      const write = (data: string) => {
        if (!socket.destroyed) {
          socket.write(data);
        }
      };

      const localEmit = (method: string, params?: unknown) => {
        const notif = createNotification(method, params);
        write(JSON.stringify(notif) + "\n");
      };

      void (async () => {
        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let request: unknown;
          try {
            request = JSON.parse(trimmed);
          } catch {
            write(
              JSON.stringify(createError(null, ACP_ERROR_CODES.PARSE_ERROR, "Parse error")) + "\n",
            );
            continue;
          }

          if (!isJsonRpcRequest(request)) {
            write(
              JSON.stringify(createError(null, ACP_ERROR_CODES.INVALID_REQUEST, "Invalid Request")) +
                "\n",
            );
            continue;
          }

          if (request.id === null) {
            log(`[acp/tcp] notification: ${request.method}`);
            continue;
          }

          try {
            // Swap emit so streaming sendPrompt writes to this socket.
            const prevEmit = emitNotification;
            emitNotification = localEmit;
            const response = await dispatch(request, sessionManager);
            emitNotification = prevEmit;
            write(JSON.stringify(response) + "\n");
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            write(
              JSON.stringify(createError(request.id, ACP_ERROR_CODES.INTERNAL_ERROR, message)) +
                "\n",
            );
          }
        }
      })();

      socket.on("error", (err) => {
        log(`[acp/tcp] socket error: ${err.message}`);
      });
    });

    server.on("error", (err) => {
      log(`[acp/tcp] server error: ${err.message}`);
    });

    server.listen(port, () => {
      log(`[acp] TCP server listening on port ${port}`);
    });
  });
}
