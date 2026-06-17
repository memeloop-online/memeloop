import type { BuiltinToolImpl } from "./types.js";

const TOOL_ID = "mcpForward";

export const mcpForwardConfigSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "listTools"],
      description:
        "Action: 'list' returns nodes with MCP servers, 'listTools' returns all available MCP tools across nodes",
    },
  },
} as const;

interface McpServerInfo {
  name: string;
}

interface McpToolInfo {
  nodeId: string;
  serverName: string;
  name: string;
  description?: string;
}

/**
 * MCP forwarding tool: discover MCP servers and tools on connected nodes.
 * - action=list: returns nodes with their MCP servers
 * - action=listTools: returns all available MCP tools across all nodes
 */
export const mcpForwardImpl: BuiltinToolImpl = async (arguments_, context) => {
  const action = (arguments_.action as string | undefined) ?? "list";

  if (!context.getPeers) {
    return { error: "Peer list not configured (no getPeers)." };
  }

  if (!context.sendRpcToNode) {
    return { error: "Remote node RPC not configured (no sendRpcToNode)." };
  }

  const peers = await context.getPeers();
  const online = peers.filter((p) => p.status === "online");

  if (action === "list") {
    // List nodes with their MCP servers
    const result: Array<{ nodeId: string; name: string; mcpServers: McpServerInfo[] }> = [];

    for (const node of online) {
      try {
        const response = (await context.sendRpcToNode(
          node.identity.nodeId,
          "memeloop.mcp.listServers",
          {},
        )) as {
          servers?: McpServerInfo[];
        };
        const servers = Array.isArray(response?.servers) ? response.servers : [];
        if (servers.length > 0) {
          result.push({
            nodeId: node.identity.nodeId,
            name: node.identity.name,
            mcpServers: servers,
          });
        }
      } catch {
        // Skip nodes that don't support MCP or fail to respond
      }
    }

    return { nodes: result };
  }

  if (action === "listTools") {
    // List all MCP tools across all nodes
    const allTools: McpToolInfo[] = [];

    for (const node of online) {
      try {
        const response = (await context.sendRpcToNode(
          node.identity.nodeId,
          "memeloop.mcp.listTools",
          {},
        )) as {
          tools?: Array<{ serverName: string; name: string; description?: string }>;
        };
        const tools = Array.isArray(response?.tools) ? response.tools : [];
        for (const tool of tools) {
          allTools.push({
            nodeId: node.identity.nodeId,
            serverName: tool.serverName,
            name: tool.name,
            description: tool.description,
          });
        }
      } catch {
        // Skip nodes that don't support MCP or fail to respond
      }
    }

    return { tools: allTools };
  }

  return { error: `Unknown action: ${action}` };
};

export function getMcpForwardToolId(): string {
  return TOOL_ID;
}
