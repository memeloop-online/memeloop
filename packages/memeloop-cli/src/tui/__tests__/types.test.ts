import { describe, expect, it } from 'vitest';
import type { PermissionRequest, ToolProgress, TUIAction, TUIMessage, TUIMode, TUIState } from '../types.js';

describe('TUI types (structural validation)', () => {
  it('TUIMessage allows all roles', () => {
    const msg: TUIMessage = {
      id: '1',
      role: 'assistant',
      content: 'hello',
      timestamp: new Date(),
    };
    expect(msg.role).toBe('assistant');
  });

  it('TUIMessage with tool metadata', () => {
    const msg: TUIMessage = {
      id: 't1',
      role: 'tool',
      content: 'done',
      timestamp: new Date(),
      toolName: 'read_file',
      toolInput: { path: '/test' },
      toolResult: 'file contents',
    };
    expect(msg.toolName).toBe('read_file');
    expect(msg.toolResult).toBe('file contents');
  });

  it('TUIMessage with thinking', () => {
    const msg: TUIMessage = {
      id: '1',
      role: 'assistant',
      content: 'answer',
      timestamp: new Date(),
      thinking: 'Let me think about this...',
    };
    expect(msg.thinking).toContain('think');
  });

  it('PermissionRequest supports always action', () => {
    const perm: PermissionRequest = {
      id: 'p1',
      toolName: 'write_file',
      toolInput: { path: '/f' },
      message: 'Allow?',
      actions: ['allow', 'deny', 'always'],
    };
    expect(perm.actions).toContain('always');
  });

  it('ToolProgress supports all statuses', () => {
    const running: ToolProgress = { toolName: 't', status: 'running', startTime: new Date() };
    const done: ToolProgress = { toolName: 't', status: 'done', startTime: new Date() };
    const error: ToolProgress = { toolName: 't', status: 'error', startTime: new Date(), message: 'fail' };

    expect(running.status).toBe('running');
    expect(done.status).toBe('done');
    expect(error.status).toBe('error');
    expect(error.message).toBe('fail');
  });

  it('TUIState holds all sub-states', () => {
    const state: TUIState = {
      messages: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
      pendingTailCount: 0,
      loadingPage: false,
      thinking: false,
      progress: null,
      permission: null,
      statusText: 'Ready',
      mode: 'chat',
    };
    expect(state.mode).toBe('chat');
  });

  it('TUIMode allows all three modes', () => {
    const modes: TUIMode[] = ['chat', 'plan', 'autopilot'];
    expect(modes).toHaveLength(3);
  });

  it('TUIAction discriminated union works', () => {
    const addMsg: TUIAction = {
      type: 'ADD_MESSAGE',
      message: { id: '1', role: 'user', content: 'hi', timestamp: new Date() },
    };
    expect(addMsg.type).toBe('ADD_MESSAGE');

    const setThink: TUIAction = { type: 'SET_THINKING', thinking: true };
    expect(setThink.thinking).toBe(true);

    const setMode: TUIAction = { type: 'SET_MODE', mode: 'autopilot' };
    expect(setMode.mode).toBe('autopilot');
  });
});
