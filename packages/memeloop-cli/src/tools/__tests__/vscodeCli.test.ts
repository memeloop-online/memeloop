import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

class FakeRegistry {
  tools = new Map<string, (args: Record<string, unknown>) => unknown>();
  registerTool(id: string, impl: (args: Record<string, unknown>) => unknown): void {
    this.tools.set(id, impl);
  }
}

vi.mock('node:child_process', () => ({
  spawn: (..._args: any[]) => {
    const makeProc = (opts: {
      stdout?: string;
      stderr?: string;
      code?: number | null;
      emitError?: boolean;
    }) => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      proc.stdout = stdout;
      proc.stderr = stderr;
      proc.kill = vi.fn();

      queueMicrotask(() => {
        if (opts.stdout) stdout.emit('data', opts.stdout);
        if (opts.stderr) stderr.emit('data', opts.stderr);
        if (opts.emitError) {
          proc.emit('error', new Error('spawn failed'));
          return;
        }
        proc.emit('close', opts.code ?? 0);
      });

      return proc;
    };

    const args = _args?.[1] as string[] | undefined;
    const listExt = args?.includes('--list-extensions');
    return makeProc(
      listExt
        ? { stdout: 'ext.one\next.two\n', stderr: '', code: 0 }
        : { stdout: 'OK', stderr: '', code: 0 },
    );
  },
}));

import { registerVscodeTools } from '../vscodeCli.js';

describe('vscodeCli', () => {
  it('returns errors on missing required args', async () => {
    const registry = new FakeRegistry();
    registerVscodeTools(registry as any);

    const open = registry.tools.get('vscode.open')!;
    const res1 = await open({} as any);
    expect(res1).toMatchObject({ error: expect.stringContaining("Missing 'path'") });

    const runCli = registry.tools.get('vscode.runCli')!;
    const res2 = await runCli({ command: '' } as any);
    expect(res2).toMatchObject({ error: expect.stringContaining("Missing 'command'") });
  });

  it('covers open/openFolder argument validation and happy paths', async () => {
    const registry = new FakeRegistry();
    registerVscodeTools(registry as any);

    const open = registry.tools.get('vscode.open')!;
    const openFolder = registry.tools.get('vscode.openFolder')!;

    const errFolder = await openFolder({} as any);
    expect(errFolder).toMatchObject({ error: expect.stringContaining('projects/myapp') });

    const okOpen = (await open({ path: '/tmp/a.ts' } as any)) as any;
    expect(okOpen).toMatchObject({ path: '/tmp/a.ts', stdout: 'OK', code: 0 });

    const okFolder = (await openFolder({ path: '/tmp/proj' } as any)) as any;
    expect(okFolder).toMatchObject({ path: '/tmp/proj', stdout: 'OK', code: 0 });
  });

  it('covers vscode.runCli default args handling', async () => {
    const registry = new FakeRegistry();
    registerVscodeTools(registry as any);

    const runCli = registry.tools.get('vscode.runCli')!;
    const res = (await runCli({ command: 'workbench.action.problems.focus' } as any)) as any;
    expect(res).toMatchObject({ command: 'workbench.action.problems.focus', stdout: 'OK', code: 0 });
  });

  it('parses stdout for listExtensions', async () => {
    const registry = new FakeRegistry();
    registerVscodeTools(registry as any);

    const listExt = registry.tools.get('vscode.listExtensions')!;
    const res = (await listExt({} as any)) as any;
    expect(res.extensions).toEqual(['ext.one', 'ext.two']);
    expect(res.ok).toBeUndefined(); // runCode doesn't set ok field
    expect(res.code).toBe(0);
  });
});
