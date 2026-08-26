/**
 * 本地 MCP stdio 客户端（从 TidGi-Desktop modelContextProtocol.ts 思路迁移，供 JSON-RPC memeloop.mcp.* 使用）。
 */
import { MEMELOOP_CLI_VERSION } from '../version.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
}

export type McpListedTool = { serverName: string; name: string; description?: string };

export async function listAllMcpTools(servers: McpServerConfig[]): Promise<McpListedTool[]> {
  if (servers.length === 0) return [];

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const out: McpListedTool[] = [];

  for (const s of servers) {
    const client = new Client({ name: 'memeloop-cli', version: MEMELOOP_CLI_VERSION }, { capabilities: {} });
    const transport = new StdioClientTransport({ command: s.command, args: s.args ?? [] });
    try {
      await client.connect(transport);
      const result = await client.listTools();
      for (const t of result.tools ?? []) {
        out.push({ serverName: s.name, name: t.name, description: t.description });
      }
    } finally {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
  }

  return out;
}

export async function callMcpToolOnServer(
  servers: McpServerConfig[],
  serverName: string,
  toolName: string,
  arguments_: Record<string, unknown>,
): Promise<unknown> {
  const s = servers.find((x) => x.name === serverName);
  if (!s) {
    throw new Error(`Unknown MCP server: ${serverName}`);
  }

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const client = new Client({ name: 'memeloop-cli', version: MEMELOOP_CLI_VERSION }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: s.command, args: s.args ?? [] });
  await client.connect(transport);
  try {
    return await client.callTool({ name: toolName, arguments: arguments_ });
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}
