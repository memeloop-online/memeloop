/**
 * TUI App — MemeLoop 交互式终端界面 (Ink + React)
 *
 * 对标 Claude Code REPL: 消息流 + 输入框 + 权限确认 + 进度指示
 */
import { Box, useApp, useInput } from 'ink';
import React, { useCallback, useEffect, useReducer, useState } from 'react';
import { ChatMessageList } from './ChatMessageList.js';
import { projectDisplayText, projectTUIMessageForDisplay, TUI_MESSAGE_CONTENT_MAX_BYTES } from './messageAdapter.js';
import {
  appendTUIResidentMessage,
  assertResidentMessages,
  TUIMessageWindowController,
  type TUIMessageWindowFocus,
  type TUIMessageWindowOptions,
  type TUIMessageWindowSource,
} from './messageWindow.js';
import { PermissionDialog } from './PermissionDialog.js';
import { PromptInput } from './PromptInput.js';
import { StatusBar } from './StatusBar.js';
import { ToolProgressIndicator } from './ToolProgressIndicator.js';
import type { PermissionRequest, TUIAction, TUIMessage, TUIMode, TUIState } from './types.js';

function reducer(state: TUIState, action: TUIAction): TUIState {
  switch (action.type) {
    case 'ADD_MESSAGE': {
      const appended = appendTUIResidentMessage(
        state.messages,
        projectTUIMessageForDisplay(action.message),
      );
      return {
        ...state,
        messages: appended.messages,
        hasMoreBefore: state.hasMoreBefore || appended.trimmed,
      };
    }
    case 'SET_MESSAGES': {
      assertResidentMessages(action.messages);
      return { ...state, messages: action.messages };
    }
    case 'SET_WINDOW':
      return {
        ...state,
        messages: action.messages,
        semanticAnchor: action.semanticAnchor,
        hasMoreBefore: action.hasMoreBefore,
        hasMoreAfter: action.hasMoreAfter,
        pendingTailCount: action.pendingTailCount,
        loadingPage: action.loadingPage,
        windowError: action.windowError,
      };
    case 'APPEND_TO_LAST': {
      if (state.messages.length === 0) return state;
      const msgs = [...state.messages];
      const last = { ...msgs[msgs.length - 1] };
      const projection = projectDisplayText(
        last.content + action.text,
        TUI_MESSAGE_CONTENT_MAX_BYTES,
      );
      last.content = projection.text;
      if (projection.truncated) {
        last.detail = {
          truncated: true,
          originalBytes: projection.originalBytes,
          ...(last.detail?.detailRef === undefined ? {} : { detailRef: last.detail.detailRef }),
        };
      }
      msgs[msgs.length - 1] = last;
      return { ...state, messages: msgs };
    }
    case 'SET_THINKING':
      return { ...state, thinking: action.thinking };
    case 'SET_PROGRESS':
      return { ...state, progress: action.progress };
    case 'SET_PERMISSION':
      return { ...state, permission: action.permission };
    case 'SET_STATUS':
      return { ...state, statusText: action.text };
    case 'SET_MODE':
      return { ...state, mode: action.mode };
    default:
      return state;
  }
}

