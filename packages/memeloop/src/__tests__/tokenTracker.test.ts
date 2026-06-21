import { describe, expect, it } from 'vitest';
import { estimateMessagesTokens, estimateTokens, TokenTracker } from '../loopAPI/tokenTracker.js';

describe('TokenTracker', () => {
  it('tracks token usage', () => {
    const tracker = new TokenTracker({ contextWindow: 1000 });
    tracker.recordUsage(500, 200);
    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(500);
    expect(usage.completionTokens).toBe(200);
    expect(usage.totalTokens).toBe(700);
  });

  it('calculates usage percent', () => {
    const tracker = new TokenTracker({ contextWindow: 1000, outputBuffer: 100 });
    tracker.recordUsage(800, 50);
    const usage = tracker.getUsage();
    // effective window = 1000 - 100 = 900, usage = 850/900 = 94.4%
    expect(usage.usagePercent).toBeCloseTo(850 / 900, 2);
  });

  it('triggers compaction when threshold exceeded', () => {
    const tracker = new TokenTracker({
      contextWindow: 1000,
      compactionThreshold: 0.9,
      outputBuffer: 100,
    });
    // Below threshold
    tracker.recordUsage(700, 50);
    expect(tracker.shouldTriggerCompaction()).toBe(false);

    // Above threshold
    tracker.recordUsage(200, 50);
    expect(tracker.shouldTriggerCompaction()).toBe(true);
  });

  it('stops triggering after max consecutive failures', () => {
    const tracker = new TokenTracker({ contextWindow: 100000, outputBuffer: 1000 });
    tracker.recordUsage(200000, 0);

    // First failure
    tracker.markCompactionStart();
    tracker.markCompactionFailure();
    expect(tracker.shouldTriggerCompaction()).toBe(true);

    // Second failure
    tracker.markCompactionStart();
    tracker.markCompactionFailure();
    expect(tracker.shouldTriggerCompaction()).toBe(true);

    // Third failure — should stop
    tracker.markCompactionStart();
    tracker.markCompactionFailure();
    expect(tracker.shouldTriggerCompaction()).toBe(false);
  });

  it('resets token counts after successful compaction', () => {
    const tracker = new TokenTracker({ contextWindow: 100 });
    tracker.recordUsage(200, 0);
    tracker.markCompactionStart();
    tracker.markCompactionSuccess(50);

    const usage = tracker.getUsage();
    expect(usage.promptTokens).toBe(50);
    expect(usage.completionTokens).toBe(0);
  });

  it('formats usage summary', () => {
    const tracker = new TokenTracker({ contextWindow: 200000 });
    tracker.recordUsage(50000, 10000);
    const summary = tracker.formatUsage();
    expect(summary).toContain('50.0K');
    expect(summary).toContain('200K');
    expect(summary).toContain('32.6%');
  });

  it('does not trigger compaction while compacting', () => {
    const tracker = new TokenTracker({ contextWindow: 100000, outputBuffer: 1000 });
    tracker.recordUsage(200000, 0);
    tracker.markCompactionStart();
    // Already compacting — should not retrigger
    expect(tracker.shouldTriggerCompaction()).toBe(false);
  });

  it('resets everything', () => {
    const tracker = new TokenTracker({ contextWindow: 100 });
    tracker.recordUsage(200, 100);
    tracker.reset();
    const usage = tracker.getUsage();
    expect(usage.totalTokens).toBe(0);
  });
});

describe('estimateTokens', () => {
  it('estimates roughly 1 token per 3.5 chars', () => {
    expect(estimateTokens('hello')).toBe(2); // 5/3.5 = 1.4 → 2
    expect(estimateTokens('a'.repeat(35))).toBe(10); // 35/3.5 = 10
  });

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('estimateMessagesTokens', () => {
  it('sums token estimates across messages', () => {
    const msgs = [
      { content: 'hello' }, // ~2 tokens
      { content: 'world test' }, // ~3 tokens
    ];
    const total = estimateMessagesTokens(msgs);
    expect(total).toBeGreaterThan(0);
  });

  it('handles non-string content', () => {
    const msgs = [{ content: { key: 'value' } }];
    expect(() => estimateMessagesTokens(msgs)).not.toThrow();
  });
});
