import { describe, expect, it } from 'vitest';

import { TextMessageRenderer } from '../textRenderer.js';

describe('TextMessageRenderer', () => {
  it('hides thinking by default', () => {
    const r = new TextMessageRenderer();
    expect(r.renderThinking('some hidden content')).toBeNull();
  });

  it('renders askQuestion with numbered options', () => {
    const r = new TextMessageRenderer();
    const s = r.renderAskQuestion('choose one', ['a', 'b']);
    expect(s).toContain('❓ choose one');
    expect(s).toContain('1. a');
    expect(s).toContain('2. b');
  });

  it('renders tool result summary as a compact one-liner', () => {
    const r = new TextMessageRenderer();
    const s = r.renderToolResultSummary('terminal.execute', { ok: true, stdout: 'x'.repeat(5000) });
    expect(s).toContain('✅ terminal.execute:');
    // Should not inline a giant JSON body.
    expect(s.length).toBeLessThan(250);
  });

  it('renders tool result summary for null', () => {
    const r = new TextMessageRenderer();
    expect(r.renderToolResultSummary('toolX', null)).toBe('✅ toolX: done');
  });
});
