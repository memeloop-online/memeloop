import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// genericNodeTools does: `const execFileAsync = promisify(execFile)`,
// then destructures `{ stdout, stderr }` from the returned value.
// Mock `promisify()` to match that shape.
vi.mock('node:util', () => ({
  promisify: () =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    (async () => ({
      stdout: 'GIT_STDOUT',
      stderr: 'GIT_STDERR',
    })) as any,
}));

import { registerGenericNodeTools } from '../genericNodeTools.js';

class FakeRegistry {
  tools = new Map<string, (args: Record<string, unknown>) => unknown>();
  registerOwnedTool(id: string, impl: unknown): () => boolean {
    this.tools.set(id, impl as (args: Record<string, unknown>) => unknown);
    return () => this.tools.delete(id);
  }
}

describe('genericNodeTools', () => {
  let registry: FakeRegistry;

  beforeEach(() => {
    registry = new FakeRegistry();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('hello', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('git rejects unsupported subcommand', async () => {
    registerGenericNodeTools(registry as any);
    const git = registry.tools.get('git')!;
    const res = await git({ subcommand: 'unknown' });
    expect(res).toMatchObject({ error: expect.stringContaining('Unsupported subcommand') });
  });

  it('git allows allowed subcommand', async () => {
    registerGenericNodeTools(registry as any);
    const git = registry.tools.get('git')!;
    const res = (await git({ subcommand: 'status' })) as any;
    expect(res.output).toContain('GIT_STDOUT');
    expect(res.output).toContain('GIT_STDERR');
    expect(res.isReadOnly).toBe(true);
    expect(res.subcommand).toBe('status');
  });

  it('webFetch validates url', async () => {
    registerGenericNodeTools(registry as any);
    const tool = registry.tools.get('webFetch')!;
    const res1 = await tool({});
    expect(res1).toMatchObject({ error: "Missing 'url'" });
  });

  it('webFetch success path returns ok/status/text', async () => {
    registerGenericNodeTools(registry as any);
    const tool = registry.tools.get('webFetch')!;
    const res = (await tool({ url: 'https://example.com' })) as any;
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.text).toContain('example.com');
    expect(res.text).toContain('hello');
  });

  it('todo supports list/upsert/remove', async () => {
    registerGenericNodeTools(registry as any);
    const tool = registry.tools.get('todo')!;

    const list0 = (await tool({ action: 'list' })) as any;
    expect(list0.todos).toEqual([]);

    const upsert = (await tool({ action: 'upsert', id: 't1', content: 'c1', status: 'pending' })) as any;
    expect(upsert.ok).toBe(true);
    expect(upsert.todo).toMatchObject({ id: 't1', content: 'c1', status: 'pending' });

    const list1 = (await tool({ action: 'list' })) as any;
    expect(list1.todos.length).toBe(1);
    expect(list1.todos[0].id).toBe('t1');

    const remove = (await tool({ action: 'remove', id: 't1' })) as any;
    expect(remove.ok).toBe(true);

    const list2 = (await tool({ action: 'list' })) as any;
    expect(list2.todos).toEqual([]);
  });

  it('todo upsert validates missing id', async () => {
    registerGenericNodeTools(registry as any);
    const tool = registry.tools.get('todo')!;
    const res = await tool({ action: 'upsert', content: 'c' });
    expect(res).toMatchObject({ error: 'Missing id' });
  });

  it('summary truncates using maxLength bounds', async () => {
    registerGenericNodeTools(registry as any);
    const tool = registry.tools.get('summary')!;
    const input = 'x'.repeat(40);

    const res = (await tool({ text: input, maxLength: 10 })) as any;
    // maxLength is clamped to >= 32, so 40 => slice to 29 then "..."
    expect(res.summary).toBe('x'.repeat(29) + '...');
    expect(res.originalLength).toBe(40);
  });

  it('git defaults subcommand to status when missing', async () => {
    registerGenericNodeTools(registry as any);
    const git = registry.tools.get('git')!;
    const res = (await git({}) as any) ?? {};
    expect(res.subcommand).toBe('status');
    expect(res.isReadOnly).toBe(true);
  });

  it('todo supports unsupported action branch', async () => {
    registerGenericNodeTools(registry as any);
    const tool = registry.tools.get('todo')!;
    const res = (await tool({ action: 'noop' }) as any) ?? {};
    expect(res.error).toBe('Unsupported action');
  });

  it('summary returns original text when within maxLength', async () => {
    registerGenericNodeTools(registry as any);
    const tool = registry.tools.get('summary')!;
    const input = 'short text';
    const res = (await tool({ text: input, maxLength: 1000 }) as any) ?? {};
    expect(res.summary).toBe(input);
    expect(res.originalLength).toBe(input.length);
  });

  it('summary clamps maxLength upper bound (>=2000)', async () => {
    registerGenericNodeTools(registry as any);
    const tool = registry.tools.get('summary')!;
    const input = 'y'.repeat(3000);
    const res = (await tool({ text: input, maxLength: 5000 }) as any) ?? {};
    // maxLength is clamped to <= 2000, so slice to 1997 then "..."
    expect(res.summary).toBe('y'.repeat(1997) + '...');
    expect(res.originalLength).toBe(3000);
  });
});
