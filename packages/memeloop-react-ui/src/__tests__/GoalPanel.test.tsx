import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentGoal, GoalClient } from 'memeloop';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoalDialog, GoalPanel } from '../agent/GoalPanel.js';
import { defaultGoalPanelLabels as labels, getGoalPanelLabels, type GoalPanelProps } from '../agent/goals.js';
import { NativeGoalDialog, NativeGoalPanel } from '../native/GoalPanel.js';

const nativeDialog = vi.hoisted(() => ({
  onRequestClose: undefined as (() => void) | undefined,
  scroll: {} as { keyboardShouldPersistTaps?: string; automaticallyAdjustKeyboardInsets?: boolean; contentContainerStyle?: { paddingBottom: number } },
}));

vi.mock('react-native', () => ({
  Modal: ({ children, onRequestClose }: { children?: React.ReactNode; onRequestClose?: () => void }) => {
    nativeDialog.onRequestClose = onRequestClose;
    return <div role='dialog'>{children}</div>;
  },
  ScrollView: ({ children, ...props }: { children?: React.ReactNode }) => {
    nativeDialog.scroll = props;
    return <div>{children}</div>;
  },
  View: ({ children, accessibilityLabel }: { children?: React.ReactNode; accessibilityLabel?: string }) => <div aria-label={accessibilityLabel}>{children}</div>,
  Text: ({ children, accessibilityRole }: { children?: React.ReactNode; accessibilityRole?: string }) => <span role={accessibilityRole}>{children}</span>,
}));
vi.mock('react-native-paper', async () => ({
  ...(await import('./nativePaperMock.js')).nativePaperControls,
  ActivityIndicator: () => <span role='status' />,
  useTheme: () => ({ colors: { onSurface: '#eee', onSurfaceVariant: '#ccc', surfaceVariant: '#333', primary: '#acd', error: '#f88' } }),
}));

const initialGoal: AgentGoal = {
  id: 'goal-1',
  conversationId: 'conversation-1',
  definitionId: 'definition-1',
  executionNodeId: 'desktop',
  objective: 'Prepare a reading plan',
  status: 'active',
  revision: 1,
  round: 1,
  updatedAt: new Date().toISOString(),
};

