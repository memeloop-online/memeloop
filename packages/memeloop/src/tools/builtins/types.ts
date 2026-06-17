import type { NodeStatus } from "../../network/protocol.js";

import type { AgentLoopGenerator, AgentLoopInput } from "../../agentLoops/types.js";
import type { AgentFrameworkContext } from "../../types.js";

/**
 * Context passed to builtin tool implementations.
 * Extends AgentFrameworkContext with optional capabilities for MCP proxy, spawn and remote agent.
 */
export interface BuiltinToolContext extends AgentFrameworkContext {
  /**
   * 当前工具执行时对应的 conversationId（由宿主/运行时注入）。
   * IM 会话工具依赖该值定位会话来源；缺失时工具返回错误而不是抛异常。
   */
  activeToolConversationId?: string;

  /**
   * Run the local task agent (for spawnAgent). If not provided, spawnAgent tool will return an error.
   */
  runLocalAgent?(input: AgentLoopInput): AgentLoopGenerator;

  /**
   * List known peer nodes (for remoteAgent). If not provided, remoteAgent returns empty list / "not configured".
   */
  getPeers?(): Promise<NodeStatus[]>;

  /**
   * Send JSON-RPC to a peer node (for remoteAgent and MCP proxy). If not provided, remote calls fail.
   */
  sendRpcToNode?(nodeId: string, method: string, parameters: unknown): Promise<unknown>;

  /**
   * Call a tool on a remote MCP server on the given node (for mcpClient). If not provided, mcpClient returns error.
   */
  mcpCallRemote?(
    nodeId: string,
    serverName: string,
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown>;

  /**
   * `remoteAgent` 等待远端流式输出的超时（毫秒）。默认 30000。
   */
  remoteAgentStreamTimeoutMs?: number;

  /** 本节点 ID（用于 `spawnAgent` / `remoteAgent` 的 `detailRef.nodeId`）。未设时 spawn 使用 `"local"`。 */
  localNodeId?: string;

  /** `askQuestion` 阻塞前回调（可将 questionId 推送到 IM / UI，供 `resolveQuestion` RPC 回填）。 */
  notifyAskQuestion?(payload: {
    questionId: string;
    question: string;
    conversationId?: string;
    inputType?: "single-select" | "multi-select" | "text";
    options?: Array<{ label: string; description?: string }>;
    allowFreeform?: boolean;
  }): void;
}

/** Tool implementation: (args, context) => result. Context is bound at registration time. */
export type BuiltinToolImpl = (
  arguments_: Record<string, unknown>,
  context: BuiltinToolContext,
) => Promise<unknown> | AsyncIterable<unknown>;
