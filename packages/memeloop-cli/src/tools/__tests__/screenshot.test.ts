import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IToolRegistry } from 'memeloop';
import { MEMELOOP_STRUCTURED_TOOL_KEY } from 'memeloop';

// Mock puppeteer
vi.mock('puppeteer', () => ({
  launch: vi.fn(async () => ({
    newPage: vi.fn(async () => ({
      goto: vi.fn(async () => {}),
      setViewport: vi.fn(async () => {}),
      waitForSelector: vi.fn(async () => {}),
      $: vi.fn(async () => ({
        screenshot: vi.fn(async () => Buffer.from('fake-screenshot-data')),
      })),
      screenshot: vi.fn(async () => Buffer.from('fake-screenshot-data')),
      close: vi.fn(async () => {}),
    })),
    close: vi.fn(async () => {}),
  })),
}));

import { registerScreenshotTool } from '../screenshot.js';

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

describe('screenshot tool', () => {
  let registry: FakeRegistry;

  beforeEach(() => {
    registry = new FakeRegistry();
  });

  it('registers screenshot tool', () => {
    registerScreenshotTool(registry);
    expect(registry.tools.has('screenshot')).toBe(true);
  });

  it('validates url parameter', async () => {
    registerScreenshotTool(registry as IToolRegistry);
    const tool = registry.tools.get('screenshot')!;
    const res = (await tool({})) as Record<string, unknown>;
    expect(res.error).toContain('url');
  });

  it('captures screenshot successfully', async () => {
    registerScreenshotTool(registry as IToolRegistry);
    const tool = registry.tools.get('screenshot')!;
    const res = (await tool({ url: 'http://localhost:3000' })) as Record<string, unknown>;
    expect(res.success).toBe(true);
    expect(res.contentHash).toBeDefined();
    expect(res.imageBase64).toBeDefined();
    expect(res.width).toBe(1920);
    expect(res.height).toBe(1080);
    expect(res.bytes).toBe(Buffer.from('fake-screenshot-data').length);
    expect((res[MEMELOOP_STRUCTURED_TOOL_KEY] as { summary: string }).summary).toContain(
      'Screenshot captured for http://localhost:3000',
    );
  });

  it('supports fullPage option', async () => {
    registerScreenshotTool(registry as IToolRegistry);
    const tool = registry.tools.get('screenshot')!;
    const res = (await tool({ url: 'http://localhost:3000', fullPage: true })) as Record<
      string,
      unknown
    >;
    expect(res.success).toBe(true);
  });

  it('supports selector option', async () => {
    registerScreenshotTool(registry as IToolRegistry);
    const tool = registry.tools.get('screenshot')!;
    const res = (await tool({ url: 'http://localhost:3000', selector: '#app' })) as Record<
      string,
      unknown
    >;
    expect(res.success).toBe(true);
  });

  it('supports viewport dimensions', async () => {
    registerScreenshotTool(registry as IToolRegistry);
    const tool = registry.tools.get('screenshot')!;
    const res = (await tool({
      url: 'http://localhost:3000',
      viewportWidth: 1920,
      viewportHeight: 1080,
    })) as Record<string, unknown>;
    expect(res.success).toBe(true);
  });

  it('handles errors gracefully', async () => {
    // Override mock to throw error
    vi.doMock('puppeteer', () => ({
      default: {
        launch: vi.fn(async () => {
          throw new Error('Browser launch failed');
        }),
      },
    }));

    registerScreenshotTool(registry as IToolRegistry);
    const tool = registry.tools.get('screenshot')!;
    const res = (await tool({ url: 'http://localhost:3000' })) as Record<string, unknown>;
    expect(res.error).toBeDefined();
  });
});
