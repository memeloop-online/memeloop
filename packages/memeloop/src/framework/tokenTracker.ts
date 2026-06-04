/**
 * Token counting and auto-compaction trigger.
 * Tracks token usage per conversation and triggers compaction when approaching limits.
 *
 * Based on: Claude Code autoCompact + OpenCode autoCompact@95%
 */

/** Rough token estimation: ~4 chars per token (conservative) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Estimate token count for a messages array */
export function estimateMessagesTokens(messages: Array<{ content: unknown }>): number {
  let total = 0;
  for (const message of messages) {
    const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    total += estimateTokens(content);
  }
  return total;
}

export interface TokenTrackerConfig {
  /** Maximum context window in tokens (default: 200000) */
  contextWindow?: number;
  /** Trigger compaction when usage exceeds this fraction (default: 0.90) */
  compactionThreshold?: number;
  /** Buffer tokens reserved for output (default: 16000) */
  outputBuffer?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow: number;
  usagePercent: number;
  shouldCompact: boolean;
}

/**
 * Tracks token usage and decides when to trigger auto-compaction.
 */
export class TokenTracker {
  private promptTokens = 0;
  private completionTokens = 0;
  private readonly contextWindow: number;
  private readonly compactionThreshold: number;
  private readonly outputBuffer: number;
  private compacting = false;
  private consecutiveCompactionFailures = 0;
  private maxConsecutiveFailures = 3;

  constructor(config?: TokenTrackerConfig) {
    this.contextWindow = config?.contextWindow ?? 200_000;
    this.compactionThreshold = config?.compactionThreshold ?? 0.90;
    this.outputBuffer = config?.outputBuffer ?? 16_000;
  }

  /** Record token usage from an LLM response */
  recordUsage(promptTokens: number, completionTokens: number): void {
    this.promptTokens += promptTokens;
    this.completionTokens += completionTokens;
  }

  /** Manually set the prompt token count (e.g., from estimation) */
  setPromptTokens(tokens: number): void {
    this.promptTokens = tokens;
  }

  /** Get current usage */
  getUsage(): TokenUsage {
    const total = this.promptTokens + this.completionTokens;
    const effectiveWindow = this.contextWindow - this.outputBuffer;
    const usagePercent = total / effectiveWindow;
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: total,
      contextWindow: this.contextWindow,
      usagePercent: Math.min(usagePercent, 1.0),
      shouldCompact: usagePercent >= this.compactionThreshold && !this.compacting,
    };
  }

  /** Check if auto-compaction should be triggered */
  shouldTriggerCompaction(): boolean {
    if (this.consecutiveCompactionFailures >= this.maxConsecutiveFailures) return false;
    return this.getUsage().shouldCompact;
  }

  /** Mark that compaction is starting */
  markCompactionStart(): void {
    this.compacting = true;
  }

  /** Mark that compaction succeeded — reset token counts */
  markCompactionSuccess(estimatedPostTokens: number): void {
    this.compacting = false;
    this.promptTokens = estimatedPostTokens;
    this.completionTokens = 0;
    this.consecutiveCompactionFailures = 0;
  }

  /** Mark that compaction failed */
  markCompactionFailure(): void {
    this.compacting = false;
    this.consecutiveCompactionFailures++;
  }

  /** Reset all counters */
  reset(): void {
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.compacting = false;
    this.consecutiveCompactionFailures = 0;
  }

  /** Get a human-readable summary */
  formatUsage(): string {
    const usage = this.getUsage();
    const promptK = (usage.promptTokens / 1000).toFixed(1);
    const windowK = (usage.contextWindow / 1000).toFixed(0);
    const pct = (usage.usagePercent * 100).toFixed(1);
    return `${promptK}K/${windowK}K tokens (${pct}%)`;
  }
}

/** Interface for a compaction engine that can summarize conversation history */
export interface CompactionEngine {
  compact(messages: Array<{ role: string; content: unknown }>, conversationId: string): Promise<void>;
}

/**
 * Auto-compaction hook — call this after each LLM response.
 * Triggers compaction when token usage exceeds threshold.
 *
 * @returns true if compaction was triggered
 */
export async function maybeAutoCompact(
  tracker: TokenTracker,
  compactionEngine: CompactionEngine,
  messages: Array<{ role: string; content: unknown }>,
  conversationId: string,
): Promise<boolean> {
  if (!tracker.shouldTriggerCompaction()) return false;

  tracker.markCompactionStart();
  try {
    await compactionEngine.compact(messages, conversationId);
    const estimatedPost = estimateTokens('Summary of previous conversation context.');
    tracker.markCompactionSuccess(estimatedPost);
    return true;
  } catch {
    tracker.markCompactionFailure();
    return false;
  }
}
