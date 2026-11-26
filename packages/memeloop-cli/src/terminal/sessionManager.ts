/**
 * ITerminalSessionManager: start/manage long-running commands, stream stdout/stderr,
 * stdin write, interaction detection (timeout + regex prompt), process lifecycle, session list.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { MemeLoopLogger } from 'memeloop';

import type { TerminalFollowResult, TerminalInteractionPrompt, TerminalOutputChunk, TerminalSessionInfo, TerminalSessionStatus } from './types.js';

export type TerminalSessionMode = 'await' | 'background' | 'interactive' | 'service';

export interface StartSessionOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Regex patterns to detect "prompt" (e.g. ">$ ", "Password:") for interaction detection */
  promptPatterns?: { name: string; regex: RegExp }[];
  /** If no output for this many ms, emit interaction prompt (optional) */
  idleTimeoutMs?: number;
  /** Plan §16.4.1 terminal.start modes (execute stays mode A). */
  mode?: TerminalSessionMode;
  parentConversationId?: string;
  label?: string;
  /**
   * When `mode === 'interactive'`, matched prompts call this (plan: bypass Agent, same as askQuestion).
   */
  askQuestion?: (question: string) => Promise<string>;
  /** Rolling buffer cap for `getOutputText` / await completion (default 100KB). */
  maxRollingChars?: number;
}

export interface ITerminalSessionManager {
  start(options: StartSessionOptions): Promise<{ sessionId: string }>;
  list(): Promise<TerminalSessionInfo[]>;
  get(sessionId: string): TerminalSessionInfo | undefined;
  respond(sessionId: string, input: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  signal(sessionId: string, signal: NodeJS.Signals): Promise<void>;
  /** Tail of rolling output buffer (plan §16.4 `terminal.getOutput`). */
  getOutputText(sessionId: string, options?: { tailLines?: number; tailChars?: number }): string;
  follow(
    sessionId: string,
    options?: { fromSeq?: number; untilExit?: boolean; maxWaitMs?: number },
  ): Promise<TerminalFollowResult>;
  /** Buffered output chunks for `memeloop.chat.pullTerminalSession` (in-memory sessions). */
  getChunksSince(sessionId: string, fromSeq?: number): TerminalOutputChunk[];
  onOutput(listener: (chunk: TerminalOutputChunk) => void): () => void;
  onStatusUpdate(listener: (update: { sessionId: string; status: TerminalSessionStatus; exitCode: number | null; ts: number }) => void): () => void;
  onInteractionPrompt(listener: (prompt: TerminalInteractionPrompt) => void): () => void;
  onSessionComplete(
    listener: (sessionId: string, info: TerminalSessionInfo, truncatedOutput: string) => void,
  ): () => void;
}

interface SessionState {
  sessionId: string;
  command: string;
  cwd: string;
  status: TerminalSessionStatus;
  exitCode: number | null;
  startedAt: number;
  exitedAt?: number;
  process: ChildProcess;
  idleTimer?: ReturnType<typeof setTimeout>;
  promptPatterns?: { name: string; regex: RegExp }[];
  idleTimeoutMs?: number;
  buffer: string;
  /** Full-output tail for getOutputText / await completion (plan §16.4). */
  rollingOutput: string;
  maxRollingChars: number;
  mode?: TerminalSessionMode;
  parentConversationId?: string;
  label?: string;
  chunks: TerminalOutputChunk[];
  nextSeq: number;
  cleanupInteractive?: () => void;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function isProcessGoneError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ESRCH' || (error instanceof Error && /already exited|not running/iu.test(error.message));
}

function isInteractiveCancellation(error: unknown): boolean {
  if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  return error instanceof Error && /cancel|abort|timeout/iu.test(error.message);
}

function appendRollingTail(current: string, add: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  const next = current + add;
  if (next.length <= maxChars) return next;
  return next.slice(next.length - maxChars);
}

export class TerminalSessionManager extends EventEmitter implements ITerminalSessionManager {
  private sessions = new Map<string, SessionState>();
  private outputListeners = new Set<(chunk: TerminalOutputChunk) => void>();
  private statusListeners = new Set<
    (update: { sessionId: string; status: TerminalSessionStatus; exitCode: number | null; ts: number }) => void
  >();
  private promptListeners = new Set<(prompt: TerminalInteractionPrompt) => void>();
  private sessionCompleteListeners = new Set<
    (sessionId: string, info: TerminalSessionInfo, truncatedOutput: string) => void
  >();
  private readonly maxChunksPerSession: number;

  private readonly logger?: Pick<MemeLoopLogger, 'warn'>;

  constructor(options?: { maxChunksPerSession?: number; logger?: Pick<MemeLoopLogger, 'warn'> }) {
    super();
    this.maxChunksPerSession = Math.max(2000, options?.maxChunksPerSession ?? 4000);
    this.logger = options?.logger;
  }

