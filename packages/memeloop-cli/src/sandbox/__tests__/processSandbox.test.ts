import { describe, expect, it } from 'vitest';
import { runSandbox } from '../processSandbox.js';

describe('runSandbox', () => {
  it('runs echo and captures stdout', async () => {
    const result = await runSandbox({ command: 'echo', args: ['hello world'] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello world');
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('captures stderr from failing command', async () => {
    const result = await runSandbox({
      command: 'node',
      args: ['-e', 'console.error("bad thing happened")'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('bad thing happened');
  });

  it('reports non-zero exit code', async () => {
    const result = await runSandbox({
      command: 'node',
      args: ['-e', 'process.exit(42)'],
    });

    expect(result.exitCode).toBe(42);
  });

  it('times out a hanging process', async () => {
    const result = await runSandbox({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      timeoutMs: 500,
    });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGTERM');
  }, 5000);

  it('pipes stdin to the process', async () => {
    const result = await runSandbox({
      command: 'node',
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      stdin: 'hello from stdin',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello from stdin');
  });

  it('truncates oversized output', async () => {
    const result = await runSandbox({
      command: 'node',
      args: ['-e', 'process.stdout.write("x".repeat(2000))'],
      maxOutputBytes: 100,
    });

    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain('[OUTPUT TRUNCATED]');
    expect(result.stdout.length).toBeLessThanOrEqual(150); // 100 bytes + truncation marker
  });

  it('strips sensitive env keys', async () => {
    const result = await runSandbox({
      command: 'node',
      args: ['-e', 'console.log(process.env.OPENAI_API_KEY || "stripped")'],
    });

    expect(result.stdout).toContain('stripped');
    expect(result.stdout).not.toContain('sk-');
  });
});
