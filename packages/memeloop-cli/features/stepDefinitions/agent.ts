import { Given, Then, When } from "@cucumber/cucumber";
import type { DataTable } from "@cucumber/cucumber";

import type { NodeWorld } from "./world.js";
import { startMockOpenAI } from "../../src/testing/mockOpenAI";

function localClientIdForNode(nodeId: string): string {
  // test convention: node-A <-> client-A
  return nodeId.replace(/^node-/, "client-");
}

Given(
  'a mock OpenAI server replying with {string}',
  async function (this: NodeWorld, replyText: string) {
    const started = await startMockOpenAI([{ response: replyText }]);
    this.mockOpenAI = { baseUrl: started.baseUrl, stop: started.stop, setRules: started.setRules, addRules: started.addRules, resetCount: started.resetCount };
  },
);

Given(
  "a mock OpenAI server with sequential replies:",
  async function (this: NodeWorld, table: DataTable) {
    const contents = table.hashes().map((row) => row.content);
    const rules = contents.map((response) => ({ response }));
    const started = await startMockOpenAI(rules);
    this.mockOpenAI = { baseUrl: started.baseUrl, stop: started.stop, setRules: started.setRules, addRules: started.addRules, resetCount: started.resetCount };
  },
);

Given(
  'test tool {string} is registered on node {string}',
  function (this: NodeWorld, toolId: string, nodeId: string) {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node not started: ${nodeId}`);
    }
    if (toolId !== "e2eEcho") {
      throw new Error(`Only e2eEcho is supported in this step, got ${toolId}`);
    }
    node.registerTool(toolId, async (args: Record<string, unknown>) => ({
      echoed: String(args.text ?? args.q ?? ""),
    }));
  },
);

When(
  'I create an agent on {string} using definition {string}',
  async function (this: NodeWorld, nodeId: string, definitionId: string) {
    // We reuse PeerConnectionManager plumbing by treating nodeId as the peerId key.
    const mgr = this.getOrCreatePeerManager(localClientIdForNode(nodeId));
    const result = (await mgr.sendRpcToNode(nodeId, "memeloop.agent.create", {
      definitionId,
      initialMessage: "hello",
    })) as { conversationId?: string } | { id?: string } | Record<string, unknown>;

    const conversationId =
      (result as any).conversationId ?? (result as any).id ?? (result as any).conversation?.conversationId;
    if (!conversationId || typeof conversationId !== "string") {
      throw new Error(`Agent create did not return conversationId. Got: ${JSON.stringify(result)}`);
    }
    this.lastConversationIdByNode.set(nodeId, conversationId);
  },
);

When(
  'I send message {string} to that agent on {string}',
  async function (this: NodeWorld, message: string, nodeId: string) {
    const conversationId = this.lastConversationIdByNode.get(nodeId);
    if (!conversationId) throw new Error(`No conversationId stored for node ${nodeId}`);
    const mgr = this.getOrCreatePeerManager(localClientIdForNode(nodeId));
    await mgr.sendRpcToNode(nodeId, "memeloop.agent.send", { conversationId, message });
  },
);

When(
  'I cancel the agent on {string}',
  async function (this: NodeWorld, nodeId: string) {
    const conversationId = this.lastConversationIdByNode.get(nodeId);
    if (!conversationId) throw new Error(`No conversationId stored for node ${nodeId}`);
    const mgr = this.getOrCreatePeerManager(localClientIdForNode(nodeId));
    await mgr.sendRpcToNode(nodeId, "memeloop.agent.cancel", { conversationId });
  },
);

Then(
  'node {string} should have persisted a tool message for that conversation',
  async function (this: NodeWorld, nodeId: string) {
    const conversationId = this.lastConversationIdByNode.get(nodeId);
    if (!conversationId) throw new Error(`No conversationId stored for node ${nodeId}`);
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node not started: ${nodeId}`);
    for (let i = 0; i < 80; i += 1) {
      const msgs = await node.getConversationMessages(conversationId);
      if (msgs.some((m) => m.role === "tool")) {
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Expected a tool role message in conversation ${conversationId}`);
  },
);

Then(
  'node {string} should have assistant text containing {string} for that conversation',
  async function (this: NodeWorld, nodeId: string, substring: string) {
    const conversationId = this.lastConversationIdByNode.get(nodeId);
    if (!conversationId) throw new Error(`No conversationId stored for node ${nodeId}`);
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node not started: ${nodeId}`);
    for (let i = 0; i < 80; i += 1) {
      const msgs = await node.getConversationMessages(conversationId);
      const hit = msgs.some(
        (m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes(substring),
      );
      if (hit) {
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Expected assistant content containing ${JSON.stringify(substring)}`);
  },
);

Then(
  'the agent list on {string} should contain that conversation',
  async function (this: NodeWorld, nodeId: string) {
    const conversationId = this.lastConversationIdByNode.get(nodeId);
    if (!conversationId) throw new Error(`No conversationId stored for node ${nodeId}`);
    const mgr = this.getOrCreatePeerManager(localClientIdForNode(nodeId));
    const result = (await mgr.sendRpcToNode(nodeId, "memeloop.agent.list", {})) as {
      conversations?: Array<{ conversationId?: string }>;
    };
    const list = result.conversations ?? [];
    const found = list.some((c) => c.conversationId === conversationId);
    if (!found) {
      throw new Error(
        `Expected conversation ${conversationId} in agent.list, got: ${JSON.stringify(
          list.map((c) => c.conversationId),
        )}`,
      );
    }
  },
);

