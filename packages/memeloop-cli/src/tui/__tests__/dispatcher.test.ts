import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { createTUIDispatcher, TUIApp } from '../TUIApp.js';
import type { PermissionRequest, TUIMessage, TUIState } from '../types.js';

/**
 * Tests for TUIDispatcher imperative API.
 * These test the state management without rendering Ink components.
 */
describe('createTUIDispatcher', () => {
  it('addMessage appends messages', () => {
    const tui = createTUIDispatcher();

    const msg: TUIMessage = {
      messageId: '1',
      role: 'user',
      content: 'hello',
      timestamp: new Date(),
    };

    tui.addMessage(msg);
    tui.addMessage({ messageId: '2', role: 'assistant', content: 'hi', timestamp: new Date() });

    expect(tui.getMessages()).toHaveLength(2);
    expect(tui.getMessages()[0].content).toBe('hello');
  });

  it('setThinking toggles thinking state (internal)', () => {
    const tui = createTUIDispatcher();
    // setThinking dispatches to reducer — just verify it doesn't throw
    expect(() => {
      tui.setThinking(true);
    }).not.toThrow();
    expect(() => {
      tui.setThinking(false);
    }).not.toThrow();
  });

  it('setStatus updates status text (internal)', () => {
    const tui = createTUIDispatcher();
    expect(() => {
      tui.setStatus('Testing...');
    }).not.toThrow();
  });

  it('setProgress sets progress state', () => {
    const tui = createTUIDispatcher();
    const progress: TUIState['progress'] = {
      toolName: 'test-tool',
      status: 'running',
      message: 'working...',
      startTime: new Date(),
    };
    expect(() => {
      tui.setProgress(progress);
    }).not.toThrow();
  });

  it('waitForPermission returns promise that resolves via resolvePermission', async () => {
    const tui = createTUIDispatcher();

    const perm: PermissionRequest = {
      id: 'perm-1',
      toolName: 'write_file',
      toolInput: { path: '/tmp/test.txt' },
      message: 'Allow writing file?',
      actions: ['allow', 'deny'],
    };

    const promise = tui.waitForPermission(perm);

    // resolve after a tick
    setTimeout(() => {
      tui.resolvePermission(true);
    }, 10);

    const result = await promise;
    expect(result).toBe(true);
  });

  it('waitForPermission denied returns false', async () => {
    const tui = createTUIDispatcher();

    const perm: PermissionRequest = {
      id: 'perm-2',
      toolName: 'exec',
      toolInput: { cmd: 'rm -rf /' },
      message: 'Allow dangerous command?',
      actions: ['allow', 'deny'],
    };

    const promise = tui.waitForPermission(perm);
    setTimeout(() => {
      tui.resolvePermission(false);
    }, 10);

    const result = await promise;
    expect(result).toBe(false);
  });

  it('getMessages returns current snapshot', () => {
    const tui = createTUIDispatcher();
    expect(tui.getMessages()).toEqual([]);

    tui.addMessage({ messageId: 'a', role: 'system', content: 'start', timestamp: new Date() });
    expect(tui.getMessages()).toHaveLength(1);
  });

  it('getMode returns current mode', () => {
    const tui = createTUIDispatcher();
    expect(tui.getMode()).toBe('chat');

    tui.setMode('plan');
    expect(tui.getMode()).toBe('plan');
  });

  it('keeps live dispatcher residency at 50 messages', () => {
    const tui = createTUIDispatcher();
    for (let index = 1; index <= 500; index += 1) {
      tui.addMessage({
        messageId: `message-${index}`,
        role: 'assistant',
        content: `message ${index}`,
        timestamp: new Date(index),
      });
    }
    expect(tui.getMessages()).toHaveLength(50);
    expect(tui.getMessages()[0]?.messageId).toBe('message-451');
    expect(tui.getMessages().at(-1)?.messageId).toBe('message-500');
  });

  it('projects a huge live response before it enters resident state', () => {
    const tui = createTUIDispatcher();
    tui.addMessage({
      messageId: 'huge-live-output',
      role: 'assistant',
      content: `\u001B[31m${'🚀'.repeat(150_000)}\u001B[0m`,
      timestamp: new Date(1),
    });
    const resident = tui.getMessages()[0];
    if (!resident) throw new Error('missing resident projection');
    expect(resident.content).toContain('[detail omitted]');
    expect(resident.content).not.toContain('\u001B');
    expect(new TextEncoder().encode(resident.content).byteLength).toBeLessThanOrEqual(3 * 1024);
    expect(resident.detail).toMatchObject({ truncated: true });
  });

  it('rejects an oversized initial host window instead of silently slicing it', () => {
    const tui = createTUIDispatcher();
    expect(() => {
      tui.setMessages(Array.from({ length: 51 }, (_, index) => ({
        messageId: `host-${index}`,
        role: 'assistant' as const,
        content: 'host row',
        timestamp: new Date(index),
      })));
    }).toThrow('tui_message_window_exceeds_message_limit');
  });

  it('binds pre-render and live dispatcher state into TUIApp', async () => {
    const tui = createTUIDispatcher();
    tui.setStatus('Restored before render');
    tui.addMessage({
      messageId: 'pre-render',
      role: 'assistant',
      content: 'bounded restored row',
      timestamp: new Date(1),
    });
    const view = render(React.createElement(TUIApp, {
      dispatcher: tui,
      onSubmit: () => undefined,
      onPermissionResponse: () => undefined,
      onExit: () => undefined,
    }));
    await new Promise(resolve => setImmediate(resolve));
    expect(view.lastFrame()).toContain('Restored before render');
    expect(view.lastFrame()).toContain('bounded restored row');

    tui.addMessage({
      messageId: 'live-update',
      role: 'assistant',
      content: 'live dispatcher row',
      timestamp: new Date(2),
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(view.lastFrame()).toContain('live dispatcher row');
    view.unmount();
  });
});
