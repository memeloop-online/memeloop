import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentSessionController, AgentSessionSnapshot } from 'memeloop';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AgentSessionProvider } from '../agent/AgentSessionProvider.js';
import { useAgentSession } from '../agent/useAgentSession.js';

function snapshot(id: string): AgentSessionSnapshot {
  return {
    agent: null,
    loading: false,
    loadingMoreBefore: false,
    loadingMoreAfter: false,
    error: null,
    messages: [],
    orderedMessageIds: [id],
    streamingMessageIds: new Set(),
    hasMoreBefore: false,
    hasMoreAfter: false,
    pendingNewMessageCount: 0,
  };
}

function fakeController(initial: AgentSessionSnapshot) {
  let current = initial;
  const listeners = new Set<() => void>();
  const subscribe = vi.fn((listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const controller = {
    getSnapshot: () => current,
    subscribe,
  } as unknown as AgentSessionController;
  return {
    controller,
    subscribe,
    emit(next: AgentSessionSnapshot) {
      current = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function Consumer() {
  const { snapshot: value } = useAgentSession();
  return <span>{value.orderedMessageIds[0]}</span>;
}

describe('AgentSessionProvider controller lifecycle', () => {
  it('unsubscribes A and immediately follows B snapshot and updates', () => {
    const a = fakeController(snapshot('A'));
    const b = fakeController(snapshot('B'));
    const rendered = render(
      <AgentSessionProvider controller={a.controller}>
        <Consumer />
      </AgentSessionProvider>,
    );
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(a.listenerCount()).toBe(1);
    expect(a.subscribe).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <AgentSessionProvider controller={b.controller}>
        <Consumer />
      </AgentSessionProvider>,
    );
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(a.listenerCount()).toBe(0);
    expect(b.listenerCount()).toBe(1);
    expect(b.subscribe).toHaveBeenCalledTimes(1);

    act(() => {
      a.emit(snapshot('stale-A'));
    });
    expect(screen.queryByText('stale-A')).not.toBeInTheDocument();
    act(() => {
      b.emit(snapshot('new-B'));
    });
    expect(screen.getByText('new-B')).toBeInTheDocument();

    rendered.unmount();
    expect(b.listenerCount()).toBe(0);
  });

  it('reuses one deeply immutable fallback snapshot across server renders', () => {
    const serverSnapshots: AgentSessionSnapshot[] = [];
    const controller = {
      getSnapshot: () => {
        throw new Error('client snapshot must not be read while rendering on the server');
      },
      subscribe: vi.fn(() => () => {}),
    } as unknown as AgentSessionController;
    function ServerConsumer() {
      const { snapshot: value } = useAgentSession();
      serverSnapshots.push(value);
      return <span>{value.orderedMessageIds.length}</span>;
    }
    const tree = (
      <AgentSessionProvider controller={controller}>
        <ServerConsumer />
      </AgentSessionProvider>
    );

    expect(renderToString(tree)).toContain('>0<');
    expect(renderToString(tree)).toContain('>0<');
    expect(serverSnapshots).toHaveLength(2);
    expect(serverSnapshots[1]).toBe(serverSnapshots[0]);
    expect(Object.isFrozen(serverSnapshots[0])).toBe(true);
    expect(Object.isFrozen(serverSnapshots[0]?.messages)).toBe(true);
    expect(Object.isFrozen(serverSnapshots[0]?.orderedMessageIds)).toBe(true);
    expect(Object.isFrozen(serverSnapshots[0]?.streamingMessageIds)).toBe(true);
    expect(serverSnapshots[0]).toMatchObject({
      loadingMoreBefore: false,
      loadingMoreAfter: false,
      pendingNewMessageCount: 0,
    });
    expect(serverSnapshots[0]?.streamingMessageIds.valueOf()).toBe(serverSnapshots[0]?.streamingMessageIds);
    expect(() => {
      (serverSnapshots[0]?.orderedMessageIds as string[]).push('leak');
    }).toThrow(TypeError);
    expect(() => {
      (serverSnapshots[0]?.streamingMessageIds as Set<string>).add('leak');
    }).toThrow(TypeError);
    expect(controller.subscribe).not.toHaveBeenCalled();
  });
});