const initialState: TUIState = {
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

export interface TUIAppProps {
  /** called when user submits a message */
  onSubmit: (text: string) => void;
  /** called when user responds to a permission request */
  onPermissionResponse: (requestId: string, approved: boolean) => void;
  /** called on Ctrl+C / exit */
  onExit: () => void;
  /** initial messages to display */
  initialMessages?: TUIMessage[];
  /** Optional revisioned source/controller for PageUp/PageDown history navigation. */
  messageWindow?: TUIMessageWindowController;
  /** Imperative host bridge. It owns the revisioned resident message window. */
  dispatcher?: TUIDispatcher;
}

export function TUIApp({
  onSubmit,
  onPermissionResponse,
  onExit,
  initialMessages,
  messageWindow,
  dispatcher,
}: TUIAppProps) {
  if (initialMessages !== undefined) assertResidentMessages(initialMessages);
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    messages: initialMessages ?? [],
  });
  const { exit } = useApp();
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    if (!messageWindow || dispatcher) return undefined;
    return messageWindow.subscribe(snapshot => {
      dispatch({
        type: 'SET_WINDOW',
        messages: [...snapshot.messages],
        semanticAnchor: snapshot.semanticAnchor,
        hasMoreBefore: snapshot.hasMoreBefore,
        hasMoreAfter: snapshot.hasMoreAfter,
        pendingTailCount: snapshot.pendingTailCount,
        loadingPage: snapshot.loading,
        ...(snapshot.error === undefined ? {} : { windowError: snapshot.error.message }),
      });
    });
  }, [dispatcher, messageWindow]);

  useEffect(() => {
    if (!dispatcher) return undefined;
    dispatcher.setDispatch(dispatch);
    return () => {
      dispatcher.clearDispatch(dispatch);
    };
  }, [dispatcher]);

  const handleSubmit = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      const userMessage: TUIMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: new Date(),
      };
      if (dispatcher) {
        dispatcher.addMessage(userMessage);
        dispatcher.setThinking(true);
        dispatcher.setStatus('Thinking...');
      } else {
        dispatch({ type: 'ADD_MESSAGE', message: userMessage });
        dispatch({ type: 'SET_THINKING', thinking: true });
        dispatch({ type: 'SET_STATUS', text: 'Thinking...' });
      }
      setInputValue('');
      onSubmit(text);
    },
    [dispatcher, onSubmit],
  );

  const handlePermission = useCallback(
    (approved: boolean) => {
      if (state.permission) {
        onPermissionResponse(state.permission.id, approved);
        dispatch({ type: 'SET_PERMISSION', permission: null });
      }
    },
    [state.permission, onPermissionResponse],
  );

  useInput((input, key) => {
    // Permission dialog key handling
    if (state.permission) {
      if (input === 'y' || input === 'Y') {
        handlePermission(true);
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        handlePermission(false);
        return;
      }
      if (input === 'a' || input === 'A') {
        // "Always allow" — treat as approve for now
        handlePermission(true);
        return;
      }
      return; // block all other keys while permission dialog is showing
    }

    if (key.ctrl && input === 'c') {
      onExit();
      exit();
    }
    if (key.pageUp) void (dispatcher?.loadOlder() ?? messageWindow?.loadOlder());
    if (key.pageDown) void (dispatcher?.loadNewer() ?? messageWindow?.loadNewer());
  });

  return (
    <Box flexDirection='column' height='100%'>
      <StatusBar text={state.statusText} mode={state.mode} messageCount={state.messages.length} />
      <ChatMessageList
        messages={state.messages}
        semanticAnchor={state.semanticAnchor}
        thinking={state.thinking}
        hasMoreBefore={state.hasMoreBefore}
        hasMoreAfter={state.hasMoreAfter}
        pendingTailCount={state.pendingTailCount}
        loadingPage={state.loadingPage}
        windowError={state.windowError}
      />
      {state.progress && <ToolProgressIndicator progress={state.progress} />}
      {state.permission && (
        <PermissionDialog
          request={state.permission}
          onApprove={() => {
            handlePermission(true);
          }}
          onDeny={() => {
            handlePermission(false);
          }}
        />
      )}
      {!state.permission && (
        <PromptInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          disabled={state.thinking}
          placeholder={state.thinking
            ? 'Waiting for response...'
            : 'Type a message or /command...'}
        />
      )}
    </Box>
  );
}

