import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { PromptPreviewAuditDetailChunk, PromptPreviewAuditEntrySummary, PromptPreviewPreparedExecution } from 'memeloop';
import { PromptPreviewAuditSessionStore } from 'memeloop';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { buildPromptInspectionTree, type PromptInspectionNode } from '../agent/promptInspection.js';
import { PromptExecutionInspector } from '../agent/prompts/PromptExecutionInspector.js';

const roles = ['system', 'user', 'assistant', 'tool', 'assistant', 'user'] as const;
const entries: PromptPreviewAuditEntrySummary[] = roles.map((role, index) => ({
  entryId: `entry-${index}`,
  entryIndex: index,
  role,
  source: index === 0 ? 'prompt' : index === 5 ? 'preview-input' : 'conversation-message',
  preview: `Content ${index}`,
  canonicalBytes: 100,
  ...(index === 0 ? { promptPath: [{ id: 'persona', caption: 'Persona', fieldPaths: ['prompts.0'] }, { id: 'instruction', caption: 'Instruction' }] } : {}),
}));
const audit: PromptPreviewPreparedExecution = {
  sessionId: 'session',
  revision: 'revision',
  route: { providerId: 'provider', logicalModelId: 'model', wireModelId: 'model', apiMode: 'responses' },
  contextStats: { messageCount: 6, compactionSummaryCount: 0 },
  initialPage: { sessionId: 'session', revision: 'revision', items: entries, totalEntries: 6, hasMoreBefore: false, hasMoreAfter: false, sampled: false },
};
const chunk = (): PromptPreviewAuditDetailChunk => ({
  sessionId: 'session',
  revision: 'revision',
  target: { kind: 'request' },
  canonicalUtf8: new TextEncoder().encode('exact request'),
  complete: true,
});

describe('single-request prompt inspection', () => {
  it('shows sampled counts and gaps without pretending the complete range is visible, then pages omitted messages', async () => {
    const store = new PromptPreviewAuditSessionStore({ createSessionId: () => 'sampled', createRevision: () => 'revision' });
    const prepared = store.createSession({
      request: {
        providerId: 'provider',
        logicalModelId: 'model',
        wireModelId: 'model',
        apiMode: 'responses',
        messages: Array.from({ length: 200 }, (_, index) => ({ role: 'user' as const, content: `Message ${index}` })),
      },
      sources: Array.from({ length: 200 }, (_, index) => index === 0 ? 'prompt' as const : 'conversation-message' as const),
    });
    const controller = { getAuditPage: vi.fn(async request => store.getPage(request)), getAuditDetail: vi.fn() };
    render(<PromptExecutionInspector audit={prepared} controller={controller} />);
    expect(screen.getByText('50 / 200')).toBeVisible();
    expect(screen.queryByText('1–200 / 200')).not.toBeInTheDocument();
    expect(screen.getByTestId('prompt-preview-gap')).toHaveTextContent('… 2–151 …');
    const initial = screen.getAllByTestId('prompt-preview-entry').map(item => item.textContent);
    expect(initial).toHaveLength(50);
    fireEvent.click(screen.getByRole('tab', { name: 'Messages' }));
    expect(screen.getAllByTestId('prompt-preview-entry').map(item => item.textContent)).toEqual(initial);
    expect(screen.getByTestId('prompt-preview-gap')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText('Message 150');
    expect(controller.getAuditPage).toHaveBeenCalledOnce();
    expect(screen.getAllByTestId('prompt-preview-entry').at(-1)).toHaveTextContent('Message 150');
  });

  it('preserves the exact entry order through prompt ancestry, history roles and current input', () => {
    const flatten = (nodes: PromptInspectionNode[]): string[] => nodes.flatMap(node => node.entry ? [node.entry.entryId] : flatten(node.children));
    expect(flatten(buildPromptInspectionTree(entries))).toEqual(entries.map(entry => entry.entryId));
    const controller = { getAuditPage: vi.fn(), getAuditDetail: vi.fn() };
    render(<PromptExecutionInspector audit={audit} controller={controller} />);
    expect(screen.getByText('Persona')).toBeVisible();
    expect(screen.getByText('Instruction')).toBeVisible();
    const visibleEntries = () => screen.getAllByTestId('prompt-preview-entry').map(button => button.textContent);
    expect(visibleEntries()).toEqual(entries.map(entry => entry.preview));
    fireEvent.click(screen.getByRole('tab', { name: 'Messages' }));
    expect(visibleEntries()).toEqual(entries.map(entry => entry.preview));
    expect(controller.getAuditPage).not.toHaveBeenCalled();
  });

  it('goes back while loading and ignores late replies without fetching the previous page', async () => {
    let resolve!: (value: PromptPreviewAuditDetailChunk) => void;
    const controller = {
      getAuditPage: vi.fn().mockRejectedValue(new Error('expired')),
      getAuditDetail: vi.fn(() =>
        new Promise<PromptPreviewAuditDetailChunk>(done => {
          resolve = done;
        })
      ),
    };
    render(<PromptExecutionInspector audit={audit} controller={controller} />);
    fireEvent.click(screen.getAllByTestId('prompt-preview-entry')[3]);
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByTestId('prompt-preview-audit-detail')).not.toBeInTheDocument();
    expect(screen.getByText('Content 3')).toBeVisible();
    await act(async () => {
      resolve(chunk());
    });
    expect(screen.queryByTestId('prompt-preview-audit-detail')).not.toBeInTheDocument();
    expect(controller.getAuditPage).not.toHaveBeenCalled();
  });

  it('keeps an exit after request failure and supports Escape from model request detail', async () => {
    const controller = { getAuditPage: vi.fn(), getAuditDetail: vi.fn().mockRejectedValueOnce(new Error('expired')).mockResolvedValueOnce(chunk()) };
    render(<PromptExecutionInspector audit={audit} controller={controller} />);
    fireEvent.click(screen.getByRole('button', { name: 'Model request' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Model request' }));
    await screen.findByText('exact request');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Back' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('prompt-preview-audit-detail')).not.toBeInTheDocument());
    expect(controller.getAuditPage).not.toHaveBeenCalled();
  });
});