function makeClient(initial: AgentGoal | null = null) {
  let goal = initial;
  const client = {
    get: vi.fn<GoalClient['get']>(async () => goal),
    start: vi.fn<GoalClient['start']>(async input => goal = { ...initialGoal, ...input }),
    pause: vi.fn<GoalClient['pause']>(async () => goal = { ...goal!, status: 'paused', revision: goal!.revision + 1 }),
    resume: vi.fn<GoalClient['resume']>(async () => goal = { ...goal!, status: 'active', revision: goal!.revision + 1 }),
    complete: vi.fn<GoalClient['complete']>(async input => goal = { ...goal!, status: 'completed', evidence: input.evidence, revision: goal!.revision + 1 }),
  } satisfies GoalClient;
  return client;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe.each<[string, React.ComponentType<GoalPanelProps>]>([['desktop', GoalPanel], ['native', NativeGoalPanel]])('%s goal controls', (_platform, Panel) => {
  const renderPanel = (client: GoalClient) => render(<Panel client={client} conversationId='conversation-1' definitionId='definition-1' />);

  it('starts, pauses, resumes and completes with explicit evidence', async () => {
    const client = makeClient();
    renderPanel(client);
    const objective = await screen.findByLabelText(labels.objective);
    expect(screen.getByRole('button', { name: labels.start })).toBeDisabled();
    fireEvent.change(objective, { target: { value: '  Prepare a reading plan  ' } });
    fireEvent.click(screen.getByRole('button', { name: labels.start }));
    await screen.findByText(labels.status.active);
    expect(client.start).toHaveBeenCalledWith({ conversationId: 'conversation-1', definitionId: 'definition-1', objective: 'Prepare a reading plan' });
    fireEvent.click(screen.getByRole('button', { name: labels.pause }));
    await screen.findByText(labels.status.paused);
    expect(client.pause).toHaveBeenCalledWith({ conversationId: 'conversation-1', expectedRevision: 1 });
    fireEvent.click(screen.getByRole('button', { name: labels.resume }));
    await screen.findByText(labels.status.active);
    expect(client.resume).toHaveBeenCalledWith({ conversationId: 'conversation-1', expectedRevision: 2 });
    fireEvent.click(screen.getByRole('button', { name: labels.complete }));
    expect(screen.getByRole('button', { name: labels.confirmComplete })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(labels.evidence), { target: { value: 'Plan saved and checked.' } });
    fireEvent.click(screen.getByRole('button', { name: labels.confirmComplete }));
    await screen.findByText(labels.status.completed);
    expect(client.complete).toHaveBeenCalledWith({ conversationId: 'conversation-1', expectedRevision: 3, evidence: 'Plan saved and checked.' });
    expect(screen.getByText('Plan saved and checked.')).toBeVisible();
    expect(screen.getByLabelText(labels.objective)).toHaveValue('');
  });

  it('shows blocked context and resumes the existing objective', async () => {
    const client = makeClient({ ...initialGoal, status: 'blocked', blockedReason: 'Choose a workspace.' });
    renderPanel(client);
    await screen.findByText('Choose a workspace.');
    expect(screen.getByText(initialGoal.objective)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: labels.resume }));
    await screen.findByText(labels.status.active);
    expect(client.start).not.toHaveBeenCalled();
  });

  it('keeps draft text when a failed start is retried', async () => {
    const client = makeClient();
    client.start.mockRejectedValueOnce(new Error('offline'));
    renderPanel(client);
    fireEvent.change(await screen.findByLabelText(labels.objective), { target: { value: 'My goal draft' } });
    fireEvent.click(screen.getByRole('button', { name: labels.start }));
    await screen.findByText(labels.failed);
    fireEvent.click(screen.getByRole('button', { name: labels.retry }));
    expect(await screen.findByLabelText(labels.objective)).toHaveValue('My goal draft');
  });

  it('isolates a pending mutation when the conversation changes', async () => {
    const client = makeClient(initialGoal);
    let finish!: (goal: AgentGoal) => void;
    client.pause.mockImplementationOnce(() =>
      new Promise(resolve => {
        finish = resolve;
      })
    );
    const view = renderPanel(client);
    fireEvent.click(await screen.findByRole('button', { name: labels.pause }));
    const nextClient = makeClient({ ...initialGoal, conversationId: 'conversation-2', objective: 'Second goal' });
    view.rerender(<Panel client={nextClient} conversationId='conversation-2' definitionId='definition-1' />);
    await screen.findByText('Second goal');
    await act(async () => {
      finish({ ...initialGoal, status: 'paused' });
    });
    expect(screen.getByText('Second goal')).toBeVisible();
    expect(screen.getByText(labels.status.active)).toBeVisible();
  });

  it('refreshes remote state and preserves a newer mutation over a stale read', async () => {
    vi.useFakeTimers();
    const client = makeClient(initialGoal);
    renderPanel(client);
    await act(async () => {});
    let finishRead!: (goal: AgentGoal) => void;
    client.get.mockImplementationOnce(() =>
      new Promise(resolve => {
        finishRead = resolve;
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    fireEvent.click(screen.getByRole('button', { name: labels.pause }));
    await act(async () => {});
    expect(screen.getByText(labels.status.paused)).toBeVisible();
    await act(async () => {
      finishRead(initialGoal);
    });
    expect(screen.getByText(labels.status.paused)).toBeVisible();
    client.get.mockResolvedValue({ ...initialGoal, revision: 3, status: 'completed', evidence: 'Completed on desktop.' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText('Completed on desktop.')).toBeVisible();
    cleanup();
    const calls = client.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(client.get).toHaveBeenCalledTimes(calls);
  });
});

it('localizes the same controls for simplified and traditional Chinese', () => {
  expect(getGoalPanelLabels('zh-Hans').title).toBe('目标');
  expect(getGoalPanelLabels('zh-TW').title).toBe('目標');
  expect(getGoalPanelLabels('en-GB')).toBe(labels);
  expect(Object.keys(getGoalPanelLabels('zh-Hant')).sort()).toEqual(Object.keys(labels).sort());
});

it('native goal dialog returns through the header and system back with safe keyboard layout', async () => {
  const close = vi.fn();
  render(<NativeGoalDialog client={makeClient()} conversationId='conversation-1' definitionId='definition-1' topInset={24} bottomInset={36} onClose={close} />);
  await screen.findByLabelText(labels.objective);
  fireEvent.click(screen.getByRole('button', { name: labels.back }));
  nativeDialog.onRequestClose?.();
  expect(close).toHaveBeenCalledTimes(2);
  expect(nativeDialog.scroll).toMatchObject({
    keyboardShouldPersistTaps: 'handled',
    automaticallyAdjustKeyboardInsets: true,
    contentContainerStyle: { paddingBottom: 52 },
  });
});

it('desktop goal dialog has a named surface and return action', async () => {
  const close = vi.fn();
  render(<GoalDialog client={makeClient()} conversationId='conversation-1' definitionId='definition-1' onClose={close} />);
  await screen.findByLabelText(labels.objective);
  expect(screen.getByRole('dialog', { name: labels.title })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: labels.back }));
  expect(close).toHaveBeenCalledOnce();
});
