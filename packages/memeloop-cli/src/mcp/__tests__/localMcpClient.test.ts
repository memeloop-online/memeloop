import { describe, expect, it, vi } from 'vitest';

import { listAllMcpTools } from '../localMcpClient.js';
import { callMcpToolOnServer } from '../localMcpClient.js';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const close = vi.fn().mockResolvedValue(undefined);

  class Client {
    async connect(_transport: any) {
      return;
    }
    async listTools() {
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
      await close();
    }
  }

  return { Client };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: class StdioClientTransport {
      constructor(public opts: any) {}
    },
  };
});

describe('localMcpClient', () => {
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
});
