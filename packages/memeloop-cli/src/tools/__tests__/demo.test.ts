import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IToolRegistry } from 'memeloop';
import { MEMELOOP_STRUCTURED_TOOL_KEY } from 'memeloop';

// Mock child_process for demo server spawning
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    stdout: {
      on: vi.fn(),
    },
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn((event: string, callback: () => void) => {
      if (event === 'spawn') {
        setTimeout(() => {
          callback();
        }, 10);
      }
    }),
    kill: vi.fn(),
  })),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    cb(null, 'mock output');
  }),
}));

globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;

import { registerDemoTools } from '../demo.js';

vi.mock('../screenshot', () => ({
  takeScreenshot: vi.fn(async () => ({
    success: true,
    imageBase64: 'ZmFrZS1pbWFnZQ==',
    contentHash: 'sha256-demo',
    width: 1920,
    height: 1080,
    bytes: 10,
  })),
}));

class FakeRegistry implements IToolRegistry {
  tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  registerTool(id: string, impl: unknown): void {
    if (typeof impl !== 'function') throw new TypeError('tool must be callable');
    this.tools.set(id, impl as (args: Record<string, unknown>) => Promise<unknown>);
  }
  getTool(id: string): unknown {
    return this.tools.get(id);
  }
  listTools(): string[] {
    return [...this.tools.keys()];
  }
}

describe('demo tools', () => {
  let registry: FakeRegistry;

  beforeEach(() => {
    registry = new FakeRegistry();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers demo.start, demo.stop, demo.screenshot tools', () => {
    registerDemoTools(registry);
    expect(registry.tools.has('demo.start')).toBe(true);
    expect(registry.tools.has('demo.stop')).toBe(true);
    expect(registry.tools.has('demo.screenshot')).toBe(true);
  });

  it('demo.start validates workingDir parameter', async () => {
    registerDemoTools(registry as IToolRegistry);
    const tool = registry.tools.get('demo.start')!;
    const res = (await tool({})) as Record<string, unknown>;
    expect(res.error).toContain('cwd');
  });

  it('demo.start validates command parameter', async () => {
    registerDemoTools(registry as IToolRegistry);
    const tool = registry.tools.get('demo.start')!;
    const res = (await tool({ workingDir: '/tmp' })) as Record<string, unknown>;
    expect(res.error).toContain('command');
  });

  it('demo.start spawns server successfully', async () => {
    registerDemoTools(registry as IToolRegistry);
    const tool = registry.tools.get('demo.start')!;
    const res = (await tool({
      workingDir: '/tmp/test-app',
      command: 'npm run dev',
    })) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(res.serverId).toBeDefined();
    expect(res.url).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it('demo.start detects port from command', async () => {
    registerDemoTools(registry as IToolRegistry);
    const tool = registry.tools.get('demo.start')!;
    const res = (await tool({
      workingDir: '/tmp/test-app',
      command: 'npm run dev -- --port 4000',
    })) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(res.url).toBe('http://localhost:4000');
  });

  it('demo.stop validates serverId parameter', async () => {
    registerDemoTools(registry as IToolRegistry);
    const tool = registry.tools.get('demo.stop')!;
    const res = (await tool({})) as Record<string, unknown>;
    expect(res.error).toContain('serverId');
  });

  it('demo.stop handles non-existent serverId', async () => {
    registerDemoTools(registry as IToolRegistry);
    const tool = registry.tools.get('demo.stop')!;
    const res = (await tool({ serverId: 'non-existent' })) as Record<string, unknown>;
    expect(res.error).toContain('not found');
  });

  it('demo.screenshot validates workingDir parameter', async () => {
    registerDemoTools(registry as IToolRegistry);
    const tool = registry.tools.get('demo.screenshot')!;
    const res = (await tool({})) as Record<string, unknown>;
    expect(res.error).toContain('cwd');
  });

  it('demo.screenshot validates command parameter', async () => {
    registerDemoTools(registry as IToolRegistry);
    const tool = registry.tools.get('demo.screenshot')!;
    const res = (await tool({ workingDir: '/tmp' })) as Record<string, unknown>;
    expect(res.error).toContain('command');
  });

  it('demo.screenshot returns structured summary for remote verification', async () => {
    registerDemoTools(registry as IToolRegistry);
    const tool = registry.tools.get('demo.screenshot')!;
    const res = (await tool({
      cwd: '/tmp/test-app',
      command: 'npm run dev -- --port 4000',
      port: 4000,
    })) as Record<string, unknown>;
    expect(res.success).toBe(true);
    expect((res.screenshot as Record<string, unknown>).contentHash).toBe('sha256-demo');
    expect((res.screenshot as Record<string, unknown>).bytes).toBe(10);
    expect((res[MEMELOOP_STRUCTURED_TOOL_KEY] as { summary: string }).summary).toContain(
      'Demo screenshot captured',
    );
  }, 10000);
});
