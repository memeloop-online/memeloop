import { describe, it, expect } from "vitest";
import {
  createRequest,
  createSuccess,
  createError,
  createNotification,
  ACP_ERROR_CODES,
  errorMessage,
} from "../protocol.js";

describe("acp/protocol", () => {
  describe("createRequest", () => {
    it("builds a JSON-RPC 2.0 request with string id", () => {
      const req = createRequest("req-1", "acp/initialize", { capabilities: { clientName: "vscode" } });
      expect(req).toEqual({
        jsonrpc: "2.0",
        id: "req-1",
        method: "acp/initialize",
        params: { capabilities: { clientName: "vscode" } },
      });
    });

    it("builds a request with numeric id", () => {
      const req = createRequest(1, "acp/listSessions", {} as Record<string, never>);
      expect(req.id).toBe(1);
      expect(req.method).toBe("acp/listSessions");
    });

    it("builds a request with empty params", () => {
      const req = createRequest("a", "acp/listSessions", {} as Record<string, never>);
      expect(req.params).toEqual({});
    });
  });

  describe("createSuccess", () => {
    it("builds a success response", () => {
      const resp = createSuccess("req-1", {
        serverInfo: { name: "test", version: "1.0", protocolVersion: "0.1.0" },
      });
      expect(resp.jsonrpc).toBe("2.0");
      expect(resp.id).toBe("req-1");
      expect("result" in resp).toBe(true);
    });

    it("supports null id (notification response)", () => {
      const resp = createSuccess(null, { sessions: [] });
      expect(resp.id).toBeNull();
      expect("result" in resp).toBe(true);
    });
  });

  describe("createError", () => {
    it("builds an error response", () => {
      const resp = createError("req-1", ACP_ERROR_CODES.METHOD_NOT_FOUND, "Method not found");
      expect(resp.jsonrpc).toBe("2.0");
      expect(resp.id).toBe("req-1");
      if ("error" in resp) {
        expect(resp.error.code).toBe(-32601);
        expect(resp.error.message).toBe("Method not found");
      } else {
        expect.fail("Expected error response");
      }
    });

    it("includes optional data", () => {
      const resp = createError(null, -32000, "Custom error", { detail: "extra" });
      if ("error" in resp) {
        expect(resp.error.data).toEqual({ detail: "extra" });
      } else {
        expect.fail("Expected error response");
      }
    });
  });

  describe("createNotification", () => {
    it("builds a notification (null id)", () => {
      const notif = createNotification("acp/stream/session-1", { chunk: { type: "message" } });
      expect(notif.jsonrpc).toBe("2.0");
      expect(notif.id).toBeNull();
      expect(notif.method).toBe("acp/stream/session-1");
    });

    it("builds a notification without params", () => {
      const notif = createNotification("acp/status");
      expect(notif.params).toBeUndefined();
    });
  });

  describe("ACP_ERROR_CODES", () => {
    it("has standard JSON-RPC error codes", () => {
      expect(ACP_ERROR_CODES.PARSE_ERROR).toBe(-32700);
      expect(ACP_ERROR_CODES.INVALID_REQUEST).toBe(-32600);
      expect(ACP_ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
      expect(ACP_ERROR_CODES.INVALID_PARAMS).toBe(-32602);
      expect(ACP_ERROR_CODES.INTERNAL_ERROR).toBe(-32603);
    });

    it("has custom ACP error codes", () => {
      expect(ACP_ERROR_CODES.SESSION_NOT_FOUND).toBe(-32001);
      expect(ACP_ERROR_CODES.UNKNOWN).toBe(-32000);
    });
  });

  describe("errorMessage", () => {
    it("returns known message for registered codes", () => {
      expect(errorMessage(-32700, "X")).toBe("Parse error");
      expect(errorMessage(-32601, "X")).toBe("Method not found");
      expect(errorMessage(-32001, "X")).toBe("Session not found");
    });

    it("returns default for unknown codes", () => {
      expect(errorMessage(-99999, "fallback")).toBe("fallback");
    });
  });
});