  async start(options: StartSessionOptions): Promise<{ sessionId: string }> {
    const sessionId = crypto.randomUUID();
    const cwd = options.cwd ?? process.cwd();
    const arguments_ = options.args ?? [];
    const environment = { ...process.env, ...options.env };
    const maxRolling = Math.max(4096, options.maxRollingChars ?? 100_000);

    const proc = spawn(options.command, arguments_, {
      cwd,
      env: environment,
      // Execute command directly; keep `options.command`/`options.args` semantics stable.
      // (Using `shell: true` makes `node -e <code>` subject to `/bin/sh` parsing.)
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const state: SessionState = {
      sessionId,
      command: [options.command, ...arguments_].join(' '),
      cwd,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      process: proc,
      promptPatterns: options.promptPatterns,
      idleTimeoutMs: options.mode === 'service' ? undefined : options.idleTimeoutMs,
      buffer: '',
      rollingOutput: '',
      maxRollingChars: maxRolling,
      mode: options.mode,
      parentConversationId: options.parentConversationId,
      label: options.label,
      chunks: [],
      nextSeq: 1,
    };
    this.sessions.set(sessionId, state);

    if (options.mode === 'interactive' && typeof options.askQuestion === 'function') {
      const aq = options.askQuestion;
      const off = this.onInteractionPrompt((pr) => {
        if (pr.sessionId !== sessionId) return;
        void (async () => {
          try {
            const line = await aq(`终端 [${sessionId}] 等待输入:\n${pr.promptText}`);
            await this.respond(sessionId, line);
          } catch (error) {
            if (!isInteractiveCancellation(error)) {
              this.logger?.warn?.(`interactive terminal input failed for session '${sessionId}'`, error);
            }
          }
        })();
      });
      state.cleanupInteractive = off;
    }

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.pushOutput(sessionId, 'stdout', text, state);
    });
    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.pushOutput(sessionId, 'stderr', text, state);
    });

