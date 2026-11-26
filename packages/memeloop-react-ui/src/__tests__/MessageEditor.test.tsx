import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConversationEditingAdapter } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';
import { MessageEditor } from '../chat/thread/MessageEditor.js';

function fixture() {
  let draft: { text: string | null; revision: number } | null = null;
  const adapter: ConversationEditingAdapter = {
    branches: [],
    loadSource: vi.fn(async () => ({ text: 'Complete source beyond the list preview', sourceRevision: 'source-1', draft })),
    saveDraft: vi.fn(async (_messageId: string, text: string | null, revision: number) => {
      if (revision !== (draft?.revision ?? 0)) throw new Error('conflict');
      draft = { text, revision: revision + 1 };
      return draft.revision;
    }),
    submit: vi.fn(async () => {}),
    switchBranch: vi.fn(async () => {}),
  };
  const onError = vi.fn();
  const view = () => <MessageEditor messageId='message-1' adapter={adapter} onError={onError}>Short preview</MessageEditor>;
  return { adapter, onError, view, getDraft: () => draft };
}

describe('shared message editor', () => {
  it('does not clear a newer edit that returns to the same text while older saves are queued', async () => {
    const f = fixture();
    const save = f.adapter.saveDraft;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const originalSave = vi.mocked(save).getMockImplementation()!;
    vi.mocked(save).mockImplementationOnce(async (...args) => {
      await gate;
      return originalSave(...args);
    });
    render(f.view());
    fireEvent.click(screen.getByTestId('message-edit'));
    const input = await screen.findByTestId('message-edit-input');
    fireEvent.change(input, { target: { value: 'A' } });
    await waitFor(() => {
      expect(save).toHaveBeenCalledOnce();
    });
    fireEvent.change(input, { target: { value: 'B' } });
    await new Promise(resolve => setTimeout(resolve, 250));
    fireEvent.change(input, { target: { value: 'A' } });
    release();
    fireEvent.click(screen.getByTestId('message-edit-save'));
    await waitFor(() => expect(screen.queryByTestId('message-edit-input')).not.toBeInTheDocument());
    expect(f.getDraft()?.text).toBe('A');
  });
  it('retries an autosave failure without requiring another keystroke', async () => {
    const f = fixture();
    vi.mocked(f.adapter.saveDraft).mockRejectedValueOnce(new Error('offline'));
    render(f.view());
    fireEvent.click(screen.getByTestId('message-edit'));
    fireEvent.change(await screen.findByTestId('message-edit-input'), { target: { value: 'keep my text' } });
    await waitFor(() => {
      expect(f.onError).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByTestId('message-edit-save'));
    await waitFor(() => expect(screen.queryByTestId('message-edit-input')).not.toBeInTheDocument());
    expect(f.getDraft()?.text).toBe('keep my text');
  });

  it('preserves conflicting text and explicitly reloads the newer draft', async () => {
    const f = fixture();
    render(f.view());
    fireEvent.click(screen.getByTestId('message-edit'));
    await screen.findByTestId('message-edit-input');
    await f.adapter.saveDraft('message-1', 'other window', 0);
    fireEvent.change(screen.getByTestId('message-edit-input'), { target: { value: 'local conflict' } });
    await screen.findByRole('alert');
    expect(screen.getByTestId('message-edit-input')).toHaveValue('local conflict');
    expect(f.getDraft()?.text).toBe('other window');
    fireEvent.click(screen.getByText('Load saved draft'));
    await waitFor(() => expect(screen.getByTestId('message-edit-input')).toHaveValue('other window'));
    fireEvent.change(screen.getByTestId('message-edit-input'), { target: { value: 'resolved' } });
    fireEvent.click(screen.getByTestId('message-edit-save'));
    await waitFor(() => {
      expect(f.getDraft()?.text).toBe('resolved');
    });
  });
  it('loads full text, autosaves without Save, persists through remount, Escape and discard', async () => {
    const f = fixture();
    const first = render(f.view());
    fireEvent.click(screen.getByTestId('message-edit'));
    const input = await screen.findByTestId('message-edit-input');
    expect(input).toHaveValue('Complete source beyond the list preview');
    fireEvent.change(input, { target: { value: 'automatic draft' } });
    await waitFor(() => {
      expect(f.getDraft()?.text).toBe('automatic draft');
    });
    first.unmount();
    render(f.view());
    fireEvent.click(screen.getByTestId('message-edit'));
    expect(await screen.findByTestId('message-edit-input')).toHaveValue('automatic draft');
    fireEvent.change(screen.getByTestId('message-edit-input'), { target: { value: 'saved on Escape' } });
    fireEvent.keyDown(screen.getByTestId('message-edit-input'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('message-edit-input')).not.toBeInTheDocument());
    expect(f.getDraft()?.text).toBe('saved on Escape');
    fireEvent.click(screen.getByTestId('message-edit'));
    expect(await screen.findByTestId('message-edit-input')).toHaveValue('saved on Escape');
    fireEvent.change(screen.getByTestId('message-edit-input'), { target: { value: 'discard this queued write' } });
    fireEvent.click(screen.getByTestId('message-edit-discard'));
    await waitFor(() => {
      expect(f.getDraft()?.text).toBeNull();
    });
    fireEvent.click(screen.getByTestId('message-edit'));
    expect(await screen.findByTestId('message-edit-input')).toHaveValue('Complete source beyond the list preview');
    expect(f.onError).not.toHaveBeenCalled();
  });

  it('flushes the exact draft revision before forking and preserves original text on failure', async () => {
    const f = fixture();
    vi.mocked(f.adapter.submit).mockRejectedValueOnce(new Error('offline'));
    render(f.view());
    fireEvent.click(screen.getByTestId('message-edit'));
    fireEvent.change(await screen.findByTestId('message-edit-input'), { target: { value: 'branch prompt' } });
    fireEvent.click(screen.getByTestId('message-edit-send'));
    await waitFor(() => {
      expect(f.adapter.submit).toHaveBeenCalledWith('message-1', 'branch prompt', 'source-1', 1);
    });
    await waitFor(() => {
      expect(f.onError).toHaveBeenCalled();
    });
    expect(screen.getByTestId('message-edit-input')).toHaveValue('branch prompt');
    expect(f.getDraft()?.text).toBe('branch prompt');
  });

  it('exposes previous and next history controls with bounded alternatives', async () => {
    const f = fixture();
    f.adapter.branches = [{
      messageId: 'message-1',
      selected: 1,
      alternatives: [{ conversationId: 'old', messageId: 'old-message' }, { conversationId: 'new', messageId: 'message-1' }],
    }];
    render(f.view());
    expect(screen.getByTestId('message-branch-next')).toBeDisabled();
    fireEvent.click(screen.getByTestId('message-branch-previous'));
    await waitFor(() => {
      expect(f.adapter.switchBranch).toHaveBeenCalledWith('old', 'old-message');
    });
  });
});