export interface TUIDispatcher {
  setDispatch(dispatch: React.Dispatch<TUIAction>): void;
  clearDispatch(dispatch: React.Dispatch<TUIAction>): void;
  addMessage(message: TUIMessage): void;
  appendToLast(text: string): void;
  setMessages(messages: readonly TUIMessage[]): void;
  openConversation(
    source: TUIMessageWindowSource,
    conversationId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  loadOlder(options?: { signal?: AbortSignal }): Promise<void>;
  loadNewer(options?: { signal?: AbortSignal }): Promise<void>;
  jumpTo(
    focus: TUIMessageWindowFocus,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  loadDetail(
    messageId: string,
    options?: { maxBytes?: number; signal?: AbortSignal },
  ): Promise<string | undefined>;
  exportVisibleWindow(): string;
  setThinking(thinking: boolean): void;
  setProgress(progress: TUIState['progress']): void;
  setPermission(permission: TUIState['permission']): void;
  setStatus(text: string): void;
  setMode(mode: TUIMode): void;
  getMessages(): TUIMessage[];
  getMode(): TUIMode;
  waitForPermission(permission: PermissionRequest): Promise<boolean>;
  resolvePermission(approved: boolean): void;
}

/** Imperative API to control TUI state from outside React */
export function createTUIDispatcher(options: TUIMessageWindowOptions = {}): TUIDispatcher {
  let _dispatch: React.Dispatch<TUIAction> | null = null;
  let _permissionResolve: ((value: boolean) => void) | null = null;
  const messageWindow = new TUIMessageWindowController(options);
  let _messages: readonly TUIMessage[] = [];
  let _mode: TUIMode = 'chat';
  let _thinking = false;
  let _progress: TUIState['progress'] = null;
  let _permission: TUIState['permission'] = null;
  let _statusText = 'Ready';

  messageWindow.subscribe(snapshot => {
    _messages = snapshot.messages;
    _dispatch?.({
      type: 'SET_WINDOW',
      messages: [...snapshot.messages],
      semanticAnchor: snapshot.semanticAnchor,
      hasMoreBefore: snapshot.hasMoreBefore,
      hasMoreAfter: snapshot.hasMoreAfter,
      pendingTailCount: snapshot.pendingTailCount,
      loadingPage: snapshot.loading,
      ...(snapshot.error === undefined ? {} : { windowError: snapshot.error.message }),
    });
  });
  function syncMode(m: TUIMode) {
    _mode = m;
  }

  return {
    setDispatch(d: React.Dispatch<TUIAction>) {
      _dispatch = d;
      const snapshot = messageWindow.getSnapshot();
      d({
        type: 'SET_WINDOW',
        messages: [...snapshot.messages],
        semanticAnchor: snapshot.semanticAnchor,
        hasMoreBefore: snapshot.hasMoreBefore,
        hasMoreAfter: snapshot.hasMoreAfter,
        pendingTailCount: snapshot.pendingTailCount,
        loadingPage: snapshot.loading,
        ...(snapshot.error === undefined ? {} : { windowError: snapshot.error.message }),
      });
      d({ type: 'SET_THINKING', thinking: _thinking });
      d({ type: 'SET_PROGRESS', progress: _progress });
      d({ type: 'SET_PERMISSION', permission: _permission });
      d({ type: 'SET_STATUS', text: _statusText });
      d({ type: 'SET_MODE', mode: _mode });
    },
    clearDispatch(d: React.Dispatch<TUIAction>) {
      if (_dispatch === d) _dispatch = null;
    },
    addMessage(message: TUIMessage) {
      messageWindow.appendTail(projectTUIMessageForDisplay(message));
    },
    appendToLast(text: string) {
      const last = _messages.at(-1);
      if (!last) return;
      const projection = projectDisplayText(last.content + text, TUI_MESSAGE_CONTENT_MAX_BYTES);
      messageWindow.replaceLast({
        ...last,
        content: projection.text,
        ...(projection.truncated
          ? {
            detail: {
              truncated: true,
              originalBytes: projection.originalBytes,
              ...(last.detail?.detailRef === undefined ? {} : { detailRef: last.detail.detailRef }),
            },
          }
          : {}),
      });
    },
    setMessages(messages: readonly TUIMessage[]) {
      messageWindow.setInitialMessages(messages);
    },
    openConversation(
      source: TUIMessageWindowSource,
      conversationId: string,
      options?: { signal?: AbortSignal },
    ) {
      return messageWindow.open(source, conversationId, options);
    },
    loadOlder(options?: { signal?: AbortSignal }) {
      return messageWindow.loadOlder(options);
    },
    loadNewer(options?: { signal?: AbortSignal }) {
      return messageWindow.loadNewer(options);
    },
    jumpTo(focus, options?: { signal?: AbortSignal }) {
      return messageWindow.jumpTo(focus, options);
    },
    loadDetail(messageId: string, options?: { maxBytes?: number; signal?: AbortSignal }) {
      return messageWindow.loadDetail(messageId, options);
    },
    exportVisibleWindow() {
      return messageWindow.exportVisibleWindow();
    },
    setThinking(t: boolean) {
      _thinking = t;
      _dispatch?.({ type: 'SET_THINKING', thinking: t });
    },
    setProgress(progress: TUIState['progress']) {
      _progress = progress;
      _dispatch?.({ type: 'SET_PROGRESS', progress });
    },
    setPermission(permission: TUIState['permission']) {
      _permission = permission;
      _dispatch?.({ type: 'SET_PERMISSION', permission });
    },
    setStatus(text: string) {
      _statusText = text;
      _dispatch?.({ type: 'SET_STATUS', text });
    },
    setMode(mode: TUIMode) {
      syncMode(mode);

      _dispatch?.({ type: 'SET_MODE', mode });
    },
    /** Get current messages snapshot (for /context, /cost, etc.) */
    getMessages(): TUIMessage[] {
      return [..._messages];
    },
    /** Get current mode */
    getMode(): TUIMode {
      return _mode;
    },
    /**
     * Show a permission dialog and wait for user response.
     * Returns true if approved, false if denied.
     */
    waitForPermission(permission: PermissionRequest): Promise<boolean> {
      return new Promise((resolve) => {
        _permissionResolve = resolve;
        _permission = permission;
        _dispatch?.({ type: 'SET_PERMISSION', permission });
      });
    },
    /** Call after onPermissionResponse to resolve the waiting promise */
    resolvePermission(approved: boolean) {
      if (_permissionResolve) {
        const resolve = _permissionResolve;
        _permissionResolve = null;
        resolve(approved);
      }
      _permission = null;
      _dispatch?.({ type: 'SET_PERMISSION', permission: null });
    },
  };
}
