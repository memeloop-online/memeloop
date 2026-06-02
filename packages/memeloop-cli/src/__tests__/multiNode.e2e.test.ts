import http from "node:http";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { PeerConnectionManager } from "../network/index.js";
import { startTestNode } from "../testing/testNode.js";
import { startMockOpenAI } from "../testing/mockOpenAI.js";

describe("memeloop-cli multi-node e2e", () => {
  const servers: http.Server[] = [];
  let mockOpenAI: Awaited<ReturnType<typeof startMockOpenAI>>;

  beforeAll(async () => {
    mockOpenAI = await startMockOpenAI({ replyText: "ok" });
  });

  afterAll(async () => {
    await mockOpenAI.stop();
  });

  it(
    "nodes can discover each other via WebSocket and memeloop.node.getInfo",
    async () => {
      const nodeA = await startTestNode("node-A", {
        config: {
          providers: [{ name: "oai", baseUrl: mockOpenAI.baseUrl, apiKey: "k" }],
        },
      });
      const nodeB = await startTestNode("node-B", {
        config: {
          providers: [{ name: "oai", baseUrl: mockOpenAI.baseUrl, apiKey: "k" }],
        },
      });
      servers.push(nodeA.server, nodeB.server);

      const managerA = new PeerConnectionManager({
        localNodeId: "node-A",
        noiseStaticKeyPair: nodeA.noiseStaticKeyPair,
      });
      const managerB = new PeerConnectionManager({
        localNodeId: "node-B",
        noiseStaticKeyPair: nodeB.noiseStaticKeyPair,
      });

      const { nodeId: remoteFromA } = await managerA.addPeerByUrl(
        `ws://127.0.0.1:${nodeB.port}`,
      );
      const { nodeId: remoteFromB } = await managerB.addPeerByUrl(
        `ws://127.0.0.1:${nodeA.port}`,
      );

      expect(remoteFromA).toBe("node-B");
      expect(remoteFromB).toBe("node-A");

      const peersSeenByA = managerA.getPeers();
      const peersSeenByB = managerB.getPeers();

      expect(peersSeenByA.some((p) => p.identity.nodeId === "node-B")).toBe(
        true,
      );
      expect(peersSeenByB.some((p) => p.identity.nodeId === "node-A")).toBe(
        true,
      );

      const infoFromA = (await managerA.sendRpcToNode(
        "node-B",
        "memeloop.node.getInfo",
        {},
      )) as {
        nodeId: string;
        capabilities?: { hasWiki?: boolean };
      };
      const infoFromB = (await managerB.sendRpcToNode(
        "node-A",
        "memeloop.node.getInfo",
        {},
      )) as {
        nodeId: string;
        capabilities?: { hasWiki?: boolean };
      };

      expect(infoFromA.nodeId).toBe("node-B");
      expect(infoFromB.nodeId).toBe("node-A");
      expect(infoFromA.capabilities?.hasWiki).toBe(false);
      expect(infoFromB.capabilities?.hasWiki).toBe(false);

      managerA.shutdown();
      managerB.shutdown();

      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.close(() => resolve());
            }),
        ),
      );
    },
    30_000,
  );
});

