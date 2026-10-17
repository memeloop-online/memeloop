import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../terminal/sessionStorage', () => ({
  prepareTerminalSessionStorage: vi.fn().mockResolvedValue({ terminalCid: 'terminal:s1' }),
  wireTerminalOutputToStorage: vi.fn().mockReturnValue({
    persistQueue: Promise.resolve(),
    unsubOutput: vi.fn(),
  }),
}));

import { registerTerminalTools } from '../terminal.js';

class FakeRegistry {
  tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  registerTool(id: string, fn: (args: Record<string, unknown>) => Promise<unknown>): void {
    this.tools.set(id, fn);
  }
  registerOwnedTool(id: string, fn: (args: Record<string, unknown>) => Promise<unknown>): () => boolean {
    this.registerTool(id, fn);
    const registered = this.tools.get(id);
    return () => {
      if (this.tools.get(id) !== registered) return false;
      this.tools.delete(id);
      return true;
    };
  }
}

describe('terminal tools', () => {
  let registry: FakeRegistry;
  let manager: any;

  beforeEach(() => {
    registry = new FakeRegistry();
    manager = {
      start: vi.fn().mockResolvedValue({ sessionId: 's1' }),
      follow: vi.fn().mockResolvedValue({
        sessionId: 's1',
        status: 'exited',
        exitCode: 0,
        done: true,
        nextSeq: 2,
        chunks: [{ stream: 'stdout', data: 'ok', ts: Date.now(), seq: 1, sessionId: 's1' }],
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([{ sessionId: 's1', status: 'running' }]),
      respond: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockReturnValue({ sessionId: 's1', status: 'running' }),
      onStatusUpdate: vi.fn().mockReturnValue(() => {}),
    };
    registerTerminalTools(registry as any, manager);
  });

  it('registers expected terminal tools', () => {
    expect(registry.tools.has('terminal.execute')).toBe(true);
    expect(registry.tools.has('terminal.list')).toBe(true);
    expect(registry.tools.has('terminal.respond')).toBe(true);
    expect(registry.tools.has('terminal.follow')).toBe(true);
    expect(registry.tools.has('terminal.cancel')).toBe(true);
  });

  it('terminal.execute runs command and returns output', async () => {
    const res = (await registry.tools.get('terminal.execute')!({
      command: 'echo hello',
      waitMode: 'until-exit',
    })) as any;
    expect(manager.start).toHaveBeenCalled();
    expect(manager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'echo',
        args: ['hello'],
        env: undefined,
      }),
    );
    expect(manager.follow).toHaveBeenCalled();
    expect(res.stdout).toContain('ok');
  });

  it('terminal.execute prefers explicit args and env without splitting command', async () => {
    await registry.tools.get('terminal.execute')!({
      command: 'C:/Program Files/node.exe',
      args: ['-e', 'console.log(process.env.TEST_FLAG)'],
      env: { TEST_FLAG: '1' },
      waitMode: 'until-exit',
    });

    expect(manager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'C:/Program Files/node.exe',
        args: ['-e', 'console.log(process.env.TEST_FLAG)'],
        env: { TEST_FLAG: '1' },
      }),
    );
  });

  it('terminal.execute rejects invalid structured args/env', async () => {
    const badArgs = (await registry.tools.get('terminal.execute')!({
      command: 'node',
      args: ['-e', 1] as any,
    })) as any;
    expect(badArgs.error).toContain("Invalid 'args'");

    const badEnv = (await registry.tools.get('terminal.execute')!({
      command: 'node',
      env: { TEST_FLAG: 1 } as any,
    })) as any;
    expect(badEnv.error).toContain("Invalid 'env'");
  });

  it('terminal.execute validates command', async () => {
    const res = (await registry.tools.get('terminal.execute')!({})) as any;
    expect(res.error).toContain("Missing or invalid 'command'");
  });

  it('terminal.respond validates args and success path', async () => {
    const bad = (await registry.tools.get('terminal.respond')!({ sessionId: 's1' })) as any;
    expect(bad.error).toContain('Missing sessionId or input');
    const ok = (await registry.tools.get('terminal.respond')!({
      sessionId: 's1',
      input: 'y',
    })) as any;
    expect(ok.ok).toBe(true);
  });

  it('terminal.follow and cancel proxy to manager', async () => {
    const follow = (await registry.tools.get('terminal.follow')!({ sessionId: 's1' })) as any;
    expect(follow.done).toBe(true);
    const cancelled = (await registry.tools.get('terminal.cancel')!({ sessionId: 's1' })) as any;
    expect(cancelled.ok).toBe(true);
    expect(manager.cancel).toHaveBeenCalledWith('s1');
  });

  it('terminal.execute supports detached and timeout modes', async () => {
    manager.follow.mockResolvedValueOnce({
      sessionId: 's1',
      status: 'running',
      exitCode: null,
      done: false,
      nextSeq: 1,
      chunks: [],
    });

    const detached = (await registry.tools.get('terminal.execute')!({
      command: 'sleep 10',
      waitMode: 'detached',
    })) as any;
    expect(detached.done).toBe(false);
    expect(detached.sessionId).toBe('s1');

    const timeout = (await registry.tools.get('terminal.execute')!({
      command: 'sleep 10',
      waitMode: 'until-timeout',
      maxWaitMs: 1,
    })) as any;
    expect(timeout.timedOut).toBe(true);
    expect(manager.cancel).toHaveBeenCalledWith('s1');
  });

  it('terminal.execute wires storage output/unsub and returns chunks when stream=true', async () => {
    const localRegistry = new FakeRegistry();
    const unsubStatus = vi.fn();
    let capturedCb: any;

    const localManager: any = {
      start: vi.fn().mockResolvedValue({ sessionId: 's1' }),
      follow: vi.fn().mockResolvedValue({
        sessionId: 's1',
        status: 'exited',
        exitCode: 0,
        done: true,
        nextSeq: 2,
        chunks: [
          { stream: 'stdout', data: 'ok', ts: Date.now(), seq: 1, sessionId: 's1' },
          { stream: 'stderr', data: 'warn', ts: Date.now(), seq: 2, sessionId: 's1' },
        ],
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([{ sessionId: 's1', status: 'running' }]),
      respond: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockReturnValue({ sessionId: 's1', status: 'exited' }), // trigger info?.status !== "running"
      onStatusUpdate: vi.fn().mockImplementation((cb: any) => {
        capturedCb = cb;
        return unsubStatus;
      }),
    };

    // Re-register tools with storage option enabled.
    registerTerminalTools(localRegistry as any, localManager, {
      storage: {} as any,
      nodeId: 'node-x',
    });

    const res = (await localRegistry.tools.get('terminal.execute')!({
      command: 'echo hi',
      waitMode: 'until-exit',
      stream: true,
    })) as any;

    expect(res.chunks).toBeDefined();
    expect(res.stdout).toContain('ok');

    // Ensure callback branch `status.status !== \"running\"` is exercised.
    const callsBefore = unsubStatus.mock.calls.length;
    expect(capturedCb).toBeDefined();
    capturedCb({ sessionId: 's1', status: 'exited' });
    expect(unsubStatus.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('terminal.follow/cancel validate missing sessionId and respond error path', async () => {
    manager.respond.mockRejectedValueOnce(new Error('boom'));
    const followBad = (await registry.tools.get('terminal.follow')!({})) as any;
    expect(followBad.error).toContain('Missing sessionId');

    const cancelBad = (await registry.tools.get('terminal.cancel')!({})) as any;
    expect(cancelBad.error).toContain('Missing sessionId');

    const respondBad = (await registry.tools.get('terminal.respond')!({
      sessionId: 's1',
      input: 'x',
    })) as any;
    expect(respondBad.error).toContain('boom');
  });
});
