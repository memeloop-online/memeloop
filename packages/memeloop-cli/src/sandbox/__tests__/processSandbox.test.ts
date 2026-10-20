import { describe, expect, it, vi } from 'vitest';
import { runSandbox } from '../processSandbox.js';

describe('runSandbox', () => {
  it('runs echo and captures stdout', async () => {
    const result = await runSandbox({ command: process.execPath, args: ['-e', 'console.log("hello world")'] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello world');
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('rejects an unavailable executable without an unhandled process error or waiting for timeout', async () => {
    await expect(runSandbox({ command: 'memeloop-nonexistent-executable-for-test' }))
      .rejects.toMatchObject({ code: 'ENOENT' });
  }, 5000);

  it('captures stderr from failing command', async () => {
    const result = await runSandbox({
      command: process.execPath,
      args: ['-e', 'console.error("bad thing happened")'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('bad thing happened');
  });

  it('reports non-zero exit code', async () => {
    const result = await runSandbox({
      command: process.execPath,
      args: ['-e', 'process.exit(42)'],
    });

    expect(result.exitCode).toBe(42);
  });

  it('times out a hanging process', async () => {
    const result = await runSandbox({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      timeoutMs: 500,
    });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGTERM');
  }, 5000);

  it('pipes stdin to the process', async () => {
    const result = await runSandbox({
      command: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      stdin: 'hello from stdin',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello from stdin');
  });

  it('truncates oversized output', async () => {
    const result = await runSandbox({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(2000))'],
      maxOutputBytes: 100,
    });

    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain('[OUTPUT TRUNCATED]');
    expect(result.stdout.length).toBeLessThanOrEqual(150); // 100 bytes + truncation marker
  });

  it('strips sensitive env keys', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'memeloop-test-sentinel-not-a-secret');
    try {
      const result = await runSandbox({
        command: process.execPath,
        args: ['-e', 'console.log(process.env.OPENAI_API_KEY || "stripped")'],
        env: { OTHER_API_KEY: 'second-test-sentinel' },
      });
      expect(result.stdout.trim()).toBe('stripped');
      expect(result.stdout).not.toContain('sentinel');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