    proc.on('exit', (code, signal) => {
      const s = this.sessions.get(sessionId);
      if (!s) return;
      s.status = signal ? 'killed' : 'exited';
      s.exitCode = code;
      s.exitedAt = Date.now();
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.cleanupInteractive?.();
      s.cleanupInteractive = undefined;
      const out = this.truncateOutput(s.rollingOutput, 8000);
      for (const function_ of this.sessionCompleteListeners) {
        try {
          function_(sessionId, this.toInfo(s), out);
        } catch (error) {
          this.logger?.warn?.(`terminal completion listener failed for session '${sessionId}'`, error);
        }
      }
      this.emitStatusUpdate(sessionId, s.status, s.exitCode);
    });
    proc.on('error', () => {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.status = 'failed';
        s.cleanupInteractive?.();
        s.cleanupInteractive = undefined;
        const out = this.truncateOutput(s.rollingOutput, 8000);
        for (const function_ of this.sessionCompleteListeners) {
          try {
            function_(sessionId, this.toInfo(s), out);
          } catch (error) {
            this.logger?.warn?.(`terminal completion listener failed for session '${sessionId}'`, error);
          }
        }
        this.emitStatusUpdate(sessionId, s.status, s.exitCode);
      }
    });

    if (options.idleTimeoutMs) {
      this.scheduleIdlePrompt(sessionId, state);
    }

    return { sessionId };
  }

  private pushOutput(
    sessionId: string,
    stream: 'stdout' | 'stderr',
    text: string,
    state: SessionState,
  ): void {
    const seq = state.nextSeq++;
    const ts = Date.now();
    const chunk: TerminalOutputChunk = { sessionId, seq, stream, data: text, ts };
    state.chunks.push(chunk);
    if (state.chunks.length > this.maxChunksPerSession) {
      state.chunks.splice(0, state.chunks.length - this.maxChunksPerSession);
    }
    for (const function_ of this.outputListeners) function_(chunk);

    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }

    state.buffer += text;
    state.rollingOutput = appendRollingTail(state.rollingOutput, text, state.maxRollingChars);
    if (state.promptPatterns?.length) {
      for (const { name, regex } of state.promptPatterns) {
        if (regex.test(state.buffer)) {
          const prompt: TerminalInteractionPrompt = {
            sessionId,
            promptText: state.buffer.slice(-200),
            patternName: name,
            timestamp: ts,
          };
          for (const function_ of this.promptListeners) function_(prompt);
          state.buffer = '';
          break;
        }
      }
    }

    if (state.idleTimeoutMs) {
      this.scheduleIdlePrompt(sessionId, state);
    }
  }

  private scheduleIdlePrompt(sessionId: string, state: SessionState): void {
    if (state.status !== 'running' || !state.idleTimeoutMs) return;
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined;
      const prompt: TerminalInteractionPrompt = {
        sessionId,
        promptText: state.buffer || '(no output yet)',
        timestamp: Date.now(),
      };
      for (const function_ of this.promptListeners) function_(prompt);
    }, state.idleTimeoutMs);
  }

  async list(): Promise<TerminalSessionInfo[]> {
    return Array.from(this.sessions.values()).map((s) => this.toInfo(s));
  }

  get(sessionId: string): TerminalSessionInfo | undefined {
    const s = this.sessions.get(sessionId);
    return s ? this.toInfo(s) : undefined;
  }

  getChunksSince(sessionId: string, fromSeq = 1): TerminalOutputChunk[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return s.chunks.filter((c) => c.seq >= fromSeq);
  }

  private truncateOutput(s: string, max: number): string {
    if (s.length <= max) return s;
    const head = 1500;
    const tail = max - head - 40;
    return `${s.slice(0, head)}\n[... truncated ${s.length - head - tail} chars ...]\n${s.slice(s.length - tail)}`;
  }

  private toInfo(s: SessionState): TerminalSessionInfo {
    return {
      sessionId: s.sessionId,
      command: s.command,
      cwd: s.cwd,
      status: s.status,
      exitCode: s.exitCode,
      startedAt: s.startedAt,
      exitedAt: s.exitedAt,
    };
  }

  getOutputText(sessionId: string, options?: { tailLines?: number; tailChars?: number }): string {
    const s = this.sessions.get(sessionId);
    if (!s) return '';
    let t = s.rollingOutput;
    const tailChars = options?.tailChars;
    if (typeof tailChars === 'number' && tailChars > 0 && t.length > tailChars) {
      t = t.slice(-tailChars);
    }
    const tailLines = options?.tailLines;
    if (typeof tailLines === 'number' && tailLines > 0) {
      const lines = t.split('\n');
      t = lines.slice(-tailLines).join('\n');
    }
    return t;
  }

  async signal(sessionId: string, sig: NodeJS.Signals): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.status !== 'running') return;
    try {
      s.process.kill(sig);
    } catch (error) {
      if (!isProcessGoneError(error)) {
        this.logger?.warn?.(`terminal signal '${sig}' failed for session '${sessionId}'`, error);
        throw error;
      }
    }
  }

  async respond(sessionId: string, input: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session not found: ${sessionId}`);
    if (s.status !== 'running' || !s.process.stdin?.writable) {
      throw new Error(`Session not writable: ${sessionId}`);
    }
    s.process.stdin.write(input + '\n');
  }

  async cancel(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.idleTimer) {
      clearTimeout(s.idleTimer);
      s.idleTimer = undefined;
    }
    s.cleanupInteractive?.();
    s.cleanupInteractive = undefined;
    try {
      s.process.kill('SIGTERM');
    } catch (error) {
      if (!isProcessGoneError(error)) {
        this.logger?.warn?.(`terminal cancellation failed for session '${sessionId}'`, error);
        throw error;
      }
    }
    s.status = 'killed';
    s.exitedAt = Date.now();
    this.emitStatusUpdate(sessionId, s.status, s.exitCode);
  }

  async follow(
    sessionId: string,
    options?: { fromSeq?: number; untilExit?: boolean; maxWaitMs?: number },
  ): Promise<TerminalFollowResult> {
    const fromSeq = Math.max(1, options?.fromSeq ?? 1);
    const untilExit = options?.untilExit === true;
    const maxWaitMs = options?.maxWaitMs ?? 30_000;
    const maxUntil = maxWaitMs > 0 ? Date.now() + maxWaitMs : Number.POSITIVE_INFINITY;

    while (true) {
      const state = this.sessions.get(sessionId);
      if (!state) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const chunks = state.chunks.filter((chunk) => chunk.seq >= fromSeq);
      const done = state.status !== 'running';
      const timedOut = Date.now() >= maxUntil;
      const shouldReturn = untilExit ? done || timedOut : done || chunks.length > 0 || timedOut;
      if (shouldReturn) {
        return {
          sessionId,
          status: state.status,
          exitCode: state.exitCode,
          nextSeq: state.nextSeq,
          done,
          chunks,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  onOutput(listener: (chunk: TerminalOutputChunk) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onStatusUpdate(
    listener: (update: { sessionId: string; status: TerminalSessionStatus; exitCode: number | null; ts: number }) => void,
  ): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onInteractionPrompt(listener: (prompt: TerminalInteractionPrompt) => void): () => void {
    this.promptListeners.add(listener);
    return () => this.promptListeners.delete(listener);
  }

  onSessionComplete(
    listener: (sessionId: string, info: TerminalSessionInfo, truncatedOutput: string) => void,
  ): () => void {
    this.sessionCompleteListeners.add(listener);
    return () => this.sessionCompleteListeners.delete(listener);
  }

  private emitStatusUpdate(sessionId: string, status: TerminalSessionStatus, exitCode: number | null): void {
    const payload = { sessionId, status, exitCode, ts: Date.now() };
    for (const function_ of this.statusListeners) function_(payload);
  }
}
