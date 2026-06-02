/**
 * TUI App — MemeLoop 交互式终端界面 (Ink + React)
 *
 * 对标 Claude Code REPL: 消息流 + 输入框 + 权限确认 + 进度指示
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { ChatMessageList } from "./ChatMessageList.js";
import { PromptInput } from "./PromptInput.js";
import { PermissionDialog } from "./PermissionDialog.js";
import { StatusBar } from "./StatusBar.js";
import { ToolProgressIndicator } from "./ToolProgressIndicator.js";
import type { TUIMessage, TUIState, TUIAction, PermissionRequest } from "./types.js";

function reducer(state: TUIState, action: TUIAction): TUIState {
  switch (action.type) {
    case "ADD_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };
    case "SET_MESSAGES":
      return { ...state, messages: action.messages };
    case "APPEND_TO_LAST":
      if (state.messages.length === 0) return state;
      const msgs = [...state.messages];
      const last = { ...msgs[msgs.length - 1] };
      last.content += action.text;
      msgs[msgs.length - 1] = last;
      return { ...state, messages: msgs };
    case "SET_THINKING":
      return { ...state, thinking: action.thinking };
    case "SET_PROGRESS":
      return { ...state, progress: action.progress };
    case "SET_PERMISSION":
      return { ...state, permission: action.permission };
    case "SET_STATUS":
      return { ...state, statusText: action.text };
    case "SET_MODE":
      return { ...state, mode: action.mode };
    default:
      return state;
  }
}

const initialState: TUIState = {
  messages: [],
  thinking: false,
  progress: null,
  permission: null,
  statusText: "Ready",
  mode: "chat",
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
}

export function TUIApp({ onSubmit, onPermissionResponse, onExit, initialMessages }: TUIAppProps) {
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    messages: initialMessages ?? [],
  });
  const { exit } = useApp();
  const [inputValue, setInputValue] = useState("");

  // Expose dispatch for external use (via ref)
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const handleSubmit = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      const userMsg: TUIMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: text,
        timestamp: new Date(),
      };
      dispatch({ type: "ADD_MESSAGE", message: userMsg });
      dispatch({ type: "SET_THINKING", thinking: true });
      dispatch({ type: "SET_STATUS", text: "Thinking..." });
      setInputValue("");
      onSubmit(text);
    },
    [onSubmit],
  );

  const handlePermission = useCallback(
    (approved: boolean) => {
      if (state.permission) {
        onPermissionResponse(state.permission.id, approved);
        dispatch({ type: "SET_PERMISSION", permission: null });
      }
    },
    [state.permission, onPermissionResponse],
  );

  useInput((input, key) => {
    // Permission dialog key handling
    if (state.permission) {
      if (input === "y" || input === "Y") {
        handlePermission(true);
        return;
      }
      if (input === "n" || input === "N" || key.escape) {
        handlePermission(false);
        return;
      }
      if (input === "a" || input === "A") {
        // "Always allow" — treat as approve for now
        handlePermission(true);
        return;
      }
      return; // block all other keys while permission dialog is showing
    }

    if (key.ctrl && input === "c") {
      onExit();
      exit();
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar text={state.statusText} mode={state.mode} messageCount={state.messages.length} />
      <ChatMessageList messages={state.messages} thinking={state.thinking} />
      {state.progress && <ToolProgressIndicator progress={state.progress} />}
      {state.permission && (
        <PermissionDialog
          request={state.permission}
          onApprove={() => handlePermission(true)}
          onDeny={() => handlePermission(false)}
        />
      )}
      {!state.permission && (
        <PromptInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          disabled={state.thinking}
          placeholder={
            state.thinking
              ? "Waiting for response..."
              : "Type a message or /command..."
          }
        />
      )}
    </Box>
  );
}

/** Imperative API to control TUI state from outside React */
export function createTUIDispatcher() {
  let _dispatch: React.Dispatch<TUIAction> | null = null;
  let _permissionResolve: ((value: boolean) => void) | null = null;
  let _messages: TUIMessage[] = [];
  let _mode: TUIMode = "chat";

  // Keep in sync with reducer state via side-channel
  function syncMessages(msgs: TUIMessage[]) { _messages = msgs; }
  function syncMode(m: TUIMode) { _mode = m; }

  return {
    setDispatch(d: React.Dispatch<TUIAction>) {
      _dispatch = d;
    },
    addMessage(msg: TUIMessage) {
      _messages = [..._messages, msg];
      _dispatch?.({ type: "ADD_MESSAGE", message: msg });
    },
    appendToLast(text: string) {
      _dispatch?.({ type: "APPEND_TO_LAST", text });
    },
    setThinking(t: boolean) {
      _dispatch?.({ type: "SET_THINKING", thinking: t });
    },
    setProgress(progress: TUIState["progress"]) {
      _dispatch?.({ type: "SET_PROGRESS", progress });
    },
    setPermission(permission: TUIState["permission"]) {
      _dispatch?.({ type: "SET_PERMISSION", permission });
    },
    setStatus(text: string) {
      _dispatch?.({ type: "SET_STATUS", text });
    },
    setMode(mode: TUIMode) {
      syncMode(mode);
      _dispatch?.({ type: "SET_MODE", mode });
    },
    /** Get current messages snapshot (for /context, /cost, etc.) */
    getMessages(): TUIMessage[] {
      return _messages;
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
        _dispatch?.({ type: "SET_PERMISSION", permission });
      });
    },
    /** Call after onPermissionResponse to resolve the waiting promise */
    resolvePermission(approved: boolean) {
      if (_permissionResolve) {
        const resolve = _permissionResolve;
        _permissionResolve = null;
        resolve(approved);
      }
      _dispatch?.({ type: "SET_PERMISSION", permission: null });
    },
  };
}
