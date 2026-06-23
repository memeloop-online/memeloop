/**
 * Bash/Shell execution tool — the most critical tool for a programming agent.
 * Supports timeout, working directory, and output truncation.
 *
 * Based on: Claude Code BashTool + OpenCode bash tool
 */
import { execFile } from 'node:child_process';
import { z } from 'zod';

export const BASH_TOOL_ID = 'bash' as const;

// ─── Safety ───────────────────────────────────────────────────────────────────
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f|\/)/, // rm -f or rm /
  /\bmkfs\b/, // format filesystem
  /\bdd\s+/, // dd command
  /\b:(){ :\|:& };:/, // fork bomb
  /\bchmod\s+(-R\s+)?777\b/, // chmod 777
  />\s*\/dev\/sd[a-z]/, // write to raw disk
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+0\b/,
];

const MAX_OUTPUT_LENGTH = 30_000; // characters — matches OpenCode
const DEFAULT_TIMEOUT = 120_000; // 2 minutes

// ─── Schema ───────────────────────────────────────────────────────────────────
export const bashSchema = z.object({
  command: z.string().describe('The bash command to execute'),
  timeout: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe('Timeout in milliseconds (max 600s, default 120s)'),
  cwd: z.string().optional().describe('Working directory for the command'),
});

type BashArguments = z.infer<typeof bashSchema>;

// ─── Implementation ───────────────────────────────────────────────────────────
function checkDangerous(command: string): string | null {
  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(command)) {
      return `Command matches dangerous pattern: ${pat.source}`;
    }
  }
  return null;
}

function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return text.slice(0, half) + '\n\n... [truncated] ...\n\n' + text.slice(-half);
}

async function execBash(
  command: string,
  timeout: number,
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    let timedOut = false;
    void ChildProcess;

    const proc = execFile(
      '/bin/bash',
      ['-c', command],
      {
        cwd: cwd ?? process.cwd(),
        timeout: 0, // we manage our own timeout
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        env: { ...process.env, TERM: 'dumb' },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: error && 'code' in error ? (error.code as number) : (error ? 1 : 0),
          timedOut,
        });
      },
    );

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeout);
  });
}

// ─── Tool Definition ──────────────────────────────────────────────────────────
export const bashTool = {
  id: BASH_TOOL_ID,
  name: 'Bash',
  description: 'Execute a bash command and return its output.',
  parameters: bashSchema,
  category: 'system',
  isReadOnly: () => false,

  async execute(arguments_: BashArguments) {
    const { command, timeout = DEFAULT_TIMEOUT, cwd } = arguments_;

    // Safety check
    const danger = checkDangerous(command);
    if (danger) {
      return {
        output: `⚠️  Blocked dangerous command: ${danger}\nCommand: ${command}`,
        metadata: { blocked: true, reason: danger },
      };
    }

    const startTime = Date.now();
    const result = await execBash(command, timeout, cwd);
    const elapsed = Date.now() - startTime;

    const parts: string[] = [];

    if (result.stdout) {
      parts.push(truncateOutput(result.stdout.trimEnd(), MAX_OUTPUT_LENGTH));
    }
    if (result.stderr) {
      parts.push(`[stderr]\n${truncateOutput(result.stderr.trimEnd(), MAX_OUTPUT_LENGTH)}`);
    }
    if (result.timedOut) {
      parts.push(`\n⏱️ Command timed out after ${timeout}ms`);
    }
    if (result.exitCode !== 0 && !result.timedOut) {
      parts.push(`\n[exit code: ${result.exitCode}]`);
    }

    const output = parts.join('\n') || '(no output)';

    return {
      output,
      metadata: {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        elapsed,
        cwd: cwd ?? process.cwd(),
      },
    };
  },
};

/**
 * Functional wrapper for registry compatibility.
 */
export async function bashImpl(
  arguments_: Record<string, unknown>,
  context: BuiltinToolContext,
): Promise<{ output: string; metadata?: Record<string, unknown> }> {
  return bashTool.execute(arguments_ as BashArguments, context);
}
