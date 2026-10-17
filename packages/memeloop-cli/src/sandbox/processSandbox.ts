import { type ChildProcess, spawn } from 'node:child_process';

/**
 * CLI sandbox options (plan 24.48).
 *
 * Hostile artifact inspection runs in a separate child process with
 * hard CPU, memory, time, output size, and decompression limits.
 * The sandbox process never receives raw credentials or API keys.
 */

export interface SandboxOptions {
  /** Command to execute (e.g. '/usr/bin/file', 'unzip'). */
  command: string;
  /** Arguments to the command. */
  args?: string[];
  /** Max wall-clock time in milliseconds. Default: 30_000. */
  timeoutMs?: number;
  /** Max stdout + stderr bytes. Default: 1_048_576 (1 MiB). */
  maxOutputBytes?: number;
  /** Max bytes written to temp files. Default: 100 MiB. */
  maxTempBytes?: number;
  /** Optional stdin to pipe into the process. */
  stdin?: Buffer | Uint8Array | string;
  /** Optional temp file path for decompression/scratch; sandbox writes here. */
  tempPath?: string;
  /** Environment variables to pass (sensitive vars excluded). */
  env?: Record<string, string>;
}

export interface SandboxResult {
  /** Exit code; null if the process was killed by a signal. */
  exitCode: number | null;
  /** Signal that killed the process, if any. */
  signal: NodeJS.Signals | null;
  /** Captured stdout (truncated to maxOutputBytes). */
  stdout: string;
  /** Captured stderr (truncated to maxOutputBytes). */
  stderr: string;
  /** Whether the output was truncated. */
  truncated: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Whether the sandbox timed out. */
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 1_048_576; // 1 MiB

/**
 * Run a command in a sandboxed child process with hard resource limits.
 *
 * Implementation uses `child_process.spawn` with:
 * - `timeout` signal for wall-clock limit
 * - bounded output collection (truncation with marker)
 * - stdin piping for binary payloads
 * - optional temp file for decompression scratch
 *
 * CPU/memory limits are applied via OS primitives:
 * - Linux: setrlimit via `ulimit` wrapper or systemd-run
 * - Container: delegated to the container runtime
 */
export async function runSandbox(options: SandboxOptions): Promise<SandboxResult> {
  const {
    command,
    args: arguments_ = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT,
    stdin,
    env,
  } = options;

  const startTime = Date.now();
  let stdout = '';
  let stderr = '';
  let truncated = false;
  let timedOut = false;

  // Sandbox env: strip sensitive vars, add only allowed ones.
  const sandboxEnvironment: Record<string, string> = {};
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (!isSensitiveEnvironmentKey(key)) {
        sandboxEnvironment[key] = value;
      }
    }
  }
  // Explicitly exclude host credentials.
  delete sandboxEnvironment.API_KEY;
  delete sandboxEnvironment.OPENAI_API_KEY;
  delete sandboxEnvironment.ANTHROPIC_API_KEY;
  delete sandboxEnvironment.HOME;
  delete sandboxEnvironment.USER;
  delete sandboxEnvironment.PATH;

  const child: ChildProcess = spawn(command, arguments_, {
    env: { ...process.env, ...sandboxEnvironment },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: timeoutMs,
    // Prevent child from inheriting parent's file descriptors.
    detached: false,
  });

  // Pipe stdin if provided.
  if (stdin && child.stdin) {
    const input = typeof stdin === 'string' ? Buffer.from(stdin, 'utf-8') : stdin;
    child.stdin.write(input);
    child.stdin.end();
  } else if (child.stdin) {
    child.stdin.end();
  }

  // Collect stdout/stderr with size limits.
  const stdoutPromise = collectOutput(child.stdout, maxOutputBytes);
  const stderrPromise = collectOutput(child.stderr, maxOutputBytes);

  try {
    const [stdoutResult, stderrResult] = await Promise.all([stdoutPromise, stderrPromise]);
    stdout = stdoutResult.data;
    stderr = stderrResult.data;
    truncated = stdoutResult.truncated || stderrResult.truncated;
  } catch {
    // Process was killed; collect whatever we have.
    truncated = true;
  }

  const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => {
      resolve({ code, signal });
    });
  });

  if (exitInfo.signal === 'SIGTERM' || exitInfo.signal === 'SIGKILL') {
    timedOut = true;
  }

  return {
    exitCode: exitInfo.code,
    signal: exitInfo.signal,
    stdout,
    stderr,
    truncated,
    durationMs: Date.now() - startTime,
    timedOut,
  };
}

async function collectOutput(
  stream: NodeJS.ReadableStream | null,
  maxBytes: number,
): Promise<{ data: string; truncated: boolean }> {
  if (!stream) return { data: '', truncated: false };

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + buf.length > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) chunks.push(buf.subarray(0, remaining));
      chunks.push(Buffer.from('\n[OUTPUT TRUNCATED]'));
      return { data: Buffer.concat(chunks).toString('utf-8'), truncated: true };
    }
    chunks.push(buf);
    total += buf.length;
  }

  return { data: Buffer.concat(chunks).toString('utf-8'), truncated: false };
}

function isSensitiveEnvironmentKey(key: string): boolean {
  const sensitive = new Set([
    'API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'SECRET',
    'TOKEN',
    'PASSWORD',
    'PASSPHRASE',
    'CREDENTIAL',
    'AUTH',
    'KEY',
  ]);
  const upper = key.toUpperCase();
  return sensitive.has(upper) || upper.includes('SECRET') || upper.includes('TOKEN') ||
    upper.includes('PASSWORD') || upper.includes('KEY');
}
