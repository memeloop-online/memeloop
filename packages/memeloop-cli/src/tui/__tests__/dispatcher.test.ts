import { describe, expect, it } from 'vitest';
import { createTUIDispatcher } from '../TUIApp.js';
import type { PermissionRequest, TUIMessage, TUIState } from '../types.js';

/**
 * Tests for TUIDispatcher imperative API.
 * These test the state management without rendering Ink components.
 */
describe('createTUIDispatcher', () => {
  it('addMessage appends messages', () => {
    const tui = createTUIDispatcher();

    const msg: TUIMessage = {
      id: '1',
      role: 'user',
      content: 'hello',
      timestamp: new Date(),
    };

    tui.addMessage(msg);
    tui.addMessage({ id: '2', role: 'assistant', content: 'hi', timestamp: new Date() });

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

    tui.addMessage({ id: 'a', role: 'system', content: 'start', timestamp: new Date() });
    expect(tui.getMessages()).toHaveLength(1);
  });

  it('getMode returns current mode', () => {
    const tui = createTUIDispatcher();
    expect(tui.getMode()).toBe('chat');

    tui.setMode('plan');
    expect(tui.getMode()).toBe('plan');
  });
});
