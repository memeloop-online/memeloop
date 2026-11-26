import { afterEach, describe, expect, it, vi } from 'vitest';

import { listAllMcpTools } from '../localMcpClient.js';
import { callMcpToolOnServer } from '../localMcpClient.js';

const mcpState = vi.hoisted(() => ({ closeError: null as Error | null, listError: null as Error | null }));

vi.mock('@modelcontextprotocol/sdk/client', () => {
  const close = vi.fn().mockResolvedValue(undefined);

  class Client {
    async connect(_transport: any) {
      return;
    }
    async listTools() {
      if (mcpState.listError) throw mcpState.listError;
      return {
        tools: [
          { name: 't1', description: 'd1' },
          { name: 't2' },
        ],
      };
    }
    async callTool({ name, arguments: args }: { name: string; arguments: any }) {
      return { ok: true, name, args };
    }
    async close() {
      if (mcpState.closeError) throw mcpState.closeError;
      await close();
    }
  }

  return { Client };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio', () => {
  return {
    StdioClientTransport: class StdioClientTransport {
      constructor(public opts: any) {}
    },
  };
});

describe('localMcpClient', () => {
  afterEach(() => {
    mcpState.closeError = null;
    mcpState.listError = null;
  });

  it('listAllMcpTools returns empty array when no servers configured', async () => {
    await expect(listAllMcpTools([])).resolves.toEqual([]);
  });

  it('listAllMcpTools lists tools and closes client', async () => {
    const servers = [
      { name: 's1', command: '/bin/echo', args: ['--help'] },
      { name: 's2', command: '/bin/echo' },
    ];
    const out = await listAllMcpTools(servers as any);
    expect(out).toEqual([
      { serverName: 's1', name: 't1', description: 'd1' },
      { serverName: 's1', name: 't2', description: undefined },
      { serverName: 's2', name: 't1', description: 'd1' },
      { serverName: 's2', name: 't2', description: undefined },
    ]);
  });

  it('callMcpToolOnServer throws for unknown server', async () => {
    await expect(
      callMcpToolOnServer([{ name: 's1', command: 'x' }] as any, 's404', 'tool', { a: 1 }),
    ).rejects.toThrow('Unknown MCP server: s404');
  });

  it('callMcpToolOnServer calls tool and returns result', async () => {
    const out = await callMcpToolOnServer([{ name: 's1', command: 'x' }] as any, 's1', 'tool1', {
      a: 1,
    });
    expect(out).toEqual({ ok: true, name: 'tool1', args: { a: 1 } });
  });

  it('surfaces cleanup failures when there is no primary MCP operation error', async () => {
    const cleanupError = new Error('close failed');
    const warn = vi.fn();
    mcpState.closeError = cleanupError;

    await expect(listAllMcpTools([{ name: 's1', command: 'x' }], { warn })).rejects.toBe(cleanupError);
    expect(warn).toHaveBeenCalledWith("MCP server 's1' cleanup failed", cleanupError);
  });

  it('preserves the primary MCP operation error while reporting cleanup failure', async () => {
    const cleanupError = new Error('close failed');
    const primaryError = new Error('list failed');
    const warn = vi.fn();
    mcpState.closeError = cleanupError;
    mcpState.listError = primaryError;
    try {
      await expect(listAllMcpTools([{ name: 's1', command: 'x' }], { warn })).rejects.toBe(primaryError);
    } finally {
      mcpState.listError = null;
    }
    expect(warn).toHaveBeenCalledWith("MCP server 's1' cleanup failed", cleanupError);
  });
});
