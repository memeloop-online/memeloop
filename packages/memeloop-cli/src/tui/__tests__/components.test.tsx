/**
 * TUI component tests using ink-testing-library
 *
 * Tests render output, user input, and component state through
 * simulated terminal I/O (stdin/stdout).
 */
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ChatMessageList } from '../ChatMessageList.js';
import { StatusBar } from '../StatusBar.js';
import type { TUIMessage } from '../types.js';

// ---------------------------------------------------------------------------
// ChatMessageList
// ---------------------------------------------------------------------------
describe('ChatMessageList', () => {
  it('renders empty state with thinking indicator', () => {
    const { lastFrame } = render(
      <ChatMessageList messages={[]} thinking={true} />,
    );
    const output = lastFrame();
    expect(output).toBeDefined();
    expect(output).toContain('Thinking');
  });

  it('renders empty state without thinking', () => {
    const { lastFrame } = render(
      <ChatMessageList messages={[]} thinking={false} />,
    );
    expect(lastFrame()).toBeDefined();
  });

  it('renders user message', () => {
    const msgs: TUIMessage[] = [
      { messageId: '1', role: 'user', content: 'hello', timestamp: new Date() },
    ];
    const { lastFrame } = render(
      <ChatMessageList messages={msgs} thinking={false} />,
    );
    expect(lastFrame()).toContain('hello');
  });

  it('renders assistant message', () => {
    const msgs: TUIMessage[] = [
      { messageId: '2', role: 'assistant', content: 'Hi there!', timestamp: new Date() },
    ];
    const { lastFrame } = render(
      <ChatMessageList messages={msgs} thinking={false} />,
    );
    expect(lastFrame()).toContain('Hi there!');
  });

  it('renders tool call with toolName', () => {
    const msgs: TUIMessage[] = [
      {
        messageId: '3',
        role: 'tool',
        content: '',
        timestamp: new Date(),
        toolName: 'read_file',
        toolInput: { path: '/test.txt' },
      },
    ];
    const { lastFrame } = render(
      <ChatMessageList messages={msgs} thinking={false} />,
    );
    const output = lastFrame();
    expect(output).toContain('read_file');
    expect(output).toContain('/test.txt');
  });

  it('renders multiple messages', () => {
    const msgs: TUIMessage[] = [
      { messageId: 'u1', role: 'user', content: 'q', timestamp: new Date() },
      { messageId: 'a1', role: 'assistant', content: 'a', timestamp: new Date() },
      { messageId: 't1', role: 'tool', content: '', toolName: 'grep', toolInput: { pattern: 'foo' }, timestamp: new Date() },
    ];
    const { lastFrame } = render(
      <ChatMessageList messages={msgs} thinking={false} />,
    );
    expect(lastFrame()).toContain('q');
    expect(lastFrame()).toContain('a');
    expect(lastFrame()).toContain('grep');
  });

  it('renders thinking text when provided', () => {
    const msgs: TUIMessage[] = [
      { messageId: 'a', role: 'assistant', content: 'answer', timestamp: new Date(), thinking: 'Let me think about this...' },
    ];
    const { lastFrame } = render(
      <ChatMessageList messages={msgs} thinking={false} />,
    );
    expect(lastFrame()).toContain('think');
  });

  it('renders compaction and pending-tail markers without fake turn rows', () => {
    const msgs: TUIMessage[] = [{
      kind: 'compaction',
      messageId: 'compact-1',
      role: 'system',
      content: '',
      timestamp: new Date(1),
      compaction: {
        entryId: 'compact-1',
        summaryPreview: 'Earlier bounded summary',
        compactedMessageCount: 200,
        compactedTurnCount: 100,
      },
    }];
    const { lastFrame } = render(
      <ChatMessageList
        messages={msgs}
        thinking={false}
        hasMoreBefore={true}
        hasMoreAfter={true}
        pendingTailCount={3}
      />,
    );
    expect(lastFrame()).toContain('Compacted history');
    expect(lastFrame()).toContain('Earlier bounded summary');
    expect(lastFrame()).toContain('3 pending tail update');
    expect(lastFrame()).toContain('PageUp');
    expect(lastFrame()).toContain('PageDown');
  });
});

// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------
describe('StatusBar', () => {
  it('renders mode and status', () => {
    const { lastFrame } = render(
      <StatusBar text='Ready' mode='chat' messageCount={0} />,
    );
    const output = lastFrame();
    expect(output).toContain('MemeLoop CLI');
    expect(output).toContain('CHAT');
    expect(output).toContain('Ready');
  });

  it('shows message count', () => {
    const { lastFrame } = render(
      <StatusBar text='Running' mode='plan' messageCount={5} />,
    );
    expect(lastFrame()).toContain('5');
  });

  it('renders plan mode', () => {
    const { lastFrame } = render(
      <StatusBar text='Planning' mode='plan' messageCount={0} />,
    );
    expect(lastFrame()).toContain('PLAN');
  });

  it('renders autopilot mode', () => {
    const { lastFrame } = render(
      <StatusBar text='Auto' mode='autopilot' messageCount={0} />,
    );
    expect(lastFrame()).toContain('AUTOPILOT');
  });
});
