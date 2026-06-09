import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { remoteAgentImpl } from "memeloop";
import type {
  BuiltinToolContext,
  IAgentStorage,
  IChatSyncAdapter,
  ILLMProvider,
  INetworkService,
  IToolRegistry,
} from "memeloop";

import { PeerConnectionManager } from "../network/index.js";
import { generateX25519KeyPairForNoise } from "../network/noiseXxHandshake.js";
import { startMockOpenAI } from "../testing/mockOpenAI.js";
import { startTestNode } from "../testing/testNode.js";

function createMinimalContext(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  const storage: IAgentStorage = {
    listConversations: async () => [],
    getMessages: async () => [],
    appendMessage: async () => undefined,
    upsertConversationMetadata: async () => undefined,
    insertMessagesIfAbsent: async () => undefined,
    getAttachment: async () => null,
    saveAttachment: async () => undefined,
    getAgentDefinition: async () => null,
    saveAgentInstance: async () => undefined,
    getConversationMeta: async () => null,
  };
  const llmProvider: ILLMProvider = {
    name: "mock",
    model: undefined,
  };
  const tools: IToolRegistry = {
    registerTool: () => undefined,
    getTool: () => undefined,
    listTools: () => [],
  };
  const syncAdapters: IChatSyncAdapter[] = [];
  const network: INetworkService = {
    start: async () => undefined,
    stop: async () => undefined,
  };
  return {
    storage,
    llmProvider,
    tools,
    syncAdapters,
    network,
    ...overrides,
  };
}

describe("remoteAgent dogfood e2e", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  // E2E test requiring real AI SDK model to drive TaskAgent loop.
  // Mock HTTP server provides OpenAI-compatible responses but streamText()
  // may not consume them correctly in the current setup. Use real provider.
  // This test requires a real AI SDK model to drive the TaskAgent loop.
  it.skip("runs one remote coding task on a worker node and returns worker output through chat-log fallback", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memeloop-remote-dogfood-"));
    cleanups.push(async () => {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // Ignore Windows cleanup flakiness when file handles settle late.
      }
    });

    const workerRelativePath = path.join("worker-output", "dogfood-result.txt");
    const workerDataDir = path.join(tempRoot, "worker-data");
    const workerWorkspaceDir = path.join(tempRoot, "worker-workspace");

    fs.mkdirSync(workerDataDir, { recursive: true });
    fs.mkdirSync(workerWorkspaceDir, { recursive: true });

    const mock = await startMockOpenAI({
      replyText: `<tool_use name="file.write">{"path":"${workerRelativePath.replace(/\\/g, "/")}","content":"created by remote worker"}</tool_use>`,
    });
    cleanups.push(async () => {
      await mock.stop();
    });

    const worker = await startTestNode("worker-node", {
      config: {
        providers: [{ name: "oai", baseUrl: mock.baseUrl, apiKey: "k" }],
        tools: { allowlist: ["file.read", "file.write"] },
      },
      dataDir: workerDataDir,
      fileBaseDir: workerWorkspaceDir,
    });
    cleanups.push(async () => {
      await new Promise<void>((resolve) =>
        worker.server.close(() => {
          resolve();
        }),
      );
    });
    const outputFile = path.join(workerWorkspaceDir, workerRelativePath);
    const dataDirOutputFile = path.join(workerDataDir, workerRelativePath);

    const controlNoiseKeyPair = await generateX25519KeyPairForNoise();

    const controlManager = new PeerConnectionManager({
      localNodeId: "control-node",
      noiseStaticKeyPair: controlNoiseKeyPair,
    });
    cleanups.push(() => {
      controlManager.shutdown();
    });

    await controlManager.addPeerByUrl(`ws://127.0.0.1:${worker.port}`);

    const result = (await remoteAgentImpl(
      {
        nodeId: "worker-node",
        definitionId: "memeloop:code-assistant",
        message: "Create the dogfood result file using file.write.",
      },
      createMinimalContext({
        sendRpcToNode: (nodeId, method, params) =>
          controlManager.sendRpcToNode(nodeId, method, params),
        getPeers: async () => controlManager.getPeers(),
        remoteAgentStreamTimeoutMs: 2_000,
      }),
    )) as Record<string, unknown>;

    expect(result.remoteNodeId).toBe("worker-node");
    expect(typeof result.remoteConversationId).toBe("string");
    expect(typeof result.summary).toBe("string");
    expect(fs.existsSync(outputFile)).toBe(true);
    expect(fs.existsSync(dataDirOutputFile)).toBe(false);
    expect(fs.readFileSync(outputFile, "utf8")).toBe("created by remote worker");
    expect(String(result.summary)).toContain("file.write");
  }, 20_000);
});
