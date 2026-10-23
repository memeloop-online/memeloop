import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ConversationMessageListProjection } from 'memeloop';
import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentChatView } from '../agent/AgentChatView.js';
import { buildWorkDisclosure } from '../chat/thread/workDisclosureModel.js';
import type { MemeLoopChatAdapter } from '../chat/types.js';

function message(
  id: string,
  role: ConversationMessageListProjection['role'],
  content: string,
  extra: Partial<ConversationMessageListProjection> = {},
): ConversationMessageListProjection {
  return { messageId: id, turnId: 'user', conversationId: 'conversation', originNodeId: 'node', originSequence: 1, timestamp: 1, lamportClock: 1, role, content, ...extra };
}
const user = message('user', 'user', 'Find the answer');
const process = message('process', 'assistant', 'I will inspect the wiki.');
const tool = (id: string) => message(id, 'tool', `Result ${id}`, { metadata: { toolActivity: [{ kind: 'result', name: 'wiki-search', callId: id, input: '{"query":"test"}' }] } });
const final = message('final', 'assistant', 'Here is the final answer.');
const messages = [user, process, tool('a'), tool('b'), final];
const tree = (rows: readonly ConversationMessageListProjection[], running = false, more = false) =>
  buildWorkDisclosure(rows.map((value, index) => ({ message: value, index })), { isRunning: running, hasMoreAfter: more });
const adapter = (running = false, rows = messages): MemeLoopChatAdapter => ({
  conversationId: 'conversation',
  messages: rows,
  isRunning: running,
  isLoading: false,
  error: null,
  sendMessage: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  deleteTurn: vi.fn(async () => {}),
  retryTurn: vi.fn(async () => {}),
});

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
});
afterAll(() => vi.unstubAllGlobals());

describe('work disclosure', () => {
  it('folds process through the last tool, keeping all trailing summaries visible', () => {
    const result = tree([...messages, message('final2', 'assistant', 'More conclusions')]);
    expect(result.map(node => node.kind)).toEqual(['message', 'work', 'message', 'message']);
    expect(result[1]).toMatchObject({ steps: 2, children: [{ kind: 'message' }, { kind: 'tools', steps: 2 }] });
  });

  it('does not wrap a single tool or plain text conversation in a tool group', () => {
    expect(tree([user, tool('a'), final])[1]).toMatchObject({ kind: 'work', children: [{ kind: 'message' }] });
    expect(tree([user, final]).map(node => node.kind)).toEqual(['message', 'message']);
  });

  it('keeps live and clipped turns unfolded', () => {
    expect(tree(messages, true).some(node => node.kind === 'work')).toBe(false);
    expect(tree(messages, false, true).some(node => node.kind === 'work')).toBe(false);
    expect(tree(messages.slice(1)).some(node => node.kind === 'work')).toBe(false);
  });

  it('counts command/result pairs once and separates groups at commentary', () => {
    const call = message('call', 'assistant', '', { metadata: { toolActivity: [{ kind: 'call', name: 'wiki-search', callId: 'a' }] } });
    expect(tree([user, call, tool('a'), final])[1]).toMatchObject({ steps: 1 });
    expect(tree([user, tool('a'), process, tool('b')], true).every(node => node.kind === 'message')).toBe(true);
    const agent = { ...call, role: 'agent' as const, content: 'Inspecting the wiki' };
    expect(tree([user, agent, tool('a'), tool('b')], true)[1]).toMatchObject({ kind: 'message', row: { message: agent } });
  });

  it('does not conceal unanswered questions or errors', () => {
    const question = message('question', 'tool', '', { presentations: [{ kind: 'tool-result', toolName: 'ask-question', detailAvailable: false }] });
    expect(tree([user, tool('a'), question]).every(node => node.kind === 'message')).toBe(true);
    const failed = message('failed', 'tool', 'Failed', { metadata: { toolActivity: [{ kind: 'result', name: 'wiki-search', isError: true }] } });
    expect(tree([user, failed]).every(node => node.kind === 'message')).toBe(true);
    expect(tree([user, message('legacy-error', 'tool', 'Failed', { metadata: { isError: true } })]).every(node => node.kind === 'message')).toBe(true);
  });

  it('reveals all nested layers when the timeline targets a hidden tool call', async () => {
    const call = message('call', 'assistant', '', { metadata: { toolActivity: [{ kind: 'call', name: 'wiki-search', callId: 'b', input: '{"query":"second"}' }] } });
    const rows = [user, process, tool('a'), call, tool('b'), final];
    const items = rows.filter(row => row.role === 'user' || row.role === 'assistant').map((row, index) => ({
      kind: 'message' as const,
      entryId: row.messageId,
      messageId: row.messageId,
      turnId: row.turnId,
      conversationId: row.conversationId,
      cursor: row.messageId,
      timestamp: 1,
      lamportClock: 1,
      originNodeId: 'node',
      entryIndex: index,
      turnIndex: 0,
      role: row.role as 'user' | 'assistant',
      actorId: row.role,
      actorLabel: row.role,
      preview: row.content,
    }));
    const view = render(
      <AgentChatView
        adapter={{
          ...adapter(false, rows),
          timeline: { reset: false, revision: 'r', items, totalMessages: items.length, totalTurns: 1, totalEntries: items.length, hasMoreBefore: false, hasMoreAfter: false },
        }}
      />,
    );
    const work = screen.getByTestId('work-disclosure');
    expect(work).not.toHaveAttribute('open');
    fireEvent.click(view.container.querySelector('[data-timeline-message-id="call"]')!);
    await waitFor(() => {
      expect(work).toHaveAttribute('open');
      expect(screen.getByTestId('tool-group-disclosure')).toHaveAttribute('open');
      expect(document.activeElement).toHaveAttribute('data-memeloop-message-id', 'call');
    });
    expect(screen.getAllByTestId('tool-disclosure')[1]).toHaveAttribute('open');
    expect(screen.getByText('{"query":"second"}')).toBeVisible();
  });

  it('transitions from live tools to collapsed work and supports all disclosure layers', () => {
    const view = render(<AgentChatView adapter={adapter(true)} />);
    expect(screen.queryByTestId('work-disclosure')).toBeNull();
    expect(screen.getByTestId('assistant-run-status')).toBeVisible();
    expect(screen.getByTestId('tool-group-disclosure')).not.toHaveAttribute('open');
    view.rerender(<AgentChatView adapter={adapter()} />);
    const work = screen.getByTestId('work-disclosure');
    expect(work).not.toHaveAttribute('open');
    expect(screen.getByText(final.content)).toBeVisible();
    fireEvent.click(within(work).getByText('Worked 2 steps'));
    expect(work).toHaveAttribute('open');
    const group = within(work).getByTestId('tool-group-disclosure');
    expect(group).not.toHaveAttribute('open');
    fireEvent.click(within(group).getByText('2 tool calls'));
    expect(group).toHaveAttribute('open');
    const individual = within(group).getAllByTestId('tool-disclosure')[0];
    expect(individual).not.toHaveAttribute('open');
    fireEvent.click(individual.querySelector('summary')!);
    expect(individual).toHaveAttribute('open');
    expect(within(individual).getByText('{"query":"test"}')).toBeVisible();
    expect(within(individual).getByText('Result a')).toBeVisible();
  });
});
