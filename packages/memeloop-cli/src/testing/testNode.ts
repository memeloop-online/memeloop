import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import type { ChatMessage } from "memeloop";
import type { NoiseStaticKeyPair } from "memeloop";
import { generateX25519KeyPairForNoise } from "memeloop";

import type { NodeConfig } from "../config";
import type { RpcHandlerContext } from "../network";
import { startNodeServerWithMdns } from "../network";
import type { WsAuthOptions } from "../network/nodeServerImpl.js";
import { createNodeRuntime } from "../runtime/index";
import type { ITerminalSessionManager } from "../terminal";

export interface StartedTestNode {
  server: http.Server;
  port: number;
  nodeId: string;
  /** 与本节点 WS 服务端 Noise 静态密钥一致；出站连接时作 initiator 使用。 */
  noiseStaticKeyPair: NoiseStaticKeyPair;
  /** Register an extra tool on this node (e.g. Cucumber / integration tests). */
  registerTool(id: string, impl: (arguments_: Record<string, unknown>) => Promise<unknown>): void;
  /** Read persisted messages for a conversation (TaskAgent + runtime). */
  getConversationMessages(conversationId: string): Promise<ChatMessage[]>;
}

function createTemporaryDirectory(prefix: string): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return base;
}

export async function startTestNode(
  nodeId: string,
  options?: {
    port?: number;
    config?: Partial<NodeConfig>;
    dataDir?: string;
    fileBaseDir?: string;
    terminalManager?: ITerminalSessionManager;
    wikiBasePath?: string;
    wsAuth?: WsAuthOptions;
  },
): Promise<StartedTestNode> {
  const config: NodeConfig = {
    name: nodeId,
    providers: [],
    tools: { allowlist: [], blocklist: [] },
    ...(options?.config ?? {}),
  };
  const dataDirectory = options?.dataDir ?? createTemporaryDirectory(`memeloop-cli-${nodeId}-`);
  const fileBaseDirectory = options?.fileBaseDir ?? dataDirectory;
  const { runtime, storage, wikiManager, toolRegistry, agentDefinitions, fileBaseDirResolved } =
    createNodeRuntime({
      config,
      dataDir: dataDirectory,
      fileBaseDir: fileBaseDirectory,
      terminalManager: options?.terminalManager,
      wikiBasePath: options?.wikiBasePath,
      localNodeId: nodeId,
    });
  const noiseStaticKeyPair = await generateX25519KeyPairForNoise();

  const rpcContext: RpcHandlerContext = {
    runtime,
    storage,
    terminalManager: options?.terminalManager,
    wikiManager,
    toolRegistry,
    nodeId,
    mcpServers: (config.mcpServers ?? []).map((s) => ({
      name: s.name,
      command: s.command,
      args: s.args,
    })),
    agentDefinitions,
    fileBaseDir: fileBaseDirResolved,
  };

  const server = await startNodeServerWithMdns({
    port: options?.port ?? 0,
    nodeId,
    rpcContext,
    serviceName: nodeId,
    wsAuth: options?.wsAuth,
    noise: { staticKeyPair: noiseStaticKeyPair },
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get server address");
  }

  return {
    server,
    port: address.port,
    nodeId,
    noiseStaticKeyPair,
    registerTool(id: string, impl: (arguments_: Record<string, unknown>) => Promise<unknown>) {
      toolRegistry.registerTool(id, impl);
    },
    getConversationMessages(conversationId: string) {
      return storage.getMessages(conversationId, { mode: "full-content" });
    },
  };
}
