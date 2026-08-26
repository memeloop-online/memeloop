import { safeErrorMessageFromUnknown } from '../../safeError.js';
import type { BuiltinToolImpl } from './types.js';

const TOOL_ID = 'mcpClient';

export const mcpClientConfigSchema = {
  type: 'object',
  properties: {
    nodeId: { type: 'string', description: 'Target node ID' },
    serverName: { type: 'string', description: 'MCP server name on that node' },
    toolName: { type: 'string', description: 'Tool to invoke' },
    args: { type: 'object', description: 'Tool arguments' },
  },
  required: ['nodeId', 'serverName', 'toolName'],
} as const;

export const mcpClientImpl: BuiltinToolImpl = async (arguments_, context) => {
  context.operationSignal?.throwIfAborted();
  const nodeId = arguments_.nodeId as string | undefined;
  const serverName = arguments_.serverName as string | undefined;
  const toolName = arguments_.toolName as string | undefined;
  const toolArguments = (arguments_.args as Record<string, unknown>) ?? {};

  if (!nodeId || !serverName || !toolName) {
    return {
      error: 'mcpClient requires nodeId, serverName, and toolName',
    };
  }

  if (!context.mcpCallRemote) {
    return {
      error: 'MCP proxy not configured (no mcpCallRemote in context). Connect to nodes that expose MCP.',
    };
  }

  try {
    const result = await context.mcpCallRemote(
      nodeId,
      serverName,
      toolName,
      toolArguments,
      { signal: context.operationSignal },
    );
    context.operationSignal?.throwIfAborted();
    return { result };
  } catch (error) {
    if (context.operationSignal?.aborted) context.operationSignal.throwIfAborted();
    const message = safeErrorMessageFromUnknown(error, { fallback: 'MCP request failed' });
    return { error: `MCP call failed: ${message}` };
  }
};

export function getMcpClientToolId(): string {
  return TOOL_ID;
}
