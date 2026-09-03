/**
 * 本地 MCP stdio 客户端（从 TidGi-Desktop modelContextProtocol.ts 思路迁移，供 JSON-RPC memeloop.mcp.* 使用）。
 */
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport';

import { MEMELOOP_CLI_VERSION } from '../version.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
}

export type McpListedTool = { serverName: string; name: string; description?: string };

export interface McpClientLogger {
  warn?: (message: string, ...arguments_: unknown[]) => void;
}

async function withMcpServerClient<T>(
  server: McpServerConfig,
  run: (client: Client) => Promise<T>,
  logger?: McpClientLogger,
): Promise<T> {
  const client = new Client({ name: 'memeloop-cli', version: MEMELOOP_CLI_VERSION }, { capabilities: {} });
  const transport: Transport = new StdioClientTransport({ command: server.command, args: server.args ?? [] });
  let primaryFailed = false;
  let primaryError: unknown;
  let result!: T;
  try {
    await client.connect(transport);
    result = await run(client);
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }
  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    await client.close();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
    logger?.warn?.(`MCP server '${server.name}' cleanup failed`, error);
  }
  if (primaryFailed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
  return result;
}

export async function listAllMcpTools(
  servers: McpServerConfig[],
  logger?: McpClientLogger,
): Promise<McpListedTool[]> {
  if (servers.length === 0) return [];

  const out: McpListedTool[] = [];

  for (const s of servers) {
    await withMcpServerClient(s, async client => {
      const result = await client.listTools();
      for (const t of result.tools ?? []) {
        out.push({ serverName: s.name, name: t.name, description: t.description });
      }
      return undefined;
    }, logger);
  }

  return out;
}

export async function callMcpToolOnServer(
  servers: McpServerConfig[],
  serverName: string,
  toolName: string,
  arguments_: Record<string, unknown>,
  logger?: McpClientLogger,
): Promise<unknown> {
  const s = servers.find((x) => x.name === serverName);
  if (!s) {
    throw new Error(`Unknown MCP server: ${serverName}`);
  }

  return withMcpServerClient(s, async client => {
    return client.callTool({ name: toolName, arguments: arguments_ });
  }, logger);
}
