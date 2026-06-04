/**
 * 终端会话流式输出的 WebSocket JSON-RPC **notification** 方法名（非 request）。
 * 方案 v8 §16.4 文档中写作 `memeloop.terminal.subscribe`；实现统一为下列常量，避免客户端与服务端字符串漂移。
 */
export const MEMELOOP_TERMINAL_OUTPUT_NOTIFICATION = "memeloop.terminal.output.delta" as const;

export type MemeloopTerminalOutputNotificationMethod = typeof MEMELOOP_TERMINAL_OUTPUT_NOTIFICATION;
