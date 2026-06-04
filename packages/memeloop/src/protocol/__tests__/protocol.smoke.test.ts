import { describe, expect, expectTypeOf, it } from "vitest";

import type { AuthChallenge } from "../auth.js";
import { isJsonRpcRequest, sendJsonRpcMethod } from "../rpc.js";
import type { RpcMethodMap, RpcParams } from "../rpc.js";
import { isConversationMeta } from "../sync.js";
import { buildMemeloopFileUri, parseMemeloopUri } from "../uri.js";

describe("memeloop protocol", () => {
  it("loads public API", async () => {
    const m = await import("../index.js");
    expect(m).toBeTypeOf("object");
  });

  it("isJsonRpcRequest narrows JSON-RPC 2.0 requests", () => {
    expect(isJsonRpcRequest(null)).toBe(false);
    expect(isJsonRpcRequest({ jsonrpc: "2.0", method: "x", id: 1 })).toBe(true);
  });

  it("RpcMethodMap params align for agent.create", () => {
    expectTypeOf<RpcParams<"memeloop.agent.create">>().toExtend<{
      definitionId: string;
      initialMessage?: string;
    }>();
    const p: RpcParams<"memeloop.agent.create"> = {
      definitionId: "d",
    };
    expect(p.definitionId).toBe("d");
    const _m: RpcMethodMap["memeloop.agent.create"]["result"] = {
      conversationId: "c",
    };
    expect(_m.conversationId).toBe("c");
  });

  it("AuthChallenge shape (compile-time)", () => {
    expectTypeOf<AuthChallenge>().toExtend<{
      pin: string;
      requestingNodeId: string;
      expiresAt: number;
    }>();
  });

  it("isConversationMeta guards shape", () => {
    expect(isConversationMeta(null)).toBe(false);
    expect(
      isConversationMeta({
        conversationId: "x",
        title: "t",
        lastMessagePreview: "",
        lastMessageTimestamp: 0,
        messageCount: 0,
        originNodeId: "n",
        definitionId: "d",
        isUserInitiated: true,
      }),
    ).toBe(true);
  });

  it("buildMemeloopFileUri / parseMemeloopUri round-trip", () => {
    const nodeId = "n1+test";
    const path = "src/foo bar/baz.ts";
    const uri = buildMemeloopFileUri(nodeId, path);
    expect(uri).toMatch(/^memeloop:\/\/node\//);
    const parsed = parseMemeloopUri(uri);
    expect(parsed).toEqual({
      scheme: "memeloop",
      kind: "file",
      nodeId: "n1+test",
      filePath: "src/foo bar/baz.ts",
    });
    expect(parseMemeloopUri("https://example.com")).toBeNull();
  });

  it("sendJsonRpcMethod forwards to sender", async () => {
    const r = await sendJsonRpcMethod(
      async (m, p) => ({ m, p }),
      "memeloop.agent.resolveQuestion",
      { questionId: "q", answer: "a" },
    );
    expect(r).toEqual({
      m: "memeloop.agent.resolveQuestion",
      p: { questionId: "q", answer: "a" },
    });
  });
});
